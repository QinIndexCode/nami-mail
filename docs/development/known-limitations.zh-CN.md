# 已知限制

[简体中文](known-limitations.zh-CN.md) | [English](known-limitations.en.md)

本页集中记录 Nami Mail **已核实的能力边界与刻意的取舍**：每条给出代码或文档依据、影响范围，以及当前应对或接受它的理由。它不是路线图（不承诺时间表），也不是缺陷列表（可复现的 bug 请提交 GitHub Issues）。发布说明、审计与排障统一引用本页，不再各自重述。

核实基线：2026-10-22 的工作树（提交 `cd47467`）。代码变动后应同步复核对应条目。

## 一览

| # | 条目 | 性质 |
|---|---|---|
| 1 | Outlook / Hotmail 登录受限（issue #120） | 产品边界 |
| 2 | 附件元数据回填的首次启动成本 | 数据 / 启动 |
| 3 | 草稿附件的回形针延迟 | 行为 |
| 4 | 会话标题协议与旧前端 | 协议 / 兼容 |
| 5 | 数据库文件之外的明文面 | 隐私 / 数据 |
| 6 | 2026-10 复核记录中尚未处理的项 | 工程债 |
| 7 | 端到端测试的覆盖边界 | 测试 |
| 8 | 预留但当前不产出的任务类型 | 预留设计 |
| 9 | 保留的 `/api/batch-jobs` 兼容别名 | API 兼容 |
| 10 | 没有稳定版 / 测试版通道与一键回滚 | 发布策略 |
| 11 | 错误日志：有界文件，没有用户侧错误历史 | 排障 / 隐私 |
| 12 | 2026-10-22 审计中未修复的项 | 审计 / 未修项 |
| 13 | 附件在线预览的能力边界 | 附件 / 平台 |

## 1. Outlook / Hotmail 登录受限（issue #120）

**现状。** 微软已对 Outlook.com / Hotmail 停用 IMAP/SMTP 基础密码认证，要求 OAuth2。官方构建的内置 Microsoft OAuth 客户端 ID 为空字符串（`apps/server/src/config.ts` 的 `builtinMicrosoftOAuthClientId = ""`），且没有随包内置 Azure 应用注册，因此全新安装下“使用 Microsoft 登录”不可直接完成；该限制跟踪在 GitHub issue #120。企业或学校租户的管理员还可能在组织策略里禁用 IMAP。

**影响。** 不能用普通密码添加 Outlook / Hotmail 账户；直接填写密码会被服务商拒绝。组织账户即使配置了 OAuth 也可能因管理员策略而无法连接。

**当前应对。** 需要登录 Microsoft 账户时，在 `%APPDATA%\Nami Mail\nami-mail.env` 配置 `NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID`（一次性 Azure 应用注册，步骤见[邮箱服务商配置](../EMAIL-PROVIDERS.zh-CN.md)的 “Google 与 Microsoft OAuth” 一节）。官方 Azure 应用注册并内置客户端 ID 是后续计划；在此之前可先用其他邮箱服务商。订阅、账户类型与管理员策略的差异也需要向对应管理员确认。

## 2. 附件元数据回填的首次启动成本

**现状。** 附件可见性统一为“非 `multipart/related` 部分才算附件”后，旧库需要把 `has_attachments` 与 `attachment_kinds_json` 重算一次。`apps/server/src/message-storage.ts` 的 `ensureAttachmentMetadata` 在 `buildApp` 的启动序列里同步执行：读取全表、逐行解密邮件载荷、重算两列，完成后写入 `data_migrations` 标记（`attachment-metadata-v1`）。载荷无法解密的行保留旧值，不阻断启动。

**影响。** 这是一次性的启动阻塞，成本随消息数量与载荷大小增长。本机实测样本：主库文件约 637 MB（2026-10 测量；数据目录合计约 772 MB，含端到端夹具，随邮箱规模变化）。回填完成后，后续启动读到标记即跳过——即使有载荷读不出来的行也会写入标记，否则每次启动都要为它们全表解密一次。**有日志、没有用户侧界面**：函数返回 `{ backfilled, unclassified }`（`unclassified` 是载荷无法读取、因而保留了旧标记的行数），启动调用处已把返回值写入 `serverLog`（`unclassified > 0` 时记 warn），但 `/api/stats` 的字段只有 accounts/messages/unread/starred/snoozed/attachments，界面没有回填进度或条数。

