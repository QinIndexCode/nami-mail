# Nami Mail — Agent 自动回复 + 长期记忆 实施计划与进度

> 交接文档（供更换编码 Agent 后续推进）。最后更新：2026-08-08
> 项目根：`d:\MyCode\nami-workspace\nami-mail-agent`（pnpm workspace：`packages/agent-contracts`、`apps/server`、`apps/web`、`apps/desktop`）

---

## 1. 任务目标

1. **Agent 主动回复邮件**：用户单独授权（勾选邮箱范围、可随时撤销），新邮件到达后由系统初筛 → Agent 评估（含回复价值估量）→ 确认弹窗 → 发送。
2. **Agent 长期记忆**：Agent 记得自己发过/回复过什么邮件、日历做过什么；用户可直接查看/编辑；Agent 需**主动回忆**（每轮对话前检索相关记忆注入上下文），避免用户问起时显得"笨"。

## 2. 已确认设计决策（用户确认，不得擅自变更）

### 2.1 自动回复
| 项 | 决策 |
|---|---|
| 触发方式 | **用户主动启用**，默认关闭（`enabled: false`）；启用时 Web UI 必须弹窗**明确告知风险**，用户确认后才开启 |
| 邮箱范围 | 用户勾选决定（仿账户管理列表勾选），可随时撤销（关闭开关即停） |
| 回复发送 | **一律弹窗确认后发送**（`requireConfirmation` 固定 `true`，契约用 `z.literal(true)`） |
| 系统初筛 | **完整初筛**（零 LLM）：`\Junk` 文件夹、`Auto-Submitted`（防循环）、`List-Unsubscribe` / `Precedence: bulk`（营销）、Gmail `X-GM-LABELS`（CATEGORY_PROMOTIONS/SOCIAL/UPDATES）、会话去重台账 |
| 敏感判定 | **词库 + Agent 复核**：敏感邮件走**最高层级弹窗**（无论处于哪个界面；应用内右下角弹窗 + 系统通知，取决于用户设置） |
| 回复价值 | Agent 必须估量回复价值——提示/广告/营销类邮件回复价值不大，**低价值直接忽略**（写记忆 `auto-reply-ignored`） |
| 非敏感可回复 | Agent 起草回复 → 普通确认弹窗 → 确认后发送 |
| 护栏 | 隐私授权（仅在允许时）、**每账户每日上限**（`dailyLimitPerAccount`，默认 30）、仅纯文本回复、不回复退信/自动消息、审计日志、撤销即停 |
| 操作记录 | 自动回复属 Agent 操作，写审计（不可变）+ 写记忆（可删/可编辑） |

### 2.2 Agent 记忆
| 项 | 决策 |
|---|---|
| 分层 | **审计**（不可变，现有 `EncryptedAgentAuditStore`）与**记忆**（可删、可编辑摘要、仅回忆用）分开 |
| 用户入口 | 用户可直接**查看和编辑**记忆（Agent 界面「记忆」管理面板：查看/搜索/筛选/编辑摘要/删除/清空） |
| 主动回忆 | Agent 每轮对话前检索相关记忆注入上下文（参考 Codex CLI remembers 机制）；操作完成后主动沉淀记忆 |
| 加密 | 记忆用**根信封**（masterKey，不绑账户 DEK），账户删除不影响记忆可读性；`account_id` 仅作明文元数据列 |

## 3. 当前进度

