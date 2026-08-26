# NamiMail Agent 改进问题确认清单

> 状态：**待确认**（PENDING）
> 依据：对 nami-mail-agent（v0.3.0）源码的深入通读（agent-core / agent-contracts / apps/server/agent / apps/desktop broker / apps/web）。
> 规则：每条给出证据与建议，全部确认后再按 Phase 实施；未确认项不进入编码。

## 结论摘要

- 已核实为**已存在、无需做**的点（防止重复建设）：确认次数单次消费与 payload hash、事务性 outbox、账户删除丢 DEK、引用重验、auto-reply 按日与按线程去重。
- 主要欠账集中在 **规模/性能**（内存索引、无 FTS、无持久向量）与 **可观测性**（无审计 UI、无全局并发控制），其次 **安全策略粒度**（full-access 豁免、配对生命周期）。

---

## Phase A — 安全边界（P1，建议最先做）

### A-1. full-access 对不可逆操作仍免确认 {#a1}
- **现状**：`permissions.ts:72-74` — `caller.accessLevel === "full-access"` 时跳过一切确认，包括 `accounts.delete`（永久删除账户）、`messages.send`（高危险）。
- **影响**：用户误开 full-access 后，恶意/误操作可无提示永久删除账户。
- **建议**：引入"irreversible"（不可逆）工具标记；full-access 只豁免普通写入确认，`accounts.delete` 等不可逆操作**始终**要求确认（桌面侧强制，`--yes` 不可绕过）。
- **影响面**：`agent-contracts/tool.ts`（descriptor 增加标记）、`agent-core/permissions.ts`、desktop broker 写路径、web 确认卡（无需改 UI，复用现有）。
- **工作量**：S | **风险**：低 | **测试**：单测 + broker 集成测试补充。

### A-2. 外部配对授权粒度与管理生命周期 {a2}
- **现状**：外部授权只有全局双档（`agentCliAccessLevel`/`agentMcpAccessLevel`，db.ts），配对记录 **accountIds 为创建时快照**（broker-state.mts 注释 fail-closed）；新增邮箱不在授权范围、不提示、需手工重新配对；未无到期/轮换。
- **建议**：
  1. GUI 检测"配对快照将于活跃邮箱变化"，在账户新增/删除后提示用户重新授权（一键重新配对）。
  2. 支持配对级账户子集授权（配时可选账户，默认全部）。
  3. 配对与 host/client 密钥轮换与过期策略（HR 优先），在被吊销时分布提示。
- **影响面**：desktop broker-state/绑定 UI、AgentService.pairing 账户快照、web 设置。
- **工作量**：M | **风险**：中（改权限语义须保默认拒绝）| **测试**：broker 状态测试 + 集成测试。

### A-3. 外部确认单模态、不可回头
- **现状**：外部 CLI/MCP 写入确认 = 主进程原生 `dialog.showMessageBox`（main.mts:251-285），无超时重试、无审计视图、无法回看"谁批准了什么"。
- **建议**：Phase C 合并到 **C-1 审计视图**；此处仅记录为依赖项，本 Phase 不单列。

---

## Phase B — 规模与性能（P1，高价值）

### B-1. 词法/语义索引全内存、无持久化
- **现状**：
  - 词法：`Map` 打分（agent-rag-worker.ts:290），搜索前 `warmAccount`（:963-977）对账户**全量解密重建**不持久栈。
  - 向量：`InMemorySemanticIndex`（retrieval.ts:146-191）重启即失，首搜重嵌所有。
- **建议（分期）**：
  1. 词法侧：把 `term → (pageId, count)` 倒排落到 SQLite 表（可直接 FTS5 或自建 score 表），索引 warm 改为**从表加载、删除可增量**；重启无全量解密。
  2. 向量侧：embedding 结果持久化（`agent_rag_embeddings` 按 page_revision 存储，恢复时校验 revision 与 embedding_model），model 变更仅重建失效部分，提供"重建进度"状态位。
  3. 打分升级为 BM25 或 BM25+向量 RRF（可保留现有启发式作为降级路径）。
- **影响**：演示引擎 agent-rag-worker / rag-page-store / retrieval / web rag-status；**原校验**：必须先验证 `table_page` 的删除同步与加密模型不覆盖。
- **工作量**：L（B-1.1 可拆） | **风险**：高（核心链路）| **测试**：1w/10w 消息基准，删除/重建生命周期测试，verify 报告回归。

### B-2. 检索候选过窄（可选合并到 B-1）
- **现状**：`allowedMessageIds` 精确、候选池 30（agent-rag-worker.ts:413-437）。
- **建议**：提供线程扩展 + 严格重验的模式（默认保守，配置可开），调高候选池到 100 并保持 post-filter。

