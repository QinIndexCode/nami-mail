# RAG 词法索引持久化（B-1.1）实施计划与进度

> 交接文档（供更换编码 Agent 后续推进）。创建：2026-08-09
> 项目根：`d:\MyCode\nami-workspace\nami-mail-agent`（pnpm workspace）
> 前置文档：`docs/development/agent-improvement.plan.zh-CN.md`（Phase B-1.1）、`docs/rag/*`

---

## 1. 目标（Phase B-1.1）

1. **词法索引落盘**：把 `term → page 倒排` 写入 Agent store（SQLite），重启后 **不再全量解密重建**（现状：`agent-rag-worker.ts` `warmAccount` L966-979 对账户全量 `pageStore.get` 解密）。
2. **查询路径改为 SQL 驱动**：候选生成从"遍历内存 Map 全量打分"改为"按查询词取 postings → BM25 打分 → 仅对 top 候选解密 payload"（内存占用从 O(全部邮件) 降为 O(top)）。
3. **打分升级 BM25**（自建倒排表 + BM25，采纳 plan Q3 推荐：无 FTS 依赖、正文仍只存加密、现有紧前后移），保留现有启发式 `scorePage` 作为**回归基准**（不进运行时降级路径）。
4. **失败关闭不变**：索引表错误按 store 惯例抛错（不静默回退全量内存扫描）；账户删除/世代推进/DEK 撤销时索引行随 `agent_rag_pages` 同路径清除。

**不在本期**：B-1.2（向量持久化/重建进度）、C-1（全局并发）、BM25 打分参数调优。

---

## 2. 现状（勘察结论，2026-08-09）

| 项 | 现状 | 位置 |
|---|---|---|
| 词法索引 | `this.index = Map<string, IndexedPage>`，warm 时全量解密 | `apps/server/src/agent-rag-worker.ts` L290 / L966-979 |
| 打分 | `scorePage` 启发式（include 匹配 + subject×1.25 + 语义重叠项） | 同文件 L230-242 |
| 候选池 | `limit*4` 取 30，逐候选 `citations.revalidate`，消息级去重 | 同文件 L413-438 |
| 语义索引 | `InMemorySemanticIndex`（纯内存），`setEmbedding` 变化时全量重嵌 | `apps/server/src/agent/retrieval.ts` L145-191、worker L320-334 |
| 页面存储 | `agent_rag_pages` 全加密（账户 DEK，fail-closed），schema v4 | `apps/server/src/agent/rag-page-store.ts`、`schema.ts` |
| 删除路径 | `account-deleted`/`generation-advanced` → 删 `agent_rag_pages`；purge 物理回收 | worker L855-864、rag-page-store `purgeTombstoned` |
| 校验 | `verify()` 统计 `index.entries` / `entriesWithoutReadablePage`（基于内存 Map） | worker L537-692 |
| Web | **无** rag-status 面板（grep 无结果）→ 本期不改 web | — |

**关键安全事实**：`agent_rag_pages.encrypted_payload` 用账户 DEK 加密；正文明文只允许出现在内存。倒排表将只存**分词 token + tf 计数 + 页级元数据**（无正文片段），删除路径与页面表严格一致。

---

## 3. 设计决策（已定，实施时不得擅自更改）

### 3.1 表结构（Agent store schema v5）

```sql
CREATE TABLE IF NOT EXISTS agent_rag_index (
  account_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL CHECK (account_generation >= 0),
  page_id TEXT NOT NULL,
  page_revision INTEGER NOT NULL CHECK (page_revision >= 1),
  term TEXT NOT NULL,
  tf_subject INTEGER NOT NULL CHECK (tf_subject >= 0),
  tf_sender INTEGER NOT NULL CHECK (tf_sender >= 0),
  tf_body INTEGER NOT NULL CHECK (tf_body >= 0),
  term_count INTEGER NOT NULL CHECK (term_count >= 0),  -- 整页词数（dl，BM25 分母）
  sent_at TEXT,                                          -- 元数据明文（用于 recencyBoost）
  PRIMARY KEY (account_id, account_generation, page_id, page_revision, term)
);
CREATE INDEX IF NOT EXISTS idx_agent_rag_index_term
  ON agent_rag_index(term, account_id, account_generation);
CREATE INDEX IF NOT EXISTS idx_agent_rag_index_page
  ON agent_rag_index(account_id, account_generation, page_id, page_revision);

CREATE TABLE IF NOT EXISTS agent_rag_index_stats (
  account_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL CHECK (account_generation >= 0),
  doc_count INTEGER NOT NULL CHECK (doc_count >= 0),
  term_total INTEGER NOT NULL CHECK (term_total >= 0),
  PRIMARY KEY (account_id, account_generation)
);
```

