# NamiMail MCP Server

[English](README.en.md) | [安装](installation.zh-CN.md) | [配置](configuration.zh-CN.md) | [工具](tools.zh-CN.md) | [输出](output-schema.zh-CN.md) | [安全](security.zh-CN.md) | [排错](troubleshooting.zh-CN.md)

> **当前构建状态：可用。** 0.3.0 安装包随附受管理的 `namimail` 命令和 PATH shim，桌面主进程运行已配对的 SID-DACL 命名管道 Broker 并路由 MCP stdio 会话。安装器 smoke 测试会通过 `cmd.exe` 启动 `namimail mcp start`，执行 MCP 初始化，并验证 `tools/list` 恰好返回十五个工具（八个只读 + 七个写，写工具带相应 annotations）。数据工具需要正在运行、已配对的 Agent 宿主。实验性的本地 NLLB-200 翻译仍独立、主动触发，且不属于 MCP。

NamiMail MCP Server 文档定义支持 MCP stdio 的本地开发工具和 Agent 如何安全读取已授权邮件数据。它是桌面 `AgentHost` 的受配对 Broker 适配器，而不是独立邮件服务。

## v1 承诺

- Transport 仅可为本地 `stdio -> 已配对的 SID-DACL Windows 命名管道 Broker`。
- MCP 进程绝不打开 SQLite、邮件数据目录、DPAPI 主密钥或渲染器 Fastify token。
- 不存在 HTTP、Streamable HTTP、TCP、文件 URI 或 loopback 降级通道。
- 外部 MCP 访问级别默认 `read-only`，可在桌面应用设置中独立配置为三档（`read-only` / `send-confirmed` / `full-access`）。`send-confirmed` 档的写操作每次在可见 NamiMail UI 中确认；`full-access` 档在已批准账户范围内自动执行。详见[安全](security.zh-CN.md)与[工具](tools.zh-CN.md)。
- 实验性的本地 NLLB-200 翻译保持独立、主动触发；它不是 MCP 工具，也不会因 MCP 启动而自动处理邮件。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [安装](installation.zh-CN.md) | 安装器前提：宿主、PATH、启动和配对。 |
| [配置](configuration.zh-CN.md) | 可粘贴的本地 MCP stdio 配置及版本协商。 |
| [工具](tools.zh-CN.md) | v1 工具名（只读 + 写）、输入/输出契约和权限。 |
| [输出 Schema](output-schema.zh-CN.md) | MCP 包装与稳定 NamiMail Agent 错误。 |
| [资源](resources.zh-CN.md) | 为什么 v1 不暴露邮件 Resource。 |
| [安全](security.zh-CN.md) | 配对、scope、未信任邮件、审计和隐私。 |
| [示例](examples.zh-CN.md) | 典型 MCP 客户端调用。 |
| [排错](troubleshooting.zh-CN.md) | 启动、stdio、配对和权限恢复。 |

`tools/list` 是宿主可用性和完整 JSON Schema 的唯一权威。客户端不得从本文件、CLI 参数或旧缓存推断未列出的工具。
