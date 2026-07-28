# Agent 运行时

[简体中文](runtime.md) | [English](runtime.en.md)

> **当前构建状态：外部 Agent 运行时不可启动。** 当前 Windows 构建没有可验证的 SID-DACL 命名管道原生适配器，因此不会提供外部 AgentHost、Broker、CLI、服务模式、配对界面或 MCP 启动器。以下运行时顺序是未来发布的失败关闭契约，不是当前可执行流程。实验性的本地 NLLB-200 翻译保持独立、主动和可选。

不要把外部 Agent 运行时与常规桌面/服务器运行时混为一谈。当前常规运行时会创建并启动嵌入式 `AgentService`；本地 Fastify GUI API、RAG 工作者和 React 工作区都在该路径中使用。它不是外部 IPC，也尚未完成打包桌面版、真实账户/Provider、删除与重建生命周期和安全确认流的发布级验证。

## 责任

运行时把 Provider、工具、权限、来源和审计组合为一条受控执行链。它不拥有另一套 IMAP、SMTP、草稿或数据库实现，所有邮件写入必须复用既有邮件服务的幂等提交与“已发送”核对语义。

发布后的外部 `AgentHost` 将是生产唯一拥有者。当前桌面 GUI 所使用的本地 Fastify 服务会运行嵌入式 Agent，但它不是外部 Agent IPC，也不会授权 CLI/MCP 使用其令牌或数据库。

## 未来启动顺序（当前构建不会执行）

1. Electron 确认单实例并获得当前用户 SID。
2. 创建带 SID DACL 的独占命名管道租约；未验证适配器即失败关闭。
3. `AgentHost` 解封主密钥，打开 SQLite，并执行兼容的 Agent schema 迁移。
4. 以同一宿主创建同步、来源事件、RAG、Provider、审计与确认依赖。
5. 启动 GUI Adapter 和配对 Broker，之后才接收请求。

任一步失败都必须停止已启动部件、清零内存中的密钥副本，并且不暴露半启动的 Broker。当前构建在此流程之前结束；未来普通 CLI 命令不会启动 Runtime，只有显式 `service start` 才可请求桌面宿主启动服务模式。

## 请求与流

一次聊天请求应生成连续递增的事件序列：`queued`、模型文本增量、工具调用/结果、来源、确认、用量、错误和终止事件。客户端可断开或请求取消；取消通过 `AbortSignal` 传递给 Provider 和工具，终止事件仍需可解释。

Runtime 在调用工具前执行三件事：

1. 解析并校验工具描述符和参数。
2. 根据 `CallerContext`、账户范围和确认策略计算默认拒绝的权限决策。
3. 对高风险行为先写入持久审计意图；缺少可用审计存储即拒绝执行。

当前 `AgentRuntime`、流事件 schema、工具注册、Provider health check、HTTP GUI 路由、实际邮件工具和嵌入式工作区均有源码实现或独立测试。它们仍不能仅凭源码或单测宣称已交付：同一构建必须完成打包桌面版 smoke、真实账户/Provider、删除与重建以及确认流验证。

## Provider 调用

Provider 接收经过范围过滤的消息，而非完整邮件库。每个请求受超时、取消、响应帧和工具参数大小限制。网络、TLS、认证、限流和服务端错误需映射为稳定的 Agent 错误，而不得改变本地邮件状态。

云端内容外发需要独立的、可见的用户同意。该同意不是 API key 存在、CLI 参数或模型输出的推断结果。无 Provider、未同意或 Provider 健康检查失败时，UI 应保留会话并给出可恢复提示。

## 未来更新排空

更新前闸门同步关闭新入口，等待已有 permit 释放，再依次停止 Broker、静默 Runtime/数据库和释放租约。闸门没有 TTL；只有成功安装器交接或显式恢复能改变排空状态。失败恢复也失败时保持关闭，而不是重新接受请求。

## 运行时不变量

- Runtime 不将模型输出视为授权。
- 当前构建不存在外部 CLI/MCP 路径；未来也不得存在 CLI/MCP 直连 SQLite、Fastify token 或 SMTP 的路径。
- 同一账户的删除代际变化后，旧任务不能提交新页面、工具结果或确认。
- `unknown_delivery` 与 Sent-folder 核对由既有发件路径决定，Agent 不得猜测“已发送”。

参见 [权限与确认](permissions.md)、[RAG 一致性](../rag/consistency.md) 和 [测试计划](../development/testing-plan.md)。