| ID | 任务 | 状态 | 备注 |
|---|---|---|---|
| a1 | 契约 schema + 服务端设置接线 | ✅ 完成 | typecheck 通过 |
| a2 | 服务端 Agent 记忆存储 | ✅ 完成 | 测试 7/7 通过 |
| a3 | 自动回复管线（初筛→评估→确认→发送→审计+记忆） | ✅ 完成 | 引擎 + 初筛 + evaluate + 确认桥接均已落地（详见 §4.3） |
| a4 | 自动回复/记忆 API | ✅ 完成 | settings 已带 autoReply；记忆 API 路由已挂载 |
| a5 | Web 设置 UI（启用风险确认弹窗） | ✅ 完成 | SettingsModal 开关/账户勾选/每日上限 + AutoReplyPendingDialog 确认弹窗 |
| a6 | Agent「记忆」面板 + 主动回忆注入 | ✅ 完成 | 记忆管理面板 + 对话前回忆注入（evaluate 输入 memoryContext） |
| a7 | 测试 + typecheck + 构建 + 复验 | ✅ 完成 | 全量 500/500（新增 22 个自动回复用例），typecheck/lint 通过 |

---

## 4. 已完成实现明细（接续 Agent 必读）

### 4.1 a1 — 契约与服务端设置（已完成）

- **[auto-reply.ts](../packages/agent-contracts/src/auto-reply.ts)**（新建）：`autoReplyConfigSchema`（`enabled/accountIds/requireConfirmation:true/dailyLimitPerAccount(默认30)`，strict）、`autoReplyConfigPatchSchema`、`agentMemoryKinds`（`auto-reply-sent | auto-reply-ignored | email-sent | calendar-created | calendar-updated | calendar-deleted | note`）、`agentMemoryRecordSchema`（id/kind/accountId?/summary(≤500)/detail(≤2000,默认"")/occurredAt/createdAt，strict）、`agentMemoryPatchSchema`（仅 summary）。
- **`src/index.ts`**：已 `export * from "./auto-reply.js"`。**注意**：改契约后必须 `cd packages/agent-contracts && npm run build`（exports 指向 dist），否则 server/web 的 file: 依赖报 `no exported member`。
- **[db.ts](../apps/server/src/db.ts)**：`app_settings` 表加 `auto_reply_config TEXT`（`CREATE TABLE` 内 + `migrateDatabase` 的 `ALTER TABLE` 段，settingsColumns 检测）。
- **[settings.ts](../apps/server/src/settings.ts)**：`DEFAULT_AUTO_REPLY`、`AppSettings.autoReply`、`SettingsRow.auto_reply_config`、`parseAutoReplyConfig`（schema safeParse 失败回退默认）、`updateAppSettings` 写 `auto_reply_config` JSON 列。
- **[app.ts](../apps/server/src/app.ts)**：顶部 `import { autoReplyConfigPatchSchema } from "@nami/agent-contracts"`；`settingsPatchSchema` 加 `autoReply: autoReplyConfigPatchSchema.optional()`；`publicSettings` 加 `autoReply: settings.autoReply`（GET/PATCH `/api/settings` 均走 publicSettings）。

### 4.2 a2 — Agent 记忆存储（已完成）

- **[schema.ts](../apps/server/src/agent/schema.ts)**：`AGENT_STORE_SCHEMA_VERSION` 与 `AGENT_STORE_MINIMUM_READER_VERSION` **3 → 4**；`agentStoreSchemaSql` 末尾新增 `agent_memory_records` 表（record_id PK、record_kind CHECK 枚举、account_id NULL、encrypted_payload、crypto_version、occurred_at、created_at、updated_at）+ `idx_agent_memory_occurred/kind` 索引；`agentTableNames` 加 `agent_memory_records`；`assertCurrentSchemaShape` 加 `requireColumns`；新增 `migrateAgentStoreV3ToV4`（幂等建表），`applyAgentStoreSchema` 分支加 `row.schema_version === 3`。
- **[memory.ts](../apps/server/src/agent/memory.ts)**（新建）：`EncryptedAgentMemoryStore(db, masterKey, clock)`：
  - 加密：root envelope（`encryptRootAgentRecord(masterKey, "agent-memory", recordId, plaintext)` 包 `nami-agent-root-envelope-v1`），**不依赖 AccountLifecycleStore**。
  - API：`create(input)`（id/createdAt 服务端生成；**accountId 必须条件包含**——`...(input.accountId !== undefined ? {accountId} : {})`，否则 `undefined` 进 canonicalAgentJson 抛 "unsupported value"）、`list({kind, accountId, query, limit})`（解密后内存过滤，解码失败跳过）、`get(id)`、`patchSummary(id, summary)`、`delete(id)`、`clear()`。
  - `MEMORY_MAX_RECORDS = 500`，insert 后 `trimToLimit()` 按 `occurred_at ASC` 删最旧。
