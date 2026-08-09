# NamiMail CLI

[English](README.en.md) | [安装](installation.zh-CN.md) | [命令](commands.zh-CN.md) | [输出](output-schema.zh-CN.md) | [权限](permissions.zh-CN.md) | [示例](examples.zh-CN.md) | [排错](troubleshooting.zh-CN.md)

> **当前构建状态：可用。** 0.3.0 安装包随附受管理的 `namimail` 可执行文件并注册当前用户 PATH shim。桌面主进程会启动受保护的 Windows 命名管道 Broker 并通过它路由 `--cli` 调用；安装器 smoke 测试还会验证安装后 MCP stdio 会话返回恰好十五个工具（八个只读 + 七个写）。数据命令需要正在运行且已配对的 Agent 宿主。实验性的本地 NLLB-200 翻译仍独立保留，只能由用户在界面中主动、可选使用。

NamiMail CLI 文档定义 Windows 桌面应用的当前本机自动化契约。外部调用默认只读；可在桌面设置中把 CLI 权限提升为"操作前确认"（`send-confirmed`）或"完全自动"（`full-access`），详见[权限](permissions.zh-CN.md)。

CLI 不会读取 SQLite、持有 DPAPI 解封后的主密钥、复用浏览器渲染器令牌，也不提供 loopback HTTP/TCP 降级通道。除本地 `version` 外，每个请求都必须经由已配对的、仅当前 Windows 用户 SID 可访问的命名管道 Broker 到达正在运行的 `AgentHost`。

## 文档范围

| 主题 | 说明 |
| --- | --- |
| [安装](installation.zh-CN.md) | Windows 安装、显式启动宿主和配对前提。 |
| [命令](commands.zh-CN.md) | 已实现的 v1 命令表，以及默认拒绝的写命令（仅当 CLI 权限为只读时）。 |
| [参数](parameters.zh-CN.md) | 公共参数、类型和解析规则。 |
| [输出](output-schema.zh-CN.md) | 稳定 JSON 包络、JSONL、错误和退出码。 |
| [权限](permissions.zh-CN.md) | scope、账户范围、确认和审计边界。 |
| [外部 Agent 接入](agent-integration.zh-CN.md) | 面向脚本、IDE Agent 和自动化的调用规则。 |
| [示例](examples.zh-CN.md) | 可复制的只读工作流。 |
| [排错](troubleshooting.zh-CN.md) | 宿主、更新、配对和网络/Provider 问题。 |

## v1 边界

- 当前发行目标是 Windows；文档不承诺 macOS 或 Linux CLI 支持。
- `namimail service start` 显式启动安装包中的无界面 AgentHost，`namimail mcp start` 启动 MCP stdio 桥接。两者在 0.3.0 构建中均已实现，都不会隐式启动 Runtime。
- 八个外部只读命令（`accounts list`、`folders list`、`messages list`、`mail summarize`、`messages get`、`messages batch-get`、`threads get`、`attachments list`）均已实现，需要已运行、已配对且具有已批准账户范围的宿主；CLI 默认档位为只读。
- 外部 CLI 默认只读；在桌面设置中把 CLI 权限提升为"操作前确认"（`send-confirmed`）或"完全自动"（`full-access`）后，7 个写命令（`draft create`、`draft update`、`draft delete`、`messages move`、`messages set-flag`、`messages send`、`mail reply`）可用。`--yes` 不能绕过确认——解析器对外部命令一律拒绝 `--yes`，任何档位都不接受。
- 实验性的本地 NLLB-200 翻译功能保持独立、主动触发且默认不自动翻译；它不是 CLI Agent Provider，也不会因启用 CLI 而向任何云端发送邮件内容。

协议版本、命令版本和应用版本会分别出现在响应中。调用方应以 `protocolVersion`、`success` 和稳定错误 `code` 处理结果，而不是匹配人类可读文本。
