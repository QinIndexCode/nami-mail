# 路线图（Roadmap）

本文档记录已规划但尚未排期（backlog）的功能。已排期的功能请以 CHANGELOG 的 [Unreleased] 区块为准。

## 图片上传 / 多模态（vision）支持

**状态**：已确认需求，未排期。不建议在 0.3.0 发布周期内实现（跨层改动大，且非核心邮件场景刚需）。

**目标**：用户在写邮件/Agent 对话中可上传图片，模型以视觉方式理解（如分析截图、发票、扫描件），并可结合图片起草回复。

**关键设计要点**（来自前期调研）：

- **vision 判定**：采用**显式开关**——模型配置（ProviderConfiguration）新增 `vision: boolean`，用户在新增/编辑模型时勾选"多模态模型"后才允许上传图片。不做模型名自动探测（不可靠）。
- **契约扩展（最小侵入）**：
  - `ProviderChatMessage` 新增可选 `images?: string[]`（base64 data URL），`content` 字符串保持不变 → 历史消息完全兼容。
  - `providerCapabilitiesSchema` 新增 `vision: boolean`。
- **各 provider 适配器转换**：
  | 适配器 | 转换目标 |
  |---|---|
  | OpenAI Responses | `input_image: { image_url }` |
  | OpenAI Chat Completions | `image_url` content part |
  | Gemini | `inline_data: { mime_type, data }` |
  | Anthropic | `image` source part |
- **前端**：`fileProcessor` 支持图片（读取 → 压缩 ≤1.5MB → base64 data URL）；composer 附件按钮在 vision 模型下可选图并显示缩略图；已附图片在消息气泡中展示。
- **限制**：单张 ≤1.5MB（压缩后）、每次 ≤4 张。
- **隐私**：图片 base64 会发送给云端模型，属于外部泄露范畴，需沿用现有门控/用户明确意图确认。
- **实施顺序建议**：先支持 OpenAI-compatible + Gemini（图片 API 最标准），Anthropic/Responses 后补，降低首轮风险。

## 错误日志落盘（feedback 支持日志粘贴的前提）

**状态**：未排期。当前桌面端日志（pino）仅输出到控制台，不落盘。文件上传失败等反馈引导目前采用"问题描述 + 截图 + 复现步骤"；若实现日志落盘（写入用户数据目录、限制大小/轮转、前端可查看/复制），反馈引导可升级为"粘贴错误日志"。

## 阅读区 AI 快捷入口（AI 总结 / AI 起草回复）

**状态**：已确认需求与形态，未排期（2026-09-10 完成方案评估）。

**目标**：阅读邮件时一键让 Agent 处理当前邮件，落进 Agent 工作台时**引用已挂好、指令已填好**。

**形态结论**（评估后刻意偏离"发一条模板用户信息"的直觉做法）：

- **复用结构化引用，不用模板句**：`currentMessage` → 引用 chip → 请求体 `references` 字段 → 服务端 `[REFERENCED MAIL n]` 注入（`agent-service.ts` 的 `referenceBlockFor`）。模板句会把结构化信息降级成自然语言，随语言/模型漂移。
- **复用既有 slash 命令**：总结用 `/summary`，起草回复用 `/draft`（`packages/agent-contracts/src/agent-commands.ts`），不新增需要维护的提示词文案。
- **总结可自动发送，起草回复只预填**：`mail.summarize` / `messages.get` 是只读工具、无确认卡，点击"AI 总结"本身即授权；`/draft` 产出草稿，发信走另一条确认链路（`AgentConfirmationCard`，默认 `send-confirmed`），自动发送会越过用户审阅这一步。
- **入口不平铺**：阅读工具栏已有 11 个控件且 ≤620px 窄窗吃紧，因此升级现有通用 `agent-launch-button`（`App.tsx`）为语义化的"AI 总结"，"AI 起草回复"放进既有"更多"菜单。
- **落地前置**：阅读区内联在 3818 行的 `App.tsx` 且无独立测试，需先把「意图 → 预置文本 / 是否自动发送」抽成纯函数并单测（照 `slashMenu.ts` / `contextMenu.ts` 模式），再接线。
- **缺口**：`AgentWorkspace` 目前无 `initialPrompt` / 自动发送 intent 能力（只能种引用 chip），需新增 prop。
- **约束**：新增文案必须同步 `zh-CN.json` + `en-US.json`（CI 的 `build-locale-catalog --check` 强制）。