**当前应对。** 接受一次性成本；大邮箱升级时为首次启动预留时间。排障时可观察启动耗时。`unclassified` 大于 0 说明有行永远无法归类（通常是主密钥与数据库不匹配）。这个数现在能在服务端日志里看到；要让它出现在界面，仍需新增指标或界面入口（目前没有）。

## 3. 草稿附件的回形针延迟

**现状。** 保存草稿时 IMAP `APPEND` 不返回 MIME part 标识，本地草稿行因此把载荷的 `attachments` 写成 `null`、`has_attachments` 写成 0（见 `apps/server/src/drafts.ts` 的 `persistAppendedDraft`，注释说明了原因）。列表回形针读行内标记、阅读区附件列表读载荷；代码**没有**改成读时派生附件元数据。

**影响。** 刚保存的草稿在首次 Drafts 同步完成前可能没有回形针，阅读区也没有附件列表。附件本身不受影响：`drafts.ts` 构造 APPEND 的 RFC822 内容时已经带上附件内容，本地缺的只是可列的附件元数据；首次同步后由服务商副本补齐。

**当前应对。** 接受短暂的不一致：宁可不显示，也不伪造一个不可下载的附件条目。首次 Drafts 同步后由服务商副本自动补全。若某个环境长期不同步 Drafts（例如只发不收），该草稿的附件可见性会一直缺失——这是刻意的取舍。

## 4. 会话标题协议与旧前端

**现状。** 会话标题先由本地规则派生（首条消息、斜杠命令及其参数、引用的邮件主题），再请模型在最终回答**首行**输出 `TITLE:` 行做精化；流式探针会把这一行从回答中剥离，格式不合法时保留派生标题。只有纯寒暄或无主题的首条消息会得到空字符串标题（有意如此：等下一轮出现真实主题再命名）。服务端允许 `title: ""`，当前 Web 客户端用本地化占位“新对话”渲染空标题。

**影响。** 跨版本组合有边界：**旧前端（v0.5.1）× 新服务端**会把空标题渲染成空白标题（旧代码用 `title ?? 占位`，空字符串不是 `null`/`undefined`）；新前端 × 旧服务端不受影响。标题质量依赖模型遵循 `TITLE:` 协议，但会话不依赖它可用。

**当前应对。** 发版说明标注该组合；升级前端后空白标题自动消失。模型不遵循协议时退化为派生标题，不影响会话创建、发送与检索。

## 5. 数据库文件之外的明文面

**现状。** 主加密结论（凭据、OAuth 令牌与邮件敏感载荷的应用层加密，以及数据库文件的整库加密）只覆盖数据库文件与加密载荷；服务端与桌面端仍会用文件系统写出少量明文面。逐面如下：

- **备份 ZIP（明文）**：`GET /api/backup` 把每封邮件的规范 RFC822 原文（从服务商重新拉取）流式写入 `.eml` ZIP。它的用途就是可移植的明文导出，不受数据库加密覆盖；能读取该 ZIP 的人能读到邮件内容。
- **WAL 残留（`journal_size_limit` 未设）**：`apps/server/src/db.ts` 启用 `journal_mode = WAL` 与 `secure_delete = ON`，但没有设置 `journal_size_limit`，因此 checkpoint 后 WAL 文件不会自动截断，会保留历史页面帧。整库加密生效后这些帧是**加密页面**，不是明文邮件；真正的明文窗口是**首次启用整库加密之前**产生的旧 `-wal` / `-shm`，迁移代码会先 `wal_checkpoint(TRUNCATE)`、零覆写旧明文主库、删除旧 `-wal` / `-shm`，再改名密封后的新库（`apps/server/src/database-encryption.ts`）。结论：不改变“库文件已加密”，但备份或取证时应把 `-wal` / `-shm` 与主库一起看待。
- **`renderer-local-store.json`（明文）**：桌面 userData 目录（Windows 默认 `%APPDATA%\Nami Mail`）下由主进程写入的渲染器偏好 JSON。键为 `nami-mail.*`，其中 `nami-mail.avatar.<email>` 保存**发件人邮箱与用户选的头像 JPEG data URL**，另有 locale、文件夹显示方式等偏好；本地服务不读它，它也不进入服务端加密存储。
- **其他同一威胁模型下的有界面**：数据目录的 `startup-request-log.jsonl`（只记录 HTTP method 与去掉查询串的路径，启动首 60 秒与慢请求，上限 5000 行）；桌面 userData 的 `startup-log.jsonl`、`startup-timings.json`、`runtime-log.jsonl`（有界行数与单条长度，含崩溃、子进程 console 镜像）。`NAMI_MAIL_NO_STARTUP_LOG=1` 可关闭追加（裁剪不受开关影响）。

