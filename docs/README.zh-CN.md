# 文档导航

[English](README.en.md) | [简体中文](README.zh-CN.md)

Nami Mail 当前发布 Windows x64 桌面版。本页按任务整理公开文档；界面语言包和文档翻译的维护规则见[本地化说明](LOCALIZATION.zh-CN.md)。

> **External Mail v1：已配对、本机、只读。** CLI 和 MCP 通过仅当前 Windows 用户可访问的 Broker 访问 Nami Mail；它们不复用本机 Fastify token，不提供 HTTP/SQLite 回退，也不会写入邮件。可选的免费翻译和 AI 翻译保持独立，仅可在界面中主动、可选使用。

## 使用 Nami Mail

- [Windows 安装与更新指南](INSTALLING.zh-CN.md)：从可信来源下载、安装、更新、卸载和 SmartScreen 处理。
- [邮箱接入指南](EMAIL-PROVIDERS.zh-CN.md)：OAuth、应用专用密码、手动 IMAP/SMTP 与连接排障。
- [邮件正文翻译](TRANSLATION.zh-CN.md)：可选免费翻译和 AI 翻译的配置、主动发送边界和隐私注意事项。
- [本机 Mail API 契约](LOCAL-API.zh-CN.md)：桌面界面与本机服务的受保护协议、翻译状态和模型准备接口；不是公开网络 API。
- [外部 Mail 接口](EXTERNAL-MAIL-INTERFACE.zh-CN.md)：配对、撤销、八项只读工具、安全边界和恢复方式。
- [NamiMail Agent 使用指南](agent/usage.zh-CN.md)：对话管理、邮件范围、来源引用与确认流程。
- [NamiMail Agent 模型提供商配置](agent/providers.zh-CN.md)：OpenAI 兼容/Ollama/Claude/Gemini 模型、密钥与云端邮件内容授权。
- [NamiMail Agent 接入外部 MCP 服务器](agent/mcp-servers.zh-CN.md)：接入外部 MCP 服务器扩展助理工具。
- [NamiMail Agent 架构](agent/architecture.zh-CN.md)：本地优先的 Agent 设计、嵌入式工作区与外部 Broker 边界。
- [邮件 RAG](rag/architecture.zh-CN.md)：邮件入库、清洗、检索、删除同步与一致性说明。
- [CLI 参考](cli/README.zh-CN.md)：`namimail` CLI 的命令、参数、输出格式和示例。
- [MCP Server](mcp/README.zh-CN.md)：本机 MCP stdio 接入、工具发现和安全边界。
- [隐私与本地数据说明](PRIVACY.zh-CN.md)：本地数据、加密边界和第三方连接。
- [支持指南](../SUPPORT.zh-CN.md)：可公开提交的问题、脱敏要求和支持边界。
- [安全策略](../SECURITY.zh-CN.md)：私下报告安全问题的唯一公开入口。
- [Release Notes](releases/README.zh-CN.md)：面向用户的版本说明和已知限制。

## 参与开发

- [贡献指南](../CONTRIBUTING.zh-CN.md)：本地开发、测试、Pull Request 和审查要求。
- [社区行为准则](../CODE_OF_CONDUCT.zh-CN.md)：协作和报告行为问题的规则。
- [开发说明](DEVELOPMENT.zh-CN.md)：运行模式、目录和验证基线。
- [架构与信任边界](ARCHITECTURE.zh-CN.md)：进程、数据和更新边界。
- [Windows 发布指南](RELEASING.zh-CN.md)：维护者的签名、Release 和真实更新验证步骤。
- [Agent 开发实施计划](development/implementation-plan.zh-CN.md)：模块职责、分期、验收与回滚边界。

## 语言与版本

- [本地化说明](LOCALIZATION.zh-CN.md)：新增界面语言 JSON 包和文档翻译的规则。
- [变更日志](../CHANGELOG.zh-CN.md)：中文权威版本历史，以及同步维护的[英文译文](../CHANGELOG.en.md)。