## 界面与体验优化（2026-09-10 审计产出，分批推进）

**状态**：已确认方向，第一批已排（见下方候选）。

> **规则已文档化**：视觉基线见 [设计规范](DESIGN-SYSTEM.zh-CN.md)（阅读字宽、圆角、阴影、字号、行高、配色饱和度、交互五态、
> 收敛清单）。新增或修改样式前先读该文档；需要新增档位时同步更新它。

**已完成（2026-09-10，Batch Y/Z/AA）**：日历六色 token 化并补深色覆盖；半径 token 化（`var(--radius-*)` 引用 2 → 约 179 处，数值零变更，
并补掉 3 处漏网字面量）；阅读区五个居中块统一 `--measure:672px`（原 820px，约 95–100 字符/行缩到约 72）；正文行高 1.85 → 1.7；
补齐孤儿类名 `.sync-progress-banner` 样式；**对比度基线**：按 WCAG 4.5:1 修掉两个浅色 token（`--text-faint` `#727279`→`#66666c`、
`--warning` `#b67816`→`#9a6510`）；**可执行基线落成**（`themeContrast.test.ts` 8 条 + `designTokens.test.ts` 10 条，后者含债务棘轮，
只许下降，并阻止新增越界值）。

**视觉一致性**（`apps/web/src/styles.css` 16,900 行审计结论）：

- ~~硬编码颜色绕过 token：日历色板 6 色未 token 化且深色主题无覆盖~~ **已完成**（Batch Y）。
- ~~半径碎片化：至少 15 个不同值，而 token 只定义 `--radius-sm/md/lg`~~ **已完成数值归一与 token 化**（Batch Y/Z：`var(--radius-*)` 引用 2 → 约 179 处）；越界值仍以棘轮预算约束，待并档。
- ~~阴影硬编码：一次性高度阴影跨层级混用~~ **已完成**（Batch AC）：25 处候选里 12 处折进 `--shadow-raised`/`--shadow-sm`，另删 2 条多余深色覆盖；**高度阴影字面量现为 0**（余 18 处状态光晕 + 2 处原生滑杆细节，均属文档化豁免类别）。
- 字号碎片化：约 13 个值（含 `11.5px` 小数）且大量 <12px。
- 间距偏离 4px 栅格：最突出是 `7px` / `9px`（合计 100+ 处）。
- 32 处 `!important` 中约 6 处冗余；42 处 `outline:none` 需逐条确认有 focus ring 配对。
- **孤儿类名**：`sync-progress-banner` 在 `App.tsx` 使用但样式文件中完全无对应规则。
- 已有良好基础：`prefers-reduced-motion` 覆盖 9 处、`:focus-visible` 56 处、tone 色已在深色下覆盖。

**性能**（审计结论，按收益/工作量排序的上位项）：

- 列表接口对每页返回完整 `htmlBody`，IPC 体积大（详情正文随列表一起传）。
- `/api/stats` 每 60s 轮询做全表 `SUM(CASE ...)`，且 `flags_json LIKE '%\Seen%'` 不可走索引；`messages` 缺 `flags_json` 派生列索引。
- 列表排序用 `ORDER BY COALESCE(sent_at, created_at)` 表达式，无法用 `idx_messages_sent_at`；分页为 `LIMIT/OFFSET` 深分页。
- 每请求重复 `db.prepare(...)`，无语句缓存。
- `App.tsx` 首屏已并行（`Promise.all`），无需改动。

## 其他 backlog 候选（来自 0.3.0 前端调研，未排期）

- Compose 富文本（Markdown 工具栏或 contentEditable + GFM 预览）。
- Compose 全屏/放大编辑模式。
- 窄窗口下设置页的分组跳转导航（当前 ≤760px 时左侧导航隐藏）。
- 邮件列表行内快速操作的触屏/键盘可达性改进。

> 勘误（2026-09-09）：原列在此处的「收件人建议的完整键盘导航（方向键 + Enter 确认）」
> 已随键盘可达性批次完成——ComposeModal 收件人建议具备完整 combobox 语义与
> 方向键/Enter 交互（见 `ComposeModal.test.tsx`），故从 backlog 移除。