**影响。** 同机同用户的其他进程可以直接读取这些文件。备份 ZIP 与 `renderer-local-store.json` 可能泄露邮件内容或发件人邮箱/头像；WAL 与诊断日志在整库加密生效后不含明文邮件内容，但属于数据库文件之外的额外字节。这**不影响**数据库与附件加密的结论——它说明加密边界是“数据库文件 + 应用层载荷”，不是整盘。

**当前应对。** 接受并逐面记录：备份由用户主动生成、存放位置自选，应按邮件同样保管；诊断文件有界、可关；`renderer-local-store.json` 的密封已作为后续项排在加密计划的待办里（与图片缓存按用途密封的方式相同）。总体边界见[隐私与本地数据说明](../PRIVACY.zh-CN.md)。

## 6. 2026-10 复核记录中尚未处理的项

**现状。** 2026-10 的多轮复核把“发现但本轮不改”的项按类别留档，这里只做归类（不逐条复制）：

- **v42 的 C 类 4 项**（发送 / 投递状态机，记录但不改）：360 秒的调度器放弃阈值依赖默认退避阶梯；启动恢复的 0 阈值与 runner 的 360 秒在跨进程时假定单实例；`network_unavailable` 仍在“确定未传输”清单里（`DATA` 之后的同类错误可能被判成 `failed`）；`completed` + `unknown_delivery` 的乐观 Sent 行只能等服务商 Sent 副本认领。
- **v46 的 E 类 6 项**（需要产品决定，故意不做）：Agent 记忆是否按账户隔离；MCP 信任模型（签名 / 白名单 / 首次确认）；CSP `img-src` 收紧（邮件外链图片的隐私与显示取舍）；Windows 上 `0o600` 等价的 ACL 策略；无 AAD 旧库的回落策略；重复依赖去重。
- **v49 的 P2 类 12 项 / P3 类 3 项**（Agent 工具链审计的低优先项）：P2 涵盖 MCP 崩溃后工具注销、分页与并发、响应体上限、搜索工具入参与结果 URL、记忆淘汰与台账可被改写、日历 / 设置工具的行为、发送幂等键、`threads.get` 的线程根、超大工具结果的截断；P3 涵盖网页结果缺少不可信标记、MCP 适配的数组 enum 转换、`time` 工具的时区与本地化语义。

**记录位置。** 明细在 2026-10 重构的内部复核记录（v42 §C、v46 §E、v49 的 P2/P3）与《Agent 工具链审计 v49》中；这两份是内部文档、不随仓库发布，本页只作为分类入口与引用点。发布说明将来只引用本页，不再复制明细。

## 7. 端到端测试的覆盖边界

**现状。** 默认的 `npm run test:e2e` 只运行 4 个 spec（`smoke`、`interactions`、`update-footer`、`geometry`），它们都引导 `/?demo=1` 的演示外壳，**不经过真实 API 与数据库**。真实链路（renderer → Vite 代理 → Fastify ↔ SQLite，含 DTO、Host 校验与载荷解密）由单独的 `e2e/real-chain.spec.ts` 覆盖，通过 `npm run test:e2e:real` 或 `npm run test:e2e:all` 运行。

**影响。** 邮件主流程（真实同步、搜索、发送等）在默认端到端套件里没有浏览器级覆盖；演示外壳的回归与真实链路的回归是两套证据，不能互相替代。

**当前应对。** `test:e2e:real` 自带隔离夹具服务器：API 端口 **3199**、Web 端口 5174、种子库在 `data/e2e-real`、单 worker 串行，且 `reuseExistingServer: false`——运行前必须让 **3199 空闲**，也不能复用已运行的开发服务器。发布前按[测试计划](testing-plan.zh-CN.md)与[发布检查清单](release-checklist.zh-CN.md)显式执行真实链路验证。

## 8. 预留但当前不产出的任务类型

