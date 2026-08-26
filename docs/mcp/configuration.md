# MCP 客户端配置状态与未来契约

[English](configuration.en.md) | [安装](installation.md) | [示例](examples.md)

> **当前构建状态：不要配置 MCP 客户端。** 当前 Windows 构建没有 `namimail` 命令、PATH shim、MCP stdio 启动器、Broker 或配对 UI。下面的 JSON 形状和启动顺序仅用于定义验证过的 SID-DACL 原生适配器发布后的契约，不能粘贴到当前 IDE 或 MCP 客户端。

## 未来进程声明（不可执行）

发布后的 MCP 客户端将使用一个受管理的 `namimail` 子进程及预留的 `mcp start` 参数。客户端字段名可以是 `mcpServers`、`servers` 或图形配置项，但不会接受 `url`、`port`、`database`、`token`、`pipe`、邮箱凭据或 Provider API key。身份材料必须留在已配对 Broker 状态与客户端安全存储中。

## 未来启动顺序（不可执行）

1. 用户打开 NamiMail，或仅通过受支持的服务启动路径显式请求 AgentHost。
2. MCP 客户端启动预留的 MCP stdio 子进程。
3. 客户端执行 MCP 初始化与 `tools/list`。
4. 适配器只连接已配对、当前用户 SID 限制的 Broker；Broker 构造 `mcp` 调用方上下文并只暴露允许的工具。

发布后的接口仍不得自动拉起服务、通过 HTTP 重试替代配对，或复用旧 schema、旧身份或已撤销的客户端状态。更新、账户范围变化和撤销后，客户端必须重新发现工具。

## 未来并发与超时要求

客户端可保持一个 MCP 子进程，并以 MCP SDK request ID 关联响应。超时后应取消本地等待并尊重后续 `CANCELLED` 或 `UPDATE_IN_PROGRESS` 结果；不得重放同一已签名 Broker 帧。可重试错误只能使用有限退避。
