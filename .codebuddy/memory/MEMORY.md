# Nami Mail 长期记忆

## 项目概况
- 本地优先的多账户 Windows 桌面邮件客户端（Electron + Fastify + React + SQLite）。
- workspace：`apps/web`（React/Vite）、`apps/server`（Fastify/IMAP/SMTP/SQLite）、`apps/desktop`（Electron 主进程，.mts）、`packages/agent-contracts`、`packages/agent-core`。
- 根目录 `package.json` 的 `build` 段就是 electron-builder 配置（无独立 builder 配置）。

## 交付流程约束（ARCHITECTURE-ROADMAP.md §4）
- 交付分支固定 `backup/backgrounds-baseline`，**绝不 push main**（当前 main 实际已 ahead，与约束有偏差）。
- **2026-09-12 实际做法**：全部成果推到 `origin/backup/2026-09-12-techdebt`（本地分支与 main 指向同一提交）。`main` 仍本地领先 `origin/main` 28 个提交、**未推送**。推送前先 `git branch -f <backup> main` 让分支跟上最新提交。
- 远端另有 11 个 `dependabot/*` 分支待处理。
- **依赖安全的两套口径别混淆**：本地门禁 `npm audit --omit=dev --audit-level=high` = **0**； GitHub Dependabot 对默认分支报 **27 个漏洞（18 high / 9 moderate）**，差额来自 devDependencies 与传递依赖。回答"有没有漏洞"时必须说明是哪套口径。
- 每批需：全量回归 + 四 workspace typecheck + locale catalog 0 missing → Mimosa deep scan seal 入 commit body → 单 commit。
- 代码改动用编辑工具，不用 Bash 直写 src。

## 交付流程补充（Batch T 后生效）
- 桌面测试现已纳入 typecheck：`apps/desktop/tsconfig.test.json`（allowImportingTsExtensions + noEmit），`typecheck` 脚本双跑——新增桌面测试必须过类型检查。
- CI 对 `scripts/*.test.mjs` 是**显式列举**（validate.yml / release-windows.yml），新增脚本测试必须手动登记，无 glob。
- 一次性脚本归档在 `scripts/attic/`（48 个），约定见 `scripts/README.md`。
- **smoke 探针闸门必须保持 env 级**（`NAMI_MAIL_SMOKE=1` + 结果路径），**不可加 `!app.isPackaged`**：发布管线的 `smoke-package.mjs` 要跑已安装的应用（isPackaged=true），加了这个闸门会卡死 `package:win` 的安装器冒烟门（探针不激活 → 无结果文件）。探针模块本身仍随 asar 分发（无打包器）。
- node:assert 的 `equal/deepEqual` 带 `asserts actual is T`，对数组/对象做断言会把类型收窄成字面量（如 `[]` → `never[]`），测试里对集合用 `length` 断言。

## 故障排查捷径（2026-09-11 实战建立）
- **`operation_queue` 表把失败原因原样落库**（`error_message` + `payload_json` 里有 messageId/target）。任何"某个邮件操作失败"的问题，先查这张表，比从 HTTP 状态码猜快得多。查询方式：拷贝 `.db/.wal/.shm` 到临时目录后用 `node:sqlite`（Node ≥22，`readOnly: true`）只读打开；也**可以直接对运行中的库只读打开**（实测可行）。
- 日志位置：`%APPDATA%\Nami Mail\runtime-log.jsonl`（**有 statusCode/responseTime**，含服务子进程 pino 转发）、`data\startup-request-log.jsonl`（**只有 url/ms，没有 statusCode**）。日志里的 `Z` 是 UTC（本地 = UTC+8）。
- 应用日志里 `local-service-ready` / `window-loaded` 等阶段来自 `DesktopDiagnostics`；子进程输出经 `server-process-output` 事件转发。

