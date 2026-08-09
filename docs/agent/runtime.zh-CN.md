# Agent 运行时

[简体中文](runtime.zh-CN.md) | [English](runtime.en.md)

> **当前构建状态：可用。** 0.3.0 安装包随附 `namimail` 命令、PATH shim、CLI、MCP stdio 子进程、Broker、服务模式和配对 UI。Broker 使用已配对的当前用户 SID-DACL Windows 命名管道；安装器 smoke 会验证打包后的 MCP stdio 路径（协议 `2025-03-26`、serverInfo `NamiMail`、恰好十五个工具：八个只读 + 七个写）。独立的无界面服务模式仍会以 `BROKER_SECURITY_UNAVAILABLE` 在打开 GUI、SQLite、主密钥或翻译模型之前失败关闭。实验性的本地 NLLB-200 翻译保持独立、主动和可选。

不要把外部 Agent 运行时与常规桌面/服务器运行时混为一谈。当前常规运行时会创建并启动嵌入式 `AgentService`；本地 Fastify GUI API、RAG 工作者和 React 工作区都在该路径中使用。它不是外部 IPC。打包桌面版 CLI/MCP 路径的发布级验证由安装器 smoke 覆盖；真实账户/Provider、删除与重建生命周期和安全确认流仍需实环境验证。

## 责任

运行时把 Provider、工具、权限、来源和审计组合为一条受控执行链。它不拥有另一套 IMAP、SMTP、草稿或数据库实现，所有邮件写入必须复用既有邮件服务的幂等提交与“已发送”核对语义。

外部 `AgentHost` 是外部入口的唯一所有者。当前桌面 GUI 所使用的本地 Fastify 服务会运行嵌入式 Agent，但它不是外部 Agent IPC，也不会授权 CLI/MCP 使用其令牌或数据库。

## 启动顺序（0.3.0 已执行）

1. Electron 确认单实例并获得当前用户 SID。
2. 创建带 SID DACL 的独占命名管道租约；无法验证适配器即失败关闭。
3. `AgentHost` 解封主密钥，打开 SQLite，并执行兼容的 Agent schema 迁移。
4. 以同一宿主创建同步、来源事件、RAG、Provider、审计与确认依赖。
5. 启动 GUI Adapter 和配对 Broker，之后才接收请求。

任一步失败都必须停止已启动部件、清零内存中的密钥副本，并且不暴露半启动的 Broker。0.3.0 的 GUI 宿主执行上述流程，安装器 smoke 会针对它演练打包 CLI/MCP 路径。普通 CLI 命令不会启动 Runtime，只有显式 `service start` 才请求桌面宿主进入独立服务模式；该模式当前仍会以 `BROKER_SECURITY_UNAVAILABLE` 在打开数据库或主密钥之前失败关闭。

## 请求与流

一次聊天请求应生成连续递增的事件序列：`queued`、模型文本增量、工具调用/结果、来源、确认、用量、错误和终止事件。客户端可断开或请求取消；取消通过 `AbortSignal` 传递给 Provider 和工具，终止事件仍需可解释。

Runtime 在调用工具前执行三件事：

1. 解析并校验工具描述符和参数。
2. 根据 `CallerContext`、账户范围和确认策略计算默认拒绝的权限决策。
3. 对高风险行为先写入持久审计意图；缺少可用审计存储即拒绝执行。

`AgentRuntime`、流事件 schema、工具注册、Provider health check、HTTP GUI 路由、实际邮件工具和嵌入式工作区均有源码实现或独立测试。源码与单测仍不能证明邮件路径已交付：真实账户/Provider、删除与重建以及确认流验证仍为必需。

## Provider 调用

Provider 接收经过范围过滤的消息，而非完整邮件库。每个请求受超时、取消、响应帧和工具参数大小限制。网络、TLS、认证、限流和服务端错误需映射为稳定的 Agent 错误，而不得改变本地邮件状态。

云端内容外发需要独立的、可见的用户同意。该同意不是 API key 存在、CLI 参数或模型输出的推断结果。无 Provider、未同意或 Provider 健康检查失败时，UI 应保留会话并给出可恢复提示。

## 更新排空

更新前闸门同步关闭新入口，等待已有 permit 释放，再依次停止 Broker、静默 Runtime/数据库和释放租约。闸门没有 TTL；只有成功安装器交接或显式恢复能改变排空状态。失败恢复也失败时保持关闭，而不是重新接受请求。

## 运行时不变量

- Runtime 不将模型输出视为授权。
- 外部 CLI/MCP 路径绝不直接打开 SQLite、复用 Fastify token 或发送 SMTP；它只能经已配对 Broker 到达宿主。
- 同一账户的删除代际变化后，旧任务不能提交新页面、工具结果或确认。
- `unknown_delivery` 与 Sent-folder 核对由既有发件路径决定，Agent 不得猜测“已发送”。

参见 [权限与确认](permissions.zh-CN.md)、[RAG 一致性](../rag/consistency.zh-CN.md) 和 [测试计划](../development/testing-plan.zh-CN.md)。