- **[tests/agent-memory.test.ts](../apps/server/tests/agent-memory.test.ts)**（新建）：7 个用例，`npx vitest run tests/agent-memory.test.ts` 全过。

---

## 4.3 自动回复管线与缺陷修复（a3–a7，已完成）

**管线组件**（均为既有代码，本阶段补测试 + 修复缺陷）：

- **[auto-reply.ts](../apps/server/src/agent/auto-reply.ts)**：`AutoReplyEngine`（初筛→评估→确认→发送→审计+记忆），模块级注册（`registerAutoReplyEngine`），runtime 在 `desktopConfirmation` 存在时构建。
- **[auto-reply-screening.ts](../apps/server/src/agent/auto-reply-screening.ts)**：离线零 LLM 初筛（垃圾文件夹/Auto-Submitted/营销头/Gmail 分类/无发件人/退信/会话去重）+ 敏感词扫描。
- **[agent-service.ts](../apps/server/src/agent-service.ts)**：`evaluateAutoReply`（非流式单次调用 + `parseAutoReplyEvaluation` 防御性解析）。
- **[app.ts](../apps/server/src/app.ts)**：`GET /api/agent/auto-reply/pending`、`POST /api/agent/auto-reply/resolve`、`GET /api/agent/memory` 等路由。
- **Web**：SettingsModal 自动回复开关/账户/每日上限 + `AutoReplyPendingDialog` 确认弹窗（electron 桥 → IPC → main 验证 → runtime）。

**本阶段修复的 4 个缺陷**（均有回归测试，见 §5 备注）：

1. **确认决策被拒**：引擎 `resolveConfirmation`/`recordExpired` 用 kind=`service` 的 `autoReplyCaller` 调 `recordDecision`，`trustedDesktop` 要求 `desktop-ui + interactive` → 弹窗批准/拒绝恒返回 `failed`。修复：决策记录改用 `autoReplyDesktopCaller`（desktop-ui，可信链与会话路径 `pending.caller` 同源）。
2. **设置开关 400**：`autoReplyConfigPatchSchema`（strict）拒绝 UI 整体 spread（含 `requireConfirmation: true`）。修复：patch schema 接受 `requireConfirmation: z.literal(true).optional()`。
3. **配置静默丢失**：`updateAppSettings` 整体替换 `autoReply` 对象 → `requireConfirmation` 丢失 → `parseAutoReplyConfig` 回退默认（禁用）。修复：合并 patch 到当前配置。
4. **退信分支死代码**：screening 的 bounce 分支要求 `fromAddress` 为空，但 no-sender 分支已先返回 → 不可达。修复：`Return-Path: <>` 单独即判退信。

**新增测试**：`tests/auto-reply.test.ts`（引擎 9 例：批准发送/拒绝/低价值/初筛忽略/每日上限/线程去重/敏感预览/未知 id/TTL 过期）、`tests/auto-reply-screening.test.ts`（10 例）、`tests/settings.test.ts`（+2 例回归）。全量 500/500 通过。

**注意**：改 `packages/agent-contracts` 后必须 `cd packages/agent-contracts && npm run build`（exports 指向 dist）。

---

## 5. 待办实施要点

### a3 自动回复管线（核心，工作量大）