## 移动邮件（move）的忙碌语义（2026-09-11 修复）
- 历史缺陷：同步进行中时移动操作**立即失败**（2ms、422），且复用 `PENDING_MOVE_RECONCILIATION_ERROR` 文案 —— 导致"移动到废纸篓失败"且极难定位（4/4 全失败，而 flags 全成功，因为 flags 走写后即返、无此闸门）。
- 现语义：先 `markAccountMoving` 占住账户（`syncAccount` 会跳过 moving 账户，故不会再有新同步开始）→ 等正在跑的同步结束（`ACCOUNT_SYNC_WAIT_MS=15s`，须低于渲染层 30s 请求预算）→ 执行移动；超时才报 `MAILBOX_SYNCING_ERROR`。批量同策略。
- **三个原因现在有三个文案**，勿再合并：`MAILBOX_SYNCING_ERROR`（同步中）/ `MAIL_MOVE_IN_FLIGHT_ERROR`（另一条移动在处理）/ `PENDING_MOVE_RECONCILIATION_ERROR`+`MOVE_LOCATION_UNVERIFIED_ERROR`（该邮件自身的移动待协调）。新增文案必须同时加进 `routes/messages.ts` 的 `moveActionErrorMessage` known-local-errors，否则会被替换成通用"未识别错误"。
- 未解决的上游：Gmail 8 文件夹的同步回合偏长，15s 等待仍可能不够。

## 前端乐观更新：统一登记表（2026-09-11 重构，改刷新/乐观逻辑前先读）
- **一个登记表** `pendingLocalStateRef`（`MutablePendingLocalState`：`flagOverrides: Set<id>` + `movedAway: Map<id, destinationMailbox>`），合并函数 `mergePendingLocalState(serverItems, currentItems, pending)`（`mailListState.ts`）。语义：`movedAway` 里的 id，只要服务端还没报在 `destination`，就从快照里**剔除**（乐观移除不被"复活"）；`flagOverrides` 里的 id 用本地 `seen/flagged/flags` 覆盖服务端值；其余行完全以服务端为准。
- **三处刷新入口都必须调用它**：`load()`、`silentRefresh()`、`loadMore()`。历史缺陷正是"每个特性各有一套"：`seenMutationIdsRef`（已读）/`batchFlagPinsRef`（批量）/`pendingArchiveMovesRef`（只覆盖 archive，且是**保留**语义不是剔除语义）→ 移动类操作完全没有保护，别的操作完成触发的 reload 会把排队中的删除"复活"。
- pin 生命周期：单条操作在 `finally` 里 unpin（服务端同步路由在响应前已提交，之后快照就是真值）；批量在"对账 load 完成之后"unpin。卸载时清空。
- 星标路径此前**既不乐观也无 pin 且不同步 `messagesRef`** → 现已改为乐观 + pin + ref 同步（复用 `applyBatchFlaggedChange([id], flagged)`）。
- 注意别把 `movedAway` 的剔除语义与 `mergePendingArchiveMoves` 的**保留**语义搞混：后者让"已归档行"在新位置继续可见（Gmail All Mail），前者让"已删除行"立刻消失。两者顺序是 archive 保留 → unread 快照 → pending 本地覆盖。
- **`flagOverrides` 是计数（`Map<id, number>`）不是 Set**：同一封邮件可能同时有两个在飞的操作（打开自动已读 + 用户加星），Set 会让先结束的那个把另一个还需要 pin 撤掉。用 `pinFlagOverride`/`unpinFlagOverride`，不要直接 add/delete。
- **pin 解除必须在对账 load 落地之后**（`await load()` 再 unpin）。批量移动曾经 `void load()` 后立刻 unpin，等于没 pin——这是同一 bug 换了个位置复发。
- **批量任务轮询必须通过 ref 读最新 `load`**（`loadRef.current`）：poll 循环会一直持有启动时的闭包，否则任务结束时会把列表拉回任务开始时所在的文件夹。