**现状。** 任务层的种类词表（`apps/server/src/tasks/types.ts` 的 `TASK_KINDS`）列有 8 种，当前实现 runner 的是 `move`、`flags`、`undo`、`send`、`snooze` 5 种。`draft-discard`、`filter`、`agent-apply` 是**预留**：草稿与过滤规则保持同步执行，Agent 写入复用 `send` / `flags` / `move` 的注入接缝（`apps/server/src/agent/mail-write-seams.ts`），所以当前没有这三类任务的生产方。

**影响。** 正常路径不会产生这三类任务。词表不是数据库 CHECK 约束（SQLite 无法在不重建表的前提下放宽 CHECK），但有两条补偿：`recordTask` 在写入前拒绝词表外的 kind；已存但没有注册 runner 的 kind 由调度器首次见到即结算为 `failed` 且 `error_code = "no_runner"`，不会永远停在 pending。

**当前应对。** 这是预留而不是缺陷；接入对应功能时注册 runner 即可。原因记录在 `apps/server/src/tasks/wiring.ts` 的注释与提交 `e1e0b1a`。

## 9. 保留的 `/api/batch-jobs` 兼容别名

**现状。** 批量操作已由任务层承载，`/api/batch-jobs` 的三个端点（创建 `POST /api/batch-jobs`、查询 `GET /api/batch-jobs/:id`、撤销 `POST /api/batch-jobs/:id/undo`）作为**兼容别名**保留，与只读的 `GET /api/tasks`、`GET /api/tasks/:id` 并存。别名内部把批次 id 当作共享根：创建转给任务接受、查询投影任务快照、撤销扇出为撤销任务。

**影响。** 两个 API 面同时存在：新代码应使用 `/api/tasks`；批次 id 仍是渲染层轮询与撤销按钮的锚点。两套语义之间的差异（例如批次是“一次作业”，任务是“一行作业”）由调用方负责理解。

**当前应对。** 保留是刻意的：渲染层轮询与 toast 撤销都围绕批次 id 建成，删除需要同时改客户端与端到端测试。删除时点由重构契约的开放问题约束——前端与端到端全部迁到 `/api/tasks` 之后。

## 10. 没有稳定版 / 测试版通道与一键回滚

**现状。** 自动更新只查询公开 GitHub Releases 的 latest **稳定**版本（形如 `x.y.z`），跳过 draft 与 prerelease，且只在版本更新时下载；没有 beta / stable 通道选择。回滚没有内建通道：运行较旧的安装程序会被识别为降级并默认取消，需要用户明确确认才继续。

**影响。** 无法在不改配置的情况下试用测试版，也不能在更新出问题后“一键退回上一版”。回滚的实际手段是重新安装旧版并明确确认降级。

**当前应对。** 这是刻意的发布取舍：单通道降低发布与信任根的复杂度，所有用户拿到同一条已签名的链。试用版请使用本地构建，不要作为更新通道发布。行为细节见[Windows 安装与更新指南](../INSTALLING.zh-CN.md)与[发布流程](../RELEASING.zh-CN.md)。

## 11. 错误日志：有界文件，没有用户侧错误历史

**现状。** 服务端日志走标准输出 / 标准错误（pino），应用**没有面向用户的错误历史、日志查看器或导出入口**。打包桌面会把启动阶段、崩溃、未处理拒绝以及子进程 console 输出镜像进 userData 下的**有界**诊断文件：`startup-log.jsonl`、`startup-timings.json`、`runtime-log.jsonl`（行数与单条长度受限；`NAMI_MAIL_NO_STARTUP_LOG=1` 可关闭追加）。数据目录另有有界的 `startup-request-log.jsonl`（只记录 method 与去掉查询串的路径）。发布流程的 `scripts/smoke-diagnostics.mjs` 是**安装 / 打包 smoke** 的诊断写入器（会脱敏敏感环境变量），不是用户排障入口。

**影响。** 附件回填的 `unclassified`、FTS 的 `skipped` 与过滤规则失败都会写入服务端日志（部分会镜像进上述有界文件），但应用没有面向用户的查看或导出入口。用户排障主要靠界面错误提示与上述有界文件；没有“一键导出错误日志”的路径，跨会话的错误历史会被有界轮转覆盖。

**当前应对。** 接受有界与自动清理，避免无界增长与隐私面扩大。反馈问题时附上界面提示，以及（如需）userData 与数据目录下的诊断文件；发布验证使用 smoke diagnostics。若将来提供用户侧导出，必须同时确定脱敏规则。

## 12. 2026-10-22 审计中未修复的项

