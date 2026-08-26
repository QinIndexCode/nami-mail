# MCP 客户端配置

[English](configuration.en.md) | [安装](installation.zh-CN.md) | [示例](examples.zh-CN.md)

> **当前构建状态：请配置 MCP 客户端。** 0.3.0 安装包随附 `namimail` 命令和 PATH shim，`namimail mcp start` 针对已配对、正在运行的 Agent 宿主运行 MCP stdio 桥接。下面的 JSON 可粘贴到当前 IDE 或 MCP 客户端。

## 进程声明

MCP 客户端通过 `cmd.exe` 以受管理的子进程方式启动 `namimail mcp start`。客户端字段名可以是 `mcpServers`、`servers` 或图形配置项，但不能接受 `url`、`port`、`database`、`token`、`pipe`、邮箱凭据或 Provider API key。身份材料必须留在已配对 Broker 状态与客户端安全存储中。

```json
{
  "mcpServers": {
    "namimail": {
      "command": "cmd.exe",
      "args": ["/d", "/s", "/c", "namimail mcp start"]
    }
  }
}
```

## 启动顺序

1. 用户打开 NamiMail 或通过 `namimail service start` 显式请求 AgentHost，然后用 `namimail pair` 配对客户端 profile 并在可见窗口中批准。
2. MCP 客户端按上述命令启动 MCP stdio 子进程。
3. 客户端执行 MCP 初始化（协议版本 `2025-03-26` 或 `2025-06-18`，服务端回显客户端所请求的版本；serverInfo 名 `NamiMail`）和 `tools/list`。
4. stdio 适配器只连接已配对、当前用户 SID 限制的 Broker；Broker 构造 `mcp` 调用方上下文并只暴露允许的工具。

接口不得自动拉起服务、通过 HTTP 重试替代配对，或复用旧 schema、旧身份或已撤销的客户端状态。更新、账户范围变化和撤销后，客户端必须重新发现工具。

## 并发与超时要求

客户端可保持一个 MCP 子进程，并以 MCP SDK request ID 关联响应。超时后应取消本地等待并尊重后续 `CANCELLED` 或 `UPDATE_IN_PROGRESS` 结果；不得重放同一已签名 Broker 帧。可重试错误只能使用有限退避。