### 竞态审计剩余待办（2026-09-11 三域审计产出）
已修（2026-09-11 第二轮，全部带用例/门禁）：
- ✅ `batchMoveMessages` 的 pin 解除顺序（`void load` → 改 `await load`）；`flagOverrides` 改计数语义。
- ✅ 批量任务轮询用 `loadRef.current` 读最新 `load`（否则任务结束把用户拉回旧文件夹）。
- ✅ `SettingsModal.applyOptimisticSettings` 加写序号 `settingsWriteRef`；`settings` prop 回灌加 `lastPublishedSettingsAtRef` echo 守卫（不再覆盖正在编辑的内容）。
- ✅ submissions：`sendingStatus.ts` 新增 `isStaleSubmissionSnapshot`/`mergeSubmissionSnapshots`（按 `updatedAt` + 状态进度判定陈旧）+ App 侧 `cancelledSubmissionIdsRef`（自清理）；顺带修掉提交轮询 effect 依赖 `accounts` 导致计时器被反复重置。
- ✅ 侧栏未读数：`mailListState.ts` 新增 `applyPinnedUnseenCorrections`，`load`/`silentRefresh` 在合并行之后用它修正 `stats.unread` 与 `folders[].unseen`。
- ✅ 更新状态：App 与 SettingsModal 各加 `updateEventSeqRef`，操作返回的快照只在「期间没有事件到达」时才可落地；SettingsModal 订阅补 `receivedUpdateEvent`。
- ✅ `AgentWorkspace.selectConversation` 失败分支补 `restoreLiveRunIndicators(id)`。
- ✅ `dialogPrefetch` 新增 `revision()`（`refresh()` 自增），4 个消费点（Contacts/Templates/Calendar×2）await 后比对，旧响应不再写回。

- ✅ 无纪元取数 5 处全部收口（2026-09-11 第三轮）：`AutoReplyDecisionsDialog` 加 250ms debounce + requestRef；`AgentProviderSettings`/`AgentMcpServerPane` 加「脏表单」守卫（`formDirtyRef` + `{ resetForm }` 选项）+ 列表请求纪元；`AgentMemoryDialog.load` 加 requestRef；`AutoReplyPendingDialog.refresh` 把「in-flight 就丢弃」改为「排队重跑 + 纪元」（审批后刷新被丢弃会让已决策条目一直显示）。
- ✅ unread 视图总数：`mailListState.ts` 新增 `nextMessageTotalForSnapshot(serverTotal, localRowCount, inUnreadView)`——未读视图以服务端总数为准（保留的已读行由 `mail.count.unreadWithRetained` 单独报），其余视图维持 max()。
- ✅ 桌面新邮件 IPC 订阅：回调改从 `bridgeHandlersRef` 读取，effect 依赖仅剩 `isDemo`，订阅只安装一次（此前依赖 `silentRefresh`/`showToast`/`chooseView` 身份，反复拆装会丢通知）。
- ✅ 翻译分段接口 `api.translateMessageSegments` 补 `signal` 参数并在 App 传入 `controller.signal`；`ComposeModal.loadComposeTemplates` 加在飞守卫。

**该轮审计 backlog 已全部清空**（剩余项是别处的长期债务，见下）。

### Agent 会话：合并服务端快照的约定（2026-09-11）
- 凡是把服务端会话快照写进 `active` 的地方（切回会话的 fetch、后台补收 pickup 轮询），**不能直接整体替换**：该快照可能早于已流入本地缓冲的正文，整体替换会让回复「往回退」。统一用 `keepAheadTranscript(current, server, live)`（`agent/useAgentSession.ts` 导出）：run 仍在跑时保留更完整的一份，run 结束后服务端为准。
- runStream 收尾清错误行必须同时满足 `activeIdRef.current === conversation.id` **和** `isCurrentRun()`，否则被取代/后台结束的 run 会清掉屏幕上属于别人的错误行。
- CONFLICT 重试前必须 `clearPendingFlush()`，否则被服务端拒绝的那次尝试的 buffered delta 会落到重试的回复上。