**挂接点**：`syncAccount`（[sync.ts](../apps/server/src/sync.ts#L246)）同步完成、入库新消息后。参考 `applyFilterRulesToNewMessages`（L1077）的增量思路（先查"本次同步新增"）。

**步骤**：
1. **增量发现**：同步后对勾选账户（`autoReply.accountIds`）筛选本次新到达的 Inbox 消息（不含已处理台账；可复用 `agent_source_events` 或独立台账表/内存 Set，需持久化防重复）。
2. **系统初筛**（离线零 LLM，新文件如 `auto-reply-screening.ts`）：
   - 消息位于 `\Junk`/垃圾文件夹 → 忽略；
   - `Auto-Submitted` 头存在（防回复循环）→ 忽略；
   - `List-Unsubscribe` 或 `Precedence: bulk` → 营销，忽略（或低价值）；
   - Gmail `X-GM-LABELS` 含 CATEGORY_PROMOTIONS/SOCIAL/UPDATES → 忽略；
   - 无 `In-Reply-To`（非会话回复）但**发送方是自建会话的续聊** → 会话去重；
   - 结果：`keep` / `ignore`（含原因），ignore 写记忆 `auto-reply-ignored`。
3. **Agent 评估**（`AgentService` 内部复用现有 provider 调用）：输入 = 邮件内容（subject/from/body 摘要）+ 已确认的初筛结果；输出结构化：`{ replyValue: "high"|"low", sensitive: boolean, replyText?: string }`：
   - 低价值（提示/广告/营销）→ 忽略，写记忆 `auto-reply-ignored`；
   - 敏感（词库命中 + Agent 确认）→ 走**最高层级弹窗**（复用 `agentConfirmationActions` 的 `send-mail` 或新增 action；确认 UI 需横跨所有界面，应用内右下角 + 系统通知按用户设置）；
   - 非敏感 → Agent 起草纯文本回复 → 普通确认弹窗。
4. **确认**：复用 [confirmations.ts](../apps/server/src/agent/confirmations.ts) 的 confirmation records 机制（`requested/confirmed/rejected/consumed/expired`）与契约 `confirmationRequestSchema`。
5. **发送**：确认后复用 `executionAccountIds` 解析（[agent-service.ts](../apps/server/src/agent-service.ts#L1191-L1212)）与 outbox/`sendMail` 管线（`apps/server/src/mail.js`），仅纯文本。
6. **记账**：每账户每日发送计数（`dailyLimitPerAccount` 默认 30；独立表或 `app_settings` 内存态），超限跳过。
7. **审计 + 记忆**：发送/忽略写 `EncryptedAgentAuditStore`（不可变）+ `EncryptedAgentMemoryStore.create`（`auto-reply-sent`/`auto-reply-ignored`，summary 中文描述）。
8. **撤销**：开关 `enabled=false` 时立即停止新一轮处理；已发送不可撤销（记录在案）。

**护栏**：隐私授权（`allowCloudMailContent` 检查）、不回复退信（`Return-Path: <>` / `From` 为空）、不回复 `Auto-Submitted`、纯文本。

### a4 API

- `GET/PATCH /api/settings` 已带 `autoReply`（publicSettings 已暴露）——Web UI 直接可用。
- 新增记忆 API（在 [app.ts](../apps/server/src/app.ts) 挂路由，注入 `EncryptedAgentMemoryStore` 实例）：
  - `GET /api/agent/memory?kind=&accountId=&query=&limit=` → `{ items }`（契约 `agentMemoryRecordSchema` 输出）；
  - `PATCH /api/agent/memory/:id`（body `{ summary }`）；
  - `DELETE /api/agent/memory/:id`；
  - `DELETE /api/agent/memory`（清空）。
  - 权限：桌面 UI 调用，参照现有 agent 路由守卫（不越权、校验）。

### a5 Web 设置 UI（注意 UI 审美）

- 位置：`AgentWorkspace.tsx` 或设置弹窗内新增「自动回复」区块（参考现有设置项样式）。
- 要素：
  1. **开关（默认关闭）**：开启时弹**风险确认弹窗**（文案：自动回复将代表你向所选邮箱的来信人发送邮件，仅在你确认后发送；可随时撤销；内容可能包含你联系人信息等）→ 确认后才 `enabled=true`；直接 PATCH `autoReply`。
  2. **邮箱勾选范围**：仿账户管理列表勾选（参照 `accountScope.selected` 的交互/`AccountsDialog`），保存 `accountIds`。
  3. **每日上限**：数字输入（默认 30，1–500）。
- **i18n 双文件同步**（关键教训）：`locales/zh-CN.json`（baseline）与 `en-US.json` 必须同时加键；UI 引用新键必须同步补两文件 + `styles.css`，仅 dev server 能看 ≠ 打包产物完整。
- **z-index 生态**：`.modal-backdrop`=30 / `.settings-backdrop`=45 / `.management-backdrop`=45 / `.confirmation-backdrop`=60 / `.settings-alert-backdrop`=70 / `.update-prompt-backdrop`=90；嵌套弹窗必须显式提级（如 `.calendar-editor-backdrop { z-index: 60; background: var(--scrim-nested); }`）。

### a6 Agent「记忆」面板 + 主动回忆

- 面板（Agent 界面新增 Tab/区块，仿管理列表模式：>5 条才显示工具栏/搜索/分页/批量删除）：
  - 列表：kind 标签、summary、occurredAt、accountId；行内「编辑摘要」「删除」；顶部「清空全部」（二次确认弹窗复用 `confirmation-card`）。
  - kind 显示中文（zh-CN）/英文（en-US），i18n 键。
- **主动回忆注入**：`AgentService` 会话上下文构建处（agent-service.ts 构建 system prompt / context 处）在每轮前调用 `memory.list({ query: <用户消息关键词>, limit: 8 })` 注入"历史记忆"段落；操作完成后（发邮件/日历工具成功后）自动 `memory.create(...)` 沉淀。参考 Codex CLI remembers：记忆以"我曾经做过 X"第一人称表述。

### a7 验证

- 命令见 §6；浏览器复验：启用风险弹窗、勾选范围、开关状态持久化、记忆面板 CRUD、i18n 无原始键、样式无塌陷。

---

## 6. 验证命令

```powershell
# 契约（改契约后必须 build，file: 依赖指向 dist）
cd packages/agent-contracts; npm run build; npm run typecheck; npm test

# 服务端
cd apps/server
npm run typecheck
npm run test          # 全量（约 200+ 用例）；单文件：npx vitest run tests/<name>.test.ts

# Web
cd apps/web
npm run typecheck
npm run test          # vitest
npm run build         # 生产构建（验证打包产物含 i18n/CSS）
```

## 7. 关键工程约束 / 教训（务必遵守）

1. **改 `@nami/agent-contracts` 后必须 rebuild**，否则下游报 `no exported member`。
2. **i18n**：zh-CN.json（baseline）+ en-US.json 同步加键；`translate()` 只在 zh-CN 缺键时回退原始键。
3. **z-index**：嵌套弹窗显式提级，scrim 用 `--scrim-nested`。
4. **加密模式**：审计/会话用账户信封（fail-closed）；**记忆用根信封**（不绑账户 DEK）。`canonicalAgentJson` 不接受 `undefined` 字段——组装对象时条件包含可选键。
5. **schema 版本**：改 agent store 结构需 `AGENT_STORE_SCHEMA_VERSION` + 幂等迁移函数 + `assertCurrentSchemaShape` 同步。
6. **权限三层**：工具 descriptor 分类（read/write）→ `PermissionEngine` 按 caller accessLevel/scopes 评估 → `executionAccountIds` 执行账户解析；自动回复确认复用 `send-mail` action。
7. **流式/后台任务**：监听客户端断开与 shutdown 信号；取消时保留已做部分。
8. **发送管线**：一律走 `sendMail`/outbox，不自行实现 SMTP。
9. 日历 UI 已定：事件 chip **禁止**左侧彩色竖线（纯底色 `color-mix` 浅染）。