**现状。** 2026-10-22 的只读审计复核了 2026-10 重构后的实现。下列问题已确认存在、本轮未修；本轮已修复的项不在此列（修复记录在 CHANGELOG 的 `[Unreleased]` 段）。

| 严重度 | 位置 | 现状与影响 | 为何暂不修 |
|---|---|---|---|
| P2 | `apps/web/src/App.tsx:1316-1324` | `threadExtras` / `threadStripMembersRef` 持有列表之外的线程成员整行快照；对只在 extras 里的成员（从线程条打开的旧邮件）执行“标为未读”，API 成功但界面不变，因为 `store.applySeen` 找不到该行。 | 属状态所有权调整，需先把线程成员的读取路径并回单一 store。 |
| P2 | `apps/web/src/app/useAppRealtimeSync.ts:70-74`、`App.tsx:830-871` | `onTaskSettled` 直接调 `reconcileFromEvents()` → `silentRefresh()`，绕开 `useCoalescedRefresh` 承诺的“窗口隐藏时只标脏”；桌面 `backgroundThrottling: false`，最小化时仍会跑 4 个并行请求。 | 需先决定“任务结算的可见性优先级是否高于窗口隐藏”。 |
| P2 | `apps/desktop/src/main.mts:2068-2075,2081,2096-2102` | `second-instance` 的入口是 `void (async () => …)()`（或 `.then`）且没有 `catch`；boot 未完成时 `localServer` 还是 `undefined`，不建窗只 `focusWindow()`，用户看到“点了没反应”，错误只进 `runtime-log.jsonl`。 | 要改 Electron 启动生命周期，需真机验证首启与崩溃重启两条时序。 |
| P2 | `apps/web/src/realtimeSync.ts:150-151,200-201,222-223` | 先写 `lastSseEventAt` 再解析帧；坏帧被当作“流是活的”，会抑制一轮轮询（间隔 30/60/180/300s 可选）。 | 仅跨版本组合才可能触发，且有手动重连兜底。 |
| P3 | `apps/server/src/mail.ts:87-104`、`calendar.ts:255`、`message-links.ts:44`、`settings.ts:34` | 零调用导出：`testMailboxConnection`（`testAccountConnection` 的旧子集）、`clearAllCalendarEvents`、`localizeLinks`、`AGENT_ACCESS_LEVELS` 全仓无调用方。 | 删除要确认没有外部脚本依赖，属清理批次。 |
| 结构性 | `apps/web/src/app/mailStore.ts` | `total` 不是从 `messages` 派生，而是服务端快照 + 5 处本地 ±1（`nextMessageTotalForSnapshot`、`applyMove`、`restoreMove`、`removeMessages`、`restoreMessages`）；本页第 2 节的描述已按现状写。 | 服务端 `total` 是全量匹配数，前端只有已加载页，无法真派生；要改需要服务端提供可增量校验的计数。 |
| 边界 | `apps/server/src/message-storage.ts`（`verifyEncryptedPayloads`） | 迁移后的校验扫描仍 fail-closed，错误里点名受影响的行 id（最多 50 个），但没有“跳过并继续启动”的开关；FTS 与附件回填遇到坏行会跳过并记录 `skipped` / `unclassified`，同样没有修复入口。 | 刻意保留的失败关闭策略，放宽需要产品决定。 |
| 残留 | `apps/server/src/sync.ts`（`subject` 派生处） | 新行不再写中文占位“（无主题）”，但已落库的历史行要等下一次 IMAP 重新同步才会变成空主题；在此之前英文界面仍会显示中文。 | 改写历史行需要一次数据迁移，收益低于风险。 |
| 已缓解 | `apps/server/src/database-encryption.ts`（`recoverInterruptedConversion`） | 写零主库到改名之间崩溃，下次启动可从 `.encrypting` 校验后接管并记 warn；但主库被写零的那几秒内进程若被强杀，本次会话仍需重启恢复。 | 彻底消除需要“先改名再销毁”的重排，属另一批改动。 |

## 13. 附件在线预览的能力边界

**现状。** 附件预览是一条显式流水线（见[决策 0002](decisions/0002-2026-10-attachment-preview.zh-CN.md)），以下边界是**刻意**的，不是待修 bug（本条核实于提交 `d5a4e68`）：

