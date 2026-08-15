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

## 其他 backlog 候选（来自 0.3.0 前端调研，未排期）

- Compose 富文本（Markdown 工具栏或 contentEditable + GFM 预览）。
- Compose 全屏/放大编辑模式。
- 收件人建议的完整键盘导航（方向键 + Enter 确认）。
- 窄窗口下设置页的分组跳转导航（当前 ≤760px 时左侧导航隐藏）。
- 邮件列表行内快速操作的触屏/键盘可达性改进。