### MCP / CLI 外露现状（2026-09-11 审计，**已修正上一版判断**）
- **子页面才是最新的、且描述准确**：`docs/mcp/tools.zh-CN.md:5`「当前构建状态：可用」，0.3.0 随附 `namimail` + PATH shim，`tools/list` 恰为 15 个工具（8 只读 + 7 写，写工具按 `send-confirmed`（桌面一次性确认）/ `full-access`（自动）档位开放）；`docs/cli/commands.zh-CN.md` 同样按档位列出写命令。README.zh-CN.md / README.en.md 也都是「available」。
- **只有根目录 `docs/mcp/README.md`、`docs/cli/README.md`** 还挂着旧横幅（「不可执行」「外部只读」）——已于 `fbe53c0` 改为双语导航入口（与 `docs/README.md` 同款），不再有第二份内容可漂移。
- 代码与文档一致：`main.mts` 用 `--cli` 入口调 `runDesktopCli`、`--service` 起无界面 AgentHost、`secure-pipe-relay.mts` 建当前用户 SID-DACL 命名管道、MCP stdio 协议 2025-06-18、配对与 Broker 恢复齐全。
- 小遗留（无害）：`cli.mts:55` 的 `blockedWriteCommands` 只在「命令未识别」时给友好拒绝，命名（`drafts.*`、`mail.send/move`）与现行契约 ID（`mail.draft.*`、`messages.*`）已脱节，且 `mail.reply` 是死条目（该命令已实现）。只影响错误文案，不影响能力。

### Agent 交互约定（2026-09-11）
- **停止生成必须即时**：`stopStreaming` 里 abort 后立刻 `session.done = true` + `setStreaming(false)/setStreamStatus(null)`，不等 fetch reject 走到 finally（此前按钮会一直亮到网络往返结束）。
- **重命名是乐观的**：先本地改标题 + 关输入框，失败还原（`renameConversation`）。
- 尚未改为乐观：**自动回复审批**（`AutoReplyPendingDialog` 等 `resolve` 回包后才刷新）。

### 文档配图（2026-09-12 重做）
- README 里嵌的截图：`docs/nami-mail-inbox-{zh-CN,en}.png`、`docs/nami-mail-agent-{zh-CN,en}.png`（另有 `nami-mail-wordmark.png` 是 logo，非截图）。**未被引用的 `nami-mail-inbox.png` 已删除**。
- **截图主题固定为暗色**（`test.use({ colorScheme: "dark" })`）——用户明确要求，暗色是产品展示主题。
- **软件默认背景是 `none`（纯色）**；demo 模式曾被硬编码成 `coast`，已于 2026-09-12 移除（样例帧不该展示新安装不会出现的界面）。
- **重做方式**：`e2e/shots.spec.ts`，对**运行态** demo 应用（`?demo=1`，模拟数据）截图。命令：`$env:NAMI_MAIL_CAPTURE_SHOTS="1"; npx playwright test e2e/shots.spec.ts`。**默认被 `test.skip` 跳过**（否则每次 e2e 都会重写已提交的图片）。
- 切语言的方式：`page.addInitScript` 预置 `localStorage["nami-mail.locale-preference"]`（demo 模式不落盘，所以这是唯一的开关）。
- **截图里那条横向浅带不是缺陷**：demo 的 `backgroundPreset: "coast"` 背景图本身有海岸线；`elementFromPoint` 探针确认该处只有正常邮件行。别去"修"它。
- 已知 i18n 缺口：`agent/agent-demo-data.ts` 的 `createDemoConversation()` **硬编码中文**（无 locale 参数），所以英文界面下 Agent demo 会话仍是中文内容。`demo.ts` 的邮件数据是按 locale 生成的，只有这个会话没有。
- 敏感数据检查（2026-09-12）：已跟踪文件里只有 `.env.example`（值全为空/安全默认）与两个名为 `account-credentials.ts` 的**源码**；无 `.pem/.key/.db/.sqlite`。文档正文里没有邮箱地址；截图内容全部来自 demo 数据集（`example.com`）。