---

## Phase C — 架构与可观测性（P2）

### C-1. 全局并发控制
- **现状**：`activeRuns` 仅防同一会话重入（agent-service.ts:1654），无全局信号；多会话并发打同一 provider 可能快速触发限流。
- **建议**：AgentService 注册层信号量（默认全局 2 会话？读-写队列），配合 provider 级节流；CLI/MCP confirm 路径不受影响（单次调用式）。
- **工作量**：S~M。

### C-2. agent-service.ts 拆分子服务
- **现状**：2650+ 行上帝类（provider/mcp/会话/确认/RAG 编排/翻译/自动回复）。
- **建议**：仅做**接口隔离**重构（ProviderService、ConversationService、ConfirmationService、McpBridge、RagBridge），不动行为、不动 API 形状；分两步走（先抽纯读/纯写 helper）。

### C-3. 审计可观测性（GUI 审计页）
- **现状**：审计是最好的实现（不可变 + 加密），但用户/调试者完全不可见。
- **建议**：`/api/agent/audit`（只读 + 分页 + 按入口/工具/最近时间过滤，只返回摘要不返回正文）；设置页入口「Agent 操作记录」。CLI `audit list` 验证（若有 CLI 通道）。
- **关联**：可直接用于 A-3。

### C-4. 跨机数据迁移（加密导出/导入）
- **现状**：全部加密绑 DPAPI masterKey + 机器；换机即不可读。
- **建议**：口令门控的导出格式（AES-256-GCM + Argon2id/Scrypt），导入走新建确认；范围至少含会话与 memory，RAG 可选重建。
- **风险**：中（密钥轮换业务迁移与旧 DPAPI 兼容）。

### C-5. 文档双份镜像漂移
- **现状**：`docs/**/*.{en,zh-CN}` 手工镜像。
- **建议**：CI 检查链接一致 / 标题差集；长期：单源（AsciiDoc/markdown-include）生成双语。

---

## Phase D — 产品/体验增强（P3，可选）

### D-1. auto-reply 可见性与按发件人窗口（可选）
- **现状**：已有按日上限 `sentToday`（:471-478）与按线程 `recentThreadSent`（:480-487）；缺"按发件人"窗口（陌生发件人群发多封会各触发一次评估）。
- **建议**：`auto_reply_processed` 增加发件人汇总（按发件人 N 小时窗口）与界面"今日已自动回复 N/上限"。

### D-2. MEMORY_SUGGEST 结构化通道
- **现状**：`MEMORY_SUGGEST:` 文本标记 + 剥离（agent-service.ts:2083-2116）；模型可能改写标记导致泄漏/丢片（system prompt 声明不得跨轮）。
- **建议**：保留文本降级通道 + 增加 `memory_tool`（tool call）主通道；手术式、行为不变。

### D-3. 长任务进度（可选）
- **现状**：长任务仅有工具卡，无整体预估。
- **建议**：在确认卡与工具卡之上加轻量阶段条（RAG→模型→工具循环→完成），不阻塞流。

---

## 实施顺序（提案）

| 阶段 | 内容 | 预计 |
| --- | --- | --- |
| **A** | A-1（不可逆强制确认）→ A-2（配对生命周期） | 安全优先 |
| **B** | ~~B-1.1 词法索引持久化~~（已完成，2026-08-12）→ C-1 全局并发 → B-1.2 向量持久化/重建进度 | 性能 |
| **C** | C-2 拆服务 + C-3 审计页/API + C-4 导出导入 | 工程 |
| **D** | D-1/D-2/D-3（可选） | 体验 |

每一阶段：计划（无代码）→ 实施 → 单测+集成测试+smoke → 你确认 → 下一阶段。全程不 push、不改远程。

## 需要你确认的问题

1. **范围**：全部实施？还是先 A + B-1.1 + C-3？
2. **A-1 语义**：不可逆 = 仅 `accounts.delete`，还是也包括 `send-mail`、`delete-draft`（草稿删除）、批量移动？（我建议：账户删除必确认；发送保持"全权说话"但需实现显式警告弹窗，见 docs）
3. **B-1 三七分**：FTS5 vs 自建倒排表 + BM25 —— 我推荐**自建倒排表 + BM25**（无插件依赖、加密字段不动、现有紧前后移）。
4. **C-3 受众**：审计页仅桌面 GUI vs 同时 CLI `namimail audit list`。
5. **C-4 导出**：本期是否做（工作量最大）。