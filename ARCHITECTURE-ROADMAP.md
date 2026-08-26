# 架构与优化路线图（ARCHITECTURE ROADMAP）

> 本文件是 Nami Mail 的持续推进计划，供新的 ZCode 会话续接工作。
> 最后更新：2026-08-21。每项完成一个批次后同步更新本文件与下方「交付记录」。
> 交付分支固定为 `backup/backgrounds-baseline`，**绝不 push main**。

## 0. 当前基线（2026-08-21）

- 测试：web 628 / server 766 / desktop 135 / contracts 26，四 workspace typecheck 全绿，e2e 三套（smoke / interactions / update-footer）。全量回归 67+94+1+1 测试文件一次通过；server 端 `agent-service-rag.test.ts` 一条用例在并行负载下偶发 5s 超时（单跑稳定通过，与前端改动无关）。
- 最近交付：Batch P「功能缺口 1 收线：键盘可达性高优先 4 项 + ComposeModal 同类缺口」（commit `0049ef8`）——附件预览焦点 restore（P1）；`.mail-title h2` 焦点环拆分 `:focus-visible`（P2）；slash/mention 菜单 aria-activedescendant + option id + 滚动跟随（P3）；ComposeModal To 建议成完整 combobox（expanded/controls/activedescendant + 方向键 + Enter 应用，P4a）与模板选择器 menu-button 三件套（expanded/controls/haspopup + option id，P4b）；shift+J/K 隐式扩选——`DialogKeydownSnapshot.keyboardSelectionAnchorId` + `select_range` action + App 锚点 ref（P5，非 shift 路径逐字不变）；多选行 aria-pressed + shift+click 范围选择补回归测试（P6）。本批 +19 条测试（628 = 609 + 19），仓库首个焦点管理断言（AttachmentPreviewModal.focus.test.tsx）与首个 ComposeModal 交互测试（ComposeModal.test.tsx）。
- 已取消：图标专属动画（用户拍板成本 > 价值，含 back-arrow hover 动画，勿再提议）。
- 源码零 TODO/FIXME/HACK 残留；零 console.log（测试文件内两处无害）；styles.css 内 53 处 `!important`、22 处组件内联样式。

## 1. 架构候选（来自 2026-08-20 走查报告，候选 1、2、6 已完成）

### 候选 2：折叠 App shell（Strong，已完成）

- 证据：`apps/web/src/App.tsx` 4138 行（现约 3890 行）；SSE 客户端、账户健康推导、轮询、弹窗路由、compose 全内联。
- 进度（Batch N）：健康推导 + banner + 三纯函数 → `accountHealth.tsx`；SSE + 轮询（共享 lastSseEventAtRef，必须同模块）→ `realtimeSync.ts`。
- 进度（Batch O）：弹窗路由 → `dialogRouting.ts`——`dialogKeydownDecision`（键盘决策纯函数，被 App 真正消费）+ `useDialogRouting`（状态 + actions + 三哨兵）；键盘门控测试从零补齐 64 条（含装配等价测试：App effect 骨架 feed snapshot → 决策 → 执行 action 断言状态迁移）。剩：reader 域（snoozeOpen/readerMoreOpen/recipientDetailsOpen/closeReader 链）、列表域（filterPanelOpen/searchOpen）、useDialogFocus、agent 工作区路由（候选 B，两阶段状态机与 settings/preloadedAgentBootstrap 交叉耦合）未抽——留待候选 3 前后另批。

### 候选 3：深化 AgentWorkspace 核心：会话状态机（Strong，投入最大）

- 证据：`apps/web/src/AgentWorkspace.tsx` 4429 行、148 个 hook 调用点；流累积 / 状态机 / composer 草稿 / chips / selection bar 全内联；测试靠 1127 行重型 harness（AgentWorkspace.integration.test.tsx）。
- 方案：`useAgentSession` 深 module——流状态机（running / completed / error…）与派生 UI 状态分离。

### 候选 4：契约化 mail DTO 面（Worth exploring，候选 1 的姊妹篇，机械性低风险）

