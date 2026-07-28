# NamiMail CLI

[English](README.en.md) | [安装](installation.md) | [命令](commands.md) | [输出](output-schema.md) | [权限](permissions.md) | [示例](examples.md) | [排错](troubleshooting.md)

> **当前构建状态：不可执行。** 此 Windows 构建没有随附可验证的 Windows SID-DACL 命名管道原生适配器。因此不会启动外部 AgentHost 或 Broker，也不提供 `namimail` 可执行文件、PATH shim 或客户端配对界面。本文的命令、输出、权限和示例是未来发布的安全契约；请勿在当前构建中配置或执行它们。实验性的本地 NLLB-200 翻译仍独立保留，只能由用户在界面中主动、可选使用。

NamiMail CLI 文档定义 Windows 桌面应用未来的本机自动化契约。该接口计划面向脚本和本地 Agent，外部调用固定为只读。

未来接口不得读取 SQLite、持有 DPAPI 解封后的主密钥、复用浏览器渲染器令牌，也不得提供 loopback HTTP/TCP 降级通道。适配器发布后，除本地 `version` 外，每个请求都必须经由已配对的、仅当前 Windows 用户 SID 可访问的命名管道 Broker 到达正在运行的 `AgentHost`。

## 文档范围

| 主题 | 说明 |
| --- | --- |
| [安装](installation.md) | Windows 安装、显式启动宿主和配对前提。 |
| [命令](commands.md) | v1 命令表，以及被明确拒绝的写命令。 |
| [参数](parameters.md) | 公共参数、类型和解析规则。 |
| [输出](output-schema.md) | 稳定 JSON 包络、JSONL、错误和退出码。 |
| [权限](permissions.md) | scope、账户范围、确认和审计边界。 |
| [外部 Agent 接入](agent-integration.md) | 面向脚本、IDE Agent 和自动化的调用规则。 |
| [示例](examples.md) | 可复制的只读工作流。 |
| [排错](troubleshooting.md) | 宿主、更新、配对和网络/Provider 问题。 |

## v1 边界

- 当前发行目标是 Windows；文档不承诺 macOS 或 Linux CLI 支持。
- `namimail service start` 和 `namimail mcp start` 是预留的未来命令名；当前构建不随附命令或服务模式，不能执行。
- 原生适配器经过验证并随安装包发布后，`service start` 才会是唯一允许显式启动无界面 AgentHost 的生命周期命令，`mcp start` 才会提供仍要求已启动且已配对宿主的 stdio 桥接。
- 发送、回复、转发、删除、移动、归档、修改邮件状态、创建或改写草稿、重建索引等写操作不能由外部 CLI 完成。`--yes` 不会改变这一规则。
- 实验性的本地 NLLB-200 翻译功能保持独立、主动触发且默认不自动翻译；它不是 CLI Agent Provider，也不会因启用 CLI 而向任何云端发送邮件内容。

协议版本、命令版本和应用版本会分别出现在响应中。调用方应以 `protocolVersion`、`success` 和稳定错误 `code` 处理结果，而不是匹配人类可读文本。