- `tf_*` 按字段拆列，实现 subject/sender 权重（BM25 effective_tf 加权，见 3.3），无需在内存里持有 payload 字符串。
- 每账户世代一行 stats（`doc_count=N`、`term_total=Σdl` → `avgdl`），查询时 O(1) 取，避免每查询 COUNT/SUM 全表。
- 分词逻辑复用现有 `searchTerms`（worker L169-173；单字符 CJK 单独成词、词长≥2、上限 32 不变）。**注意**：token 用 `toLocaleLowerCase()` 后存盘，属派生数据，非正文原文。

### 3.2 写入路径（事务与崩溃一致性）

- **upsertMessage**：`pageStore.put(...)` 返回后，在同一 db 事务内 `INSERT OR REPLACE` 该页索引行 + upsert stats（先删旧行再插）。页面表仍是权威；索引是派生缓存。
- **崩溃一致性**：`put` 与索引写不在同一事务（pageStore 自管事务）。若崩溃于两者之间 → 该页无索引行 → `warmAccount` 的**增量补齐**兜底（见 3.4）。与现有"store 为权威、索引可重建"哲学一致。
- **removeIndex / tombstone / purge / lifecycle delete**：四处删除路径必须同步删索引行 + 更新 stats：
  - `removeIndex`（页级删除，worker L1016-1031）；
  - `tombstoneMessagePages`（worker L936-943）；
  - `processLifecycleEvent` 的 `account-deleted`/`generation-advanced`（worker L855-864，与 `agent_rag_pages` 同一 DELETE 分支）；
  - `purgeTombstoned` 之后（purge 前收集被删 page_id 列表 → 删除对应索引行 + 重算 stats）。

### 3.3 查询路径（SQL BM25）

- **候选生成**（替换 L413-418 / `lexicalCandidates` L480-503）：
  1. 对每个查询 term 每个账号：`SELECT page_id, tf_subject, tf_sender, tf_body, term_count, sent_at FROM agent_rag_index WHERE term = ? AND account_id = ? AND account_generation = ?`（rows.length = df，走 `idx_agent_rag_index_term`）；
  2. 聚合到页：`effective_tf = tf_body + 1.5*tf_subject + 1.1*tf_sender`（对齐现有 subject 权重 1.25 的量级）；
  3. 逐账号 BM25：`score = Σ idf * effective_tf*(k1+1) / (effective_tf + k1*(1 - b + b*dl/avgdl))`，`idf = ln(1 + (N - df + 0.5)/(df + 0.5))`，`k1=1.2`、`b=0.75`，`dl=term_count`，`N/avgdl` 来自 stats；末尾乘 `(1 + recencyBoost(sent_at))` 保持现有近因偏好（worker L247-252）；
  4. 合并账号候选池 → 统一排序 → 取 `max(1, min(30, limit*4))`。
- **top 解密**：仅对候选池（≤30）`pageStore.get` 解密 payload → 走现有 `asCitation` → `citations.revalidate` → 消息级去重（L421-437 流程不变）。
- **hybrid 路径**（L446-478）：语义候选 id 解析 `this.index.get(result.id)` 改为对合并结果（≤limit）逐条 `pageStore.get` 取 payload/content；`InMemorySemanticIndex` 本体不动。
- **内存 Map 移除**：`this.index` 不再承担查询职责。`IndexedPage` 仅保留为语义嵌入（`scheduleSemanticIndex`/`pumpSemantic`/`setEmbedding` 重嵌循环 L333）的临时结构——重嵌仍走"索引表 distinct 页 → 解密 → 入队 embed"（仅 embedding 变化时全量，语义路径可接受）。
- **保留 `scorePage` 启发式**：仅用于回归断言与基准对照（导出为纯函数便于单测），不进运行时。

### 3.4 warmAccount（增量补齐，替代全量解密）

- 读索引表 `SELECT DISTINCT page_id, page_revision FROM agent_rag_index WHERE account_id=? AND account_generation=?`；
- 与 `pageStore.listMetadata`（仅元数据，零解密）对比 → 差集 = 缺失页 → 仅对缺失页解密 + 重建索引行；
- `purgeTombstoned` + 索引行清理逻辑保留（`purgedGenerations` 幂等语义不变）。

### 3.5 verify() 与 schema 版本

- `verify()`：`index.entries` = `SELECT COUNT(DISTINCT page_id)`（索引表）；`entriesWithoutReadablePage` = 逐 distinct 页 `pageStore.get` 失败计数（verify 是只读维护检查，可解密）。
- `AGENT_STORE_SCHEMA_VERSION` 与 `AGENT_STORE_MINIMUM_READER_VERSION` **4 → 5**；`agentStoreSchemaSql` 追加两表；`agentTableNames` 追加；`assertCurrentSchemaShape` 增加 `requireColumns(agent_rag_index, [...])` + stats 表主键形状校验；新增 `migrateAgentStoreV4ToV5`（幂等：表存在则校验列，否则 `CREATE TABLE IF NOT EXISTS`）；`applyAgentStoreSchema` 分支加 `schema_version === 4`。
- **回滚**：v5 表纯增量、无数据迁移（索引行从加密页渐进重建）；发布后旧 Runtime 按现有规则拒绝 v5 库（min reader 5），不可降级（与 v3→v4 行为一致）。