- 证据：`apps/web/src/types.ts`（439 行）手写镜像 server `publicAccount` 等 DTO；`apps/web/src/api.ts` 直接消费。
- 方案：仿 ui-stream.ts 模式，把跨 seam 的 mail DTO 收进 schema 权威（wire 格式不变）。

### 候选 5：给 app.ts 一根脊柱（Worth exploring）

- 证据：`apps/server/src/app.ts` 3510 行、46 条路由 + 4 个 queue runner（move/batch/flags）；`operation-queue.ts`（64 行 interface + runner map）是深 module 范本，但 snooze/outbox 未走同等 seam，走 scheduled-send/outbox 各自路径。
- 方案：给 snooze/outbox 补同等 queue seam。

### 候选 6：账户健康收拢为一个 module（已完成，Batch N）

- 证据：同一概念三个推导点——`errorPresentation.ts` 的 `accountHealthIssue`（规则引擎本体，测试已锚定，原地保留）、App.tsx 的 issues Map + healthFingerprint banner、AccountsDialog.tsx 行内重推。
- 完成：聚合层（buildAccountIssues / accountHealthFingerprint / useAccountHealth，含「集合变化才响一次」语义）+ AccountHealthBanner + accountStatusDotClass / accountShowsFreshness 全部收进 `apps/web/src/accountHealth.tsx`；App 只剩两个渲染消费点。AccountsDialog.tsx 的第三推导点低风险，暂未收（下批可顺手）。

### 候选 7：继续削薄桌面 main.mts（Speculative，建议不做）

- 证据：`apps/desktop/src/main.mts` 1976 行；窗口栏 / 托盘 / 更新接线 / 协议注册 / 服务拉起。提取模式已在 Batch F（commit 9367c3a，desktop-smoke.mts 净删 769 行）验证。
- 判断：桌面壳再薄边际收益低。

**推荐顺序**：候选 2+6 已完成 → 键盘可达性（功能缺口 1，高优先 4 个纯补丁项）→ 候选 4 → 候选 3（单独成批）。

## 2. 功能缺口

1. **键盘可达性**（✅ 高优先 4 项已于 Batch P 完成，commit `0049ef8`；两组实现勘误已固化：① `.mail-title h2` 的 outline:none 系初版就有、非被删，缺口是无 `:focus-visible` 配对；② 邮件列表 shift+click 范围多选**已实现**（MessageList.tsx + App.selectMessageRange）且零测试，Batch P 补了键盘半边（shift+J/K）与 shift+click 回归测试。设计决策：模板选择器触发器是普通 button 非 combobox，按 menu-button 模式宣告（aria-expanded/controls/haspopup），`aria-activedescendant` 不适用于 button 故未挂）：
   - ✅ 高：附件预览关闭后焦点 restore（AttachmentPreviewModal 开/关沿判定 + rAF，语义照抄 useDialogFocus）；slash/mention 菜单 aria-activedescendant + option id + ArrowDown/Up scrollIntoView；键盘范围多选 shift+J/K（snapshot 锚点 + select_range 决策，非 shift 路径零变化）；`.mail-title h2` 焦点环（`focus:not(:focus-visible)` 保指针无环 + `focus-visible` 复用全局环语言）。
   - ✅ 高（同批追加）：ComposeModal To 联系人建议补全 combobox 语义（aria-autocomplete/expanded/controls/activedescendant + 方向键导航 + Enter 应用防误提交表单）+ 模板选择器展开态三件套 + option id。
   - 中：约 10 处 `tabIndex={-1}` agent-provider help 按钮成键盘黑洞；三个搜索输入框 outline:none 无配对焦点样式；对话列表无方向键导航。
   - 低：对话行 `aria-pressed` 宜改 role="checkbox"（用户拍板保留 button 语义，勿再提）；ThemedSelect 缺 listbox 语义；虚拟列表 tab 序随滚动漂移。
   - 焦点管理测试从 Batch P 起有锚定（AttachmentPreviewModal.focus.test.tsx 2 条），但覆盖仍薄、无键盘 e2e——后续键盘工作继续补。键盘门控逻辑本体已于 Batch O 补 64 条单测锚定。
