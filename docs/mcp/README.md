# NamiMail MCP Server

[English](README.en.md) | [安装](installation.md) | [配置](configuration.md) | [工具](tools.md) | [输出](output-schema.md) | [安全](security.md) | [排错](troubleshooting.md)

> **当前构建状态：不可执行。** 此 Windows 构建没有随附可验证的 Windows SID-DACL 命名管道原生适配器。因此不会启动外部 AgentHost 或 Broker，也不提供 `namimail` 可执行文件、PATH shim、客户端配对界面或 MCP stdio 启动器。本文的 MCP 配置、工具和 Schema 是未来发布的安全契约；请勿在当前构建中添加客户端配置或尝试启动它。实验性的本地 NLLB-200 翻译仍独立、主动触发，且不属于 MCP。

NamiMail MCP Server 文档定义未来接口如何让支持 MCP stdio 的本地开发工具和 Agent 安全读取已授权邮件数据。它计划作为桌面 `AgentHost` 的受配对 Broker 适配器，而不是独立邮件服务。

## v1 承诺

- 原生适配器发布后，Transport 仅可为本地 `stdio -> 已配对的 SID-DACL Windows 命名管道 Broker`。
- MCP 进程绝不打开 SQLite、邮件数据目录、DPAPI 主密钥或渲染器 Fastify token。
- 不存在 HTTP、Streamable HTTP、TCP、文件 URI 或 loopback 降级通道。
- 外部 MCP v1 只读。工具发现中只应出现获准的只读工具；写操作和高风险操作必须在 NamiMail 可见 UI 内经过一次性确认。
- 实验性的本地 NLLB-200 翻译保持独立、主动触发；它不是 MCP 工具，也不会因 MCP 启动而自动处理邮件。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [安装](installation.md) | 当前不可用说明，以及未来宿主、PATH、服务启动和配对前提。 |
| [配置](configuration.md) | 不可粘贴的未来本地 MCP stdio 配置及版本协商。 |
| [工具](tools.md) | 未来 v1 只读工具名、输入/输出契约和权限。 |
| [输出 Schema](output-schema.md) | 未来 MCP 包装与稳定 NamiMail Agent 错误。 |
| [资源](resources.md) | 为什么 v1 不暴露邮件 Resource。 |
| [安全](security.md) | 配对、scope、未信任邮件、审计和隐私。 |
| [示例](examples.md) | 典型 MCP 客户端调用。 |
| [排错](troubleshooting.md) | 启动、stdio、配对和权限恢复。 |

原生适配器发布后，`tools/list` 才会是宿主可用性和完整 JSON Schema 的唯一权威。客户端不得从本文件、CLI 参数或旧缓存推断未列出的工具。