---

## 4. 实施步骤（顺序执行，每步可独立验证）

| 步 | 内容 | 验证 |
|---|---|---|
| S1 | schema v5：两表 + 版本号 + 迁移 + shape 断言 + `agentTableNames` | `agent-store.test.ts` 迁移用例更新（现有断言版本 4 的同步改 5），新表幂等用例 |
| S2 | 新增 `apps/server/src/agent/rag-index.ts`：`SqliteRagIndex`（写：replacePage/removePage/removeGeneration/onPurge；读：postingsFor/accountStats）+ 纯函数 `bm25Score`/`aggregatePageTf` | 新单测 `tests/rag-index.test.ts`（tf 聚合、BM25 排序、stats 维护） |
| S3 | worker 写入路径接线：upsert/remove/tombstone/lifecycle/purge 全删改 + 增量 warmAccount | `agent-rag-backfill/verify/semantic` 现有用例全过 |
| S4 | 查询路径改造：SQL BM25 候选 + top 解密 + hybrid 修正 + 移除内存 Map 查询依赖 | `agent-service-rag`、`agent-retrieval-citations`、`agent-rag-semantic` 全过 |
| S5 | verify() 改造 + 重启持久化回归测试（同 db 双 worker 实例，第二次零全量解密搜索） | 新增 `tests/rag-persistence.test.ts` |
| S6 | 全量回归 + 基准 + 文档（docs/rag/architecture 双语同步："process-local index" → 持久化倒排表说明；`agent-improvement.plan` 状态更新） | 见 §6 |

---

## 5. 测试与基准

- **回归**：`apps/server` 全量 vitest 必须全绿（现有 RAG 相关 5 个测试文件用例的行为断言不允许放宽，除非打分升级本身改变了排序——此时更新断言并说明）。
- **新增**：
  1. `tests/rag-index.test.ts`：BM25 数学正确性（构造已知 df/tf/avgdl 断言相对排序）、字段权重、stats 维护（增删改）。
  2. `tests/rag-persistence.test.ts`：同 db 两个 worker 实例（第一个 stop 后）→ 第二个 search 结果一致；索引表行数 = 活跃页数；删除/世代推进后索引行清零；purge 后索引行同步清理。
  3. 迁移用例：v4→v5 幂等、shape 断言触发。
- **基准**（手动跑，不进 CI）：`bench/rag-bench.mjs` 注入 1 万条合成消息 → 冷启动（无索引表，需全量解密）vs 热启动（有索引表）`search` 首查耗时与内存对比，数字记入本文档 §7。10 万条可选（时间成本高）。

---

## 6. 验证命令

```powershell
cd apps/server
npm run typecheck
npx vitest run tests/rag-index.test.ts tests/rag-persistence.test.ts   # 新增
npx vitest run tests/agent-rag-*.test.ts tests/agent-service-rag.test.ts tests/agent-store.test.ts tests/agent-retrieval-citations.test.ts
npm run test          # 全量回归
node bench/rag-bench.mjs   # 基准（手动）
```

---

## 7. 风险与注意

1. **搜索行为变化**：BM25 排序 ≠ 旧启发式，个别查询 top 结果可能变化。缓解：保留 `scorePage` 作对照；语义/词法融合（hybrid）路径占比不变。
2. **索引行膨胀**：token 行数 ≈ 页词数，10w 邮件可能数百万行。缓解：token 按页去重（现有 `searchTerms` 已 `Set` 去重）、PRIMARY KEY 压缩、purge 及时回收；基准验证实际体积。
3. **stats 漂移**：任何写路径漏更 stats 会导致 avgdl/df 失真（排序劣化不崩溃）。缓解：stats 重算收敛——`warmAccount` 每账号世代校验 `doc_count` = 索引表 distinct 页数，不符则整账号重建。
4. **DEK 撤销即停**：索引行不加密，但删除路径必须与页面表同事务触发顺序（lifecycle 事件先删页后删索引，幂等）。

---

## 8. 后续阶段（不在本期）

- **C-1** 全局并发控制（AgentService 信号量）——按实施顺序表在 B-1.2 之前。
- **B-1.2** 向量持久化：`agent_rag_embeddings`（按 page_revision + embedding_model 校验），模型变更仅重建失效部分 + 重建进度状态位。
- **B-2** 候选池扩大与线程扩展（可选，合并进 B-1.2 评估）。