2. **桌面同步上限默认 200**：桌面 spawn 时 `SYNC_MESSAGE_LIMIT` 默认 200（见 sync-message-limit-diagnosis 记忆），用户会"少收 200 封邮件"；Batch L 已补警告链（last_sync_warning_code + 三态圆点），默认值本身仍是 footgun。评估是否把桌面默认提到与 UI 默认一致（2000）或明确文档化。
3. **e2e 覆盖薄**：只有三套 spec，邮件主链路（同步、写信发送回环）无端到端自动化。

## 3. 样式 / 工程债

- 无 Tailwind，单文件 `styles.css` 实为 **16755 行**（原记录 3700 有误，2026-08-21 探索勘误）+ 53 处 `!important`——CSS 是第二个单体；各功能区段落（壳层 / banner / 弹窗皮肤 / status-dot）已内聚，拆分是机械搬迁，另立批次。
- lucide-react 停在 1.28（Batch H2 教训：新图标不存在需先验证）；依赖升级是欠账。
- main 从未合入，全部交付在 backup 分支——流程未收尾。
- 两个一次性坑：wiki 首次需手动建页；electron-builder 从根 package.json 收集依赖（新增运行时依赖需同步根清单并抽查 asar）。

## 4. 每批交付流程（既定约束，必须遵守）

1. 用 Write/Edit 改代码（Mimosa PreToolUse 会拦截 Bash 直接写 src 文件；`git commit -m` 用 heredoc 可行）。
2. 全量回归 + typecheck：web / server / desktop / contracts 全绿；locale catalog 0 missing。
3. Mimosa deep scan（`security_scan_start`，project=仓库根，depth=deep，focusFiles=本批改动文件）→ 轮询 `security_scan_status` 至 completed → 取 seal 写入 commit body。
4. 单 commit；seal 格式：`Mimosa seal: sha256:… scan-…（N findings 全 inconclusive；P packages，0 advisories）`。
5. 只 push `origin backup/backgrounds-baseline`；commit/push hook 永远回报 `scanner_no_output`（compat fallback：记录 seal，**不宣称安全**）。
6. 完成一批后更新：本文件 + 记忆（feature-batch-progress）。

## 5. 交付记录

- Batch A–K：功能批次（mailto 闭环、搜索深化、批量导出、右键菜单、提升批次、自动更新按钮、main.mts smoke 拆分、docs→Wiki 同步、图标一图一义、文件夹图标各归其位、撤回/重复修复、/@ 引用 + scope 两档化）。
- Batch L：同步消息上限警告链（commit b70b0d5）。
- Batch M：流事件词汇契约化（commit 13f205d，候选 1 完成）。
- Batch N：候选 2 部分 + 候选 6——realtimeSync.ts（SSE+轮询）+ accountHealth.tsx（健康收拢）+ submissionStatusNeedsRefresh 迁移（commit 347baaf；web 521→545）。
- Batch O：候选 2 收尾——dialogRouting.ts（dialogKeydownDecision + useDialogRouting）+ App.tsx keydown 决策-执行两段式改造 + AccountsDialog status-dot 收拢 + 键盘门控测试从零补齐 64 条（commit 1ebdcc3；web 545→609，候选 2 完成）。
- Batch P：功能缺口 1「键盘可达性」高优先 4 项 + ComposeModal 同类缺口（attachment 焦点 restore / `.mail-title h2` 焦点环 / slash·mention aria-activedescendant + scrollIntoView / ComposeModal 联系人建议 combobox 三件套 + 模板选择器 menu-button / shift+J·K 隐式扩选键盘范围多选 / 多选行 aria-pressed + shift+click 回归）——仓库首个焦点断言（AttachmentPreviewModal.focus.test.tsx）与首个 ComposeModal 交互测试（commit 0049ef8；web 609→628，功能缺口 1 高优先项完成；Mimosa seal `sha256:1093b081…` 入 commit body，395 findings 全 inconclusive）。