### e2e 运行口径（重要，2026-09-12 踩到）
- `npx playwright test`（不带文件名）**会挂**：`e2e/ui-stress.spec.ts` 需要 `scripts/ui-stress/run-stress.mjs` 生成的种子清单。**必须用显式列表**：`npx playwright test e2e/smoke.spec.ts e2e/interactions.spec.ts e2e/update-footer.spec.ts e2e/geometry.spec.ts`（17 条）。
- 新增 spec 若带副作用（写文件）必须自己加 `test.skip` 闸门，否则会混进套件。

### 文档约定（2026-09-12 生效，写文档前先读）
- **承载正文的文件必须带语言后缀**：中文 `xxx.zh-CN.md`、英文 `xxx.en.md`。
- **无后缀的 `xxx.md` 只允许作为语言入口**（只有标题 + 语言切换链接，不放正文）。目前合规的无后缀文件：根 `README.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`SUPPORT.md`（GitHub 约定放根目录，故保留但已改为入口），以及 `docs/README.md`、`docs/cli/README.md`、`docs/mcp/README.md`、`docs/releases/README.md`。
- 历史坑：这些根文件原本**各自重复**了一份中文正文（同时存在 `X.md` 与 `X.zh-CN.md`），`CHANGELOG.md` 甚至比 `CHANGELOG.zh-CN.md` 落后 53 行。现在全部改成入口。
- **`ARCHITECTURE-ROADMAP.md` 已重命名为 `ARCHITECTURE-ROADMAP.zh-CN.md`**（暂无英文版，且无 md 引用）。
- 规则正文：`docs/DEVELOPMENT.zh-CN.md` / `.en.md` 的「文档语言与命名」小节。

### 技术债：大文件拆分（2026-09-11 已测绘，计划见 docs/REFACTORING-PLAN.zh-CN.md）
- 实测行数：`main.mts` 2069、`agent-service.ts` **3226**（不是之前记的 3072）、`App.tsx` 3764、`styles.css` 16906。
- **计划已写好并带行号**：main.mts 四块 = 托盘（已完成）→ **Agent 配对（2026-09-12 用户决定搁置，列入 futurePlan，测绘结果保留但暂不实施）** → 窗口外壳（−240，先抽纯函数 `nativeSplashUrl`）→ 关闭流程（最难，只抽纯函数 `stopLocalServerProcess`/`showClosePrompt`/`quitFromClosePrompt`，编排留主模块）。**当前执行顺序：托盘（已完成）→ 窗口外壳 → 关闭流程**。
- ✅ **第 1 步「托盘」已完成（2026-09-12，`7db4dc2`）**：新建 `apps/desktop/src/tray.mts`，`createTrayController({ getMainWindow, getAppIcon, loadAppIcon, copy, showError })` 返回 `{ ensure, destroy, getTray, focusWindow, hideWindowToTray, applyBadge, setWindowVisible }`；`tray`/`trayBadgeIcon`/`mainWindowVisible` 三个状态收进模块（`appIcon` 因窗口外壳也要用，留在 main 由 getter 注入）。main.mts 净 **−136 行**。验证：desktop 双配置 typecheck + 193/193 + 真实 Electron 冒烟（3 个 trayCreated 探针全 true）。
  - 经验：托盘函数与非托盘代码**交错**（`applyLaunchAtStartup`/`applyGlobalShortcut`/`nativeCopy` 夹在中间），只能按函数搬；`nativeCopy` 必须在控制器创建之前定义（它被注入），控制器放在 `nativeCopy` 之后。
  - 冒烟里 `trayCreated` 有 4 处取值，**1 处 false 是未触发区段的初始值**，真正的断言（smoke-desktop.mjs:548/560）要求 true —— 别看到单个 false 就以为拆坏了。agent-service.ts 先独立 `AgentServiceError`（否则新模块 import 会成环，且 `routes/agent.ts` + `routes/translation.ts` 依赖它，需再导出），再搬 provider 配置域（502-606 + 762-919，内部类型 318-466 要一起搬）。App.tsx 尚未测绘，**测绘前不要动手**。styles.css 拆分的真风险是层叠顺序不是语法。
- **关键坑**：托盘代码与非托盘代码交错（`applyLaunchAtStartup`/`applyGlobalShortcut`/`nativeCopy` 夹在中间），必须按函数搬、不能按行删；托盘要改的接线点至少 8 处（smoke 桥、关闭流程 ×2、applyTrayBadge ×2、hideMainWindowToTray ×2、appIcon、mainWindowVisible）。
- `agent-service.ts` **不要动**：`streamMessage`(1871-2509)、`invokeExternalTool`(1292-1556)、`providerMessages`(2999-3168)、确认链路(1729-1869)。

### 交互约定（用户偏好，2026-09-11）
- **多选操作成功 → 退出多选态**（清空选择）；**失败保留选择**以便重试。新增批量操作时按此约定实现，别再让选中项保持选中（会误触发第二次批量）。
- **已确认无问题（可作参照实现）**：翻译链路（`translationRequestIdRef` + AbortController）、附件预览（`active` + objectUrl 清理）、`realtimeSync` 连接状态机（`closed` + `next !== source`）、桌面 `updater.mts`（check/download promise 互斥）、`ComposeModal` 收件人建议（`toSearchRef` 请求号）、`AddAccountModal`（`discoveryRequestIdRef`）。

## 列表切换过渡（2026-09-11）
- 旧行为：切换账户/文件夹/视图/搜索 → `load()` 非 silent → `setLoading(true)` → `MessageList` 用 6 行骨架**整块替换**列表 → 列表变矮 + 布局跳动 + 丢失位置；搜索防抖点还会额外闪一次。
- 现行为：`MessageList` 内部派生 `hasRows/showSkeleton/showList/showEmpty`，**只有在完全没内容时才显示骨架**；切换期间保留原行（`data-switching` 期间走 `list-swap-dim` 动画降到 0.55 透明度），新内容到达时 `key` 从 `:pending` 变 `:ready` 触发 `list-swap-in` 淡入。
- 动画只用 `opacity`（**不要用 transform**：e2e `geometry.spec.ts` 会量 rect）。全局 `@media (prefers-reduced-motion)` 已把 animation-duration 压到 .01ms，无需单独加守卫。
- `MessageList` 新增可选 `listKey` prop（App 传 `listIdentity`：account|folder|view|查询|scope|附件类型|日期区间）。可选 → 既有测试与调用方不受影响。

## 验证命令备忘（2026-09-11 实测刷新）
- web 单测：`cd apps/web && npx vitest run`（74 文件 / **699** 用例，全绿）；e2e：根目录 `npm run test:e2e`（4 套 spec：smoke / interactions / update-footer / geometry，17 条；首跑易因 Vite 冷缓存卡 `#nami-splash`，复跑即稳）。
- server：`cd apps/server && npm test`（97 文件 / **800** 用例，**2026-09-12 起全绿**）。
- desktop：`cd apps/desktop && npm test`（**193** 用例全绿）+ `npm run typecheck`（双配置）。
- **`app.test.ts` 那 2 条失败的真实成因（2026-09-12 查清，不是"陈旧"这么含糊）**：① 期望默认 `backgroundPreset:"coast"` / `backgroundIntensity:68`，但服务端 `settings.ts:72-73`、web `types.ts:412-413`、DB `db.ts:214` **三处一致**为 `"none"` / `80` → 是测试写错了；② `expected 200 to be 400` 来自非法样例 `{ backgroundIntensity: 81 }`，而 schema 现在是 `min(0).max(100)`（`schemas.ts:197`），81 已合法 → 同样是测试过期。**修法是改测试的两处期望值**，不是改产品默认值。
- 依赖门禁：根目录 `npm audit --omit=dev --audit-level=high` 必须为 0（2026-09-10 才修到 0，之前会挂）。
- **注意（2026-09-11）**：根 `npm test` 用 `&&` 串联，server 一挂 web/desktop 就不会跑；要拿全量数字需分别跑。