- **不自建 Worker / OffscreenCanvas**：解码与渲染都在渲染进程主线程上；pdf.js 自带的 worker 由 `loadingTask.destroy()` 收回，但没有第二个我们自己的线程。长解码期间界面仍可能掉帧。
- **旧版 Office 与专业栅格格式不做解码**：`.doc` / `.xls` / `.ppt`（OLE 复合文档）不在可预览目录内，直接是 tier C 的下载卡片；HEIC / TIFF / PSD 这类"声明为 `image/*` 但不在六种栅格签名内"的文件会按 raster 取数，图头嗅探失败后以 `corrupt` 错误卡片加下载入口结束（`apps/web/src/attachments/decode/image.ts:180-181`），**不会**尝试额外解码。
- **媒体只用 Chromium 的原生解码器**：音频与视频就地播放，但**没有 Range 流式**——整个部件先取完再交给 blob URL，因此超过 `MAX_INPUT_BYTES.media`（32 MiB，见 `apps/web/src/attachments/budget.ts`）直接拒绝；**没有字幕轨**；容器或编解码不被 Chromium 支持时（如 `avi` / `flv` / `wmv`）回退为下载卡片。
- **PDF 只保留一个页 canvas**：翻页重新渲染，没有页缓存；`PdfSurface.tsx` 在整份文档上用一个缩放比，因此超大页会先被 `PAGE_PIXELS_MAX` 拒绝而不是缩小显示。
- **内存账本不是进程内存上限**：`MemoryLease` 只统计本仓库自己的分配；pdf.js 内部结构、浏览器图像与媒体解码器都不在这本账上（`budget.ts` 的注释写明了这一点）。
- **没有可中断的硬截止**：单个超大 XML 部件的 `DOMParser.parseFromString` 一旦开始就无法中断，Office 路径的元素数预扫在解析之前、字符上限在解析之后，`DECODE_DEADLINE_MS` 只是事后止损。
- **Markdown 有独立的降级线**：超过 `MAX_MARKDOWN_BYTES`（8 MiB，入口按声明大小先拒）或超过 `MAX_MARKDOWN_BLOCKS`（4,000 个顶层块）时降级为仅下载，而不是截断渲染（`apps/web/src/attachments/decode/markdown.ts:52-77`）。
- **两处的文件名处理不一致**：抽屉内的标题与下载名已消毒（`sanitizeDisplayName`，`AttachmentPreviewDrawer.tsx:311-313`），阅读区附件卡片仍按原字符串显示（`MailReader.tsx:471-472`）；后者是本轮未处理的展示面。
- **有一部分只能靠真机目视验收**：jsdom 没有真实 canvas 与媒体解码，PDF 是否画得出、扫描件是否完整，只能人工打开文件确认；`e2e/attachment-preview.spec.ts` 能证明像素非全白与翻页，但不能替代人眼。

**影响。** 上述边界全部表现为“明确的可下载/可播放/可阅读”，而不是静默空白：打不开的类型给下载卡片，画不出的页给页级错误，超限的输入在入口就被拒绝。代价是某些本可以“显示一部分”的文件（例如含可恢复错误的 PDF）只能下载原文件。

**当前应对。** 接受这些边界并把它们写进发布说明；`done_when` 中的真机验收项（向量文本 PDF、300 DPI 扫描件、多页翻页与宽度拖动）是每次改动预览路径后的必做项。如果将来要突破其中任一条（例如引入 Worker 解码、Range 流式媒体、PSD 解码），应按[决策记录约定](decisions/README.zh-CN.md)另写一份记录，而不是在这条边界上原地放宽。

## 相关文档

- [隐私与本地数据说明](../PRIVACY.zh-CN.md)：加密边界与明文元数据。
- [Windows 安装与更新指南](../INSTALLING.zh-CN.md)、[发布流程](../RELEASING.zh-CN.md)：更新、降级与发布验证。
- [邮箱服务商配置](../EMAIL-PROVIDERS.zh-CN.md)：OAuth 与密码登录的差异。
- [测试计划](testing-plan.zh-CN.md)、[发布检查清单](release-checklist.zh-CN.md)：各层测试证据与发布前人工验证。

## 维护约定

- 新条目先核实再写：给出来源（代码位置或文档），确认不了就标注“待核实”，不要写猜测。
- 不写会过期的数字：测试数量、耗时、发布计数都留给 CI 输出；必须出现的数据要注明是实测样本。
- 发布说明、审计与排障只引用本页；本页之外的重复描述应删除，避免再次散落。