## 设计规范（2026-09-10 建立，改样式前先读）
- 文档：`docs/DESIGN-SYSTEM.zh-CN.md` / `.en.md`（也在 docs 索引里）。改样式前对照；新增档位要同步更新该文档。
- 关键基线：**阅读字宽 `--measure:672px`**（≈72 字符/行；阅读区五个居中块共用，**不能用 `ch`**，因为容器继承 UI 字体）；**圆角四档** sm 8 / md 12 / lg 20 / pill 999，禁止字面数值；**阴影四级** 按"离内容面多远"选 `--shadow-sm/-raised/--shadow/--shadow-drawer`；**正文行高 1.7**、字号**不主张整体放大**（小字号密度是产品定位，只治理"同语义不同档"）；语义色是刻意降饱和灰调，强调色必须同饱和区间。
- 收敛纪律：**多像素级收敛（字号/间距/降饱和）必须先建视觉基线**，否则无法判断改好还是改坏。待收敛清单在 DESIGN-SYSTEM §8。
- 阴影契约（Batch AC 后）：**高度阴影字面量=0**，四级 token 必用；明确豁免六类（`inset` 细线/`0 0 0` 焦点环/`0 1px 0 var(--line)` 分隔线/**状态光晕 recipe** `0 Npx Mpx color-mix(in srgb, var(--token) X%, transparent)`/原生控件细节/`none`）。测试按"层"判定，新增裸色值阴影立刻失败。
- **统计教训**：曾把 105 处阴影字面量当成"约 100 处待收敛"，实际 80 处是细线/焦点环。**按类别统计，别按关键字计数。**
- **基线已可执行**：`apps/web/src/themeContrast.test.ts`（WCAG 4.5:1 下限，字号全在 8–11px 故无"大字"豁免）与 `apps/web/src/designTokens.test.ts`（策略 + `debtBudget` **债务棘轮**：只许调小、新增越界值立刻失败）。修掉存量收敛项后**记得把预算数字调小**。
- 坑：`MessageList.test.tsx` 的部分样式断言是**整块字符串比对**，改对应 CSS 块会连带失败，需按原意更新断言。

## 更新链路：已评估、刻意不做的两件事（勿再提议，理由见 ARCHITECTURE-ROADMAP §2-4）
- **beta/stable 通道**：prerelease 版本串会撞三处 `x.y.z` 硬校验（`github-zip-update.mts` `isStableVersion`、`zip-update-installer.mts` 安装器计划校验、`update-install-result.mts` 记录解析），需先做 semver prerelease 设计。
- **版本回滚**：NSIS 就地覆盖，无程序文件备份，助手只能在失败时重启旧 exe。
- 已实现替代：`update-pending-install.json` + `installNotApplied` reason —— 覆盖"安装程序退出码 0 但版本未变"的静默失败（观察窗 2 分钟内判为 pending，不清记录）。
- 信任根/`signExecutable`：属发布流程，`docs/RELEASING.zh-CN.md` 已完整说明；`build/nami-update-trust.json` 的 `algorithm: disabled` 是刻意默认。

## 已知技术债口径（2026-09-09 全量走查实测）
- 巨型文件（**2026-09-12 复测**：`App.tsx` 3930、`main.mts` 2092、`agent-service.ts` 3072、`styles.css` 16933）：`App.tsx` 是上帝组件、无 App 级测试。拆分计划见 `docs/REFACTORING-PLAN.zh-CN.md`（接缝已测绘，代码尚未动）。
- `main.mts` 静态 import `desktop-smoke.mts`（测试探针进生产包）。
- desktop `package.json` test 脚本漏挂 3 个测试文件：`agent-host-lifecycle` / `agent-service-start` / `spawn-environment`。
- 未使用 electron-updater，自研 GitHub ZIP 更新；`build/nami-update-trust.json` 默认 `algorithm: disabled`，`signExecutable: false`。
- `scripts/` 内约 30/64 个 mjs 与全部 23 个 ps1 为孤儿脚本（零引用）。
- `apps/server/src/image-proxy.ts` 的 SSRF 校验只查初始 hostname，而 fetch 用 `redirect: "follow"` → 可被 302 绕过；该模块零测试。
- `apps/server/src/db.ts` `migrateDatabase()` 约 50 条 DDL 无外层事务。
- 文档 backlog（docs/ROADMAP）：vision/图片上传、错误日志落盘、Compose 富文本、收件人建议完整键盘导航。

## 本地服务已拆到 utility process（Batch AE，2026-09-11 完成，未提交）
架构：`main.mts` fork `server-host.mjs`（`server-process.mts` 提供 Electron `utilityProcess` 传输）→ `server-bridge.mts` 做请求关联/事件/反向请求。动因是 09-10 卡顿诊断（SQLite 同步 + 解密跑在主进程 → GET /api/messages 258–426ms 冻结窗口、PATCH flags 16s）。

必须记住的设计约束（改动前先读，否则会踩同一批坑）：
1. **`getSettings()` 必须是同步的**——原生托盘菜单/关闭对话框/通知门控都无法 await。所以桥在内存里维护一份**设置快照**，由「`updateSettings` 回包 + 服务端 `settings-changed` 事件」两条路刷新。改任何设置读取路径前先确认是否落在这两条路上。
2. **capability 不能跨进程**：desktop confirmation capability 现在**在服务进程内铸造**（`server-host.mts`），验证按**对象身份**——同形对象（含 `Symbol("nami-desktop-confirmation")`）一律不通过；主进程里不能再有这个名字的常量。
3. **服务端设置变更只有一个汇聚点**：`settings.changed` 事件总线。`runtime.ts` 的 `onSettingsChanged` 就是订阅它，因此设置页路由、Agent 设置工具、`runtime.updateSettings` 三条路径自动全覆盖；加新的设置写入路径时走 `emitSettingsChanged` 即可，别新增回调。
4. **`.mts` 里的泛型箭头必须写 `<T,>`**（`<T>` 会报 TS7060）。
5. `forkServerProcess` 用 `<ignore,pipe,pipe>` 把子进程 stdout/stderr 折进有界 `runtime-log.jsonl`；`NAMI_MAIL_SERVER_HOST_AUTOSTART=1` 是入口自启闸门（测试里不能设该变量，否则 import `server-host.mts` 会真的起服务）。
6. 关闭/更新安装/启动失败三条路径统一 `stopLocalServerProcess()`，用 `serverProcessExpectedExit` 区分正常退出与崩溃。

验证口径：四 workspace typecheck 全绿；desktop **193**（+14）；server 793/795（2 条既有 `app.test.ts` settings 预存失败）；`npm run smoke:desktop` 全绿。
**打包验证（关键）**：`package:win` 的 `smoke-installer` 在本机会因"已存在 com.nami.mail 安装"按设计拒绝；改用 `$env:NAMI_MAIL_DESKTOP_EXECUTABLE="release-artifacts/0.3.0/win-unpacked/Nami Mail.exe"; node scripts/smoke-desktop.mjs` 直接跑打包版冒烟 → 全绿，**证明 asar 内 `utilityProcess.fork` 可用**。
未做：`main.mts` 托盘/关闭流程/窗口外壳/Agent 配对四块拆分；`styles.css`（16906 行）；`server/agent-service.ts`（3072 行）。
