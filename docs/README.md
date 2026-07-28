# 文档导航

[简体中文](README.md) | [English](README.en.md)

Nami Mail 当前发布 Windows x64 桌面版。本页按任务整理公开文档；界面语言包和文档翻译的维护规则见[本地化说明](LOCALIZATION.md)。

> **Agent 接口状态：当前不可执行。** 此构建未随附可验证的 Windows SID-DACL 命名管道原生适配器，因此不提供外部 AgentHost、Broker、`namimail` 命令、PATH shim、客户端配对界面或 MCP stdio 启动器。CLI、MCP 和 Agent 文档中的协议、Schema 与流程是未来发布的安全契约，不能在当前版本配置或运行。实验性的本地 NLLB-200 翻译保持独立，仍仅可在界面中主动、可选使用。

## 使用 Nami Mail

- [Windows 安装与更新指南](INSTALLING.md)：从可信来源下载、安装、更新、卸载和 SmartScreen 处理。
- [邮箱接入指南](EMAIL-PROVIDERS.md)：OAuth、应用专用密码、手动 IMAP/SMTP 与连接排障。
- [邮件正文翻译](TRANSLATION.md)：可选 LibreTranslate 兼容服务的配置、主动发送边界和隐私注意事项。
- [NamiMail Agent](agent/architecture.md)：本地优先的 Agent 设计、当前不可用边界与未来安全契约。
- [邮件 RAG](rag/architecture.md)：邮件入库、清洗、检索、删除同步与一致性说明。
- [CLI](cli/README.md)：未来的脚本和本地 Agent 只读契约；当前构建不可执行。
- [MCP Server](mcp/README.md)：未来的本地 MCP stdio 契约；当前构建不可配置或启动。
- [隐私与本地数据说明](PRIVACY.md)：本地数据、加密边界和第三方连接。
- [支持指南](../SUPPORT.md)：可公开提交的问题、脱敏要求和支持边界。
- [安全策略](../SECURITY.md)：私下报告安全问题的唯一公开入口。
- [Release Notes](releases/README.md)：面向用户的版本说明和已知限制。

## 参与开发

- [贡献指南](../CONTRIBUTING.md)：本地开发、测试、Pull Request 和审查要求。
- [社区行为准则](../CODE_OF_CONDUCT.md)：协作和报告行为问题的规则。
- [开发说明](DEVELOPMENT.md)：运行模式、目录和验证基线。
- [架构与信任边界](ARCHITECTURE.md)：进程、数据和更新边界。
- [Windows 发布指南](RELEASING.md)：维护者的签名、Release 和真实更新验证步骤。
- [Agent 开发实施计划](development/implementation-plan.md)：模块职责、分期、验收与回滚边界。

## 语言与版本

- [本地化说明](LOCALIZATION.md)：新增界面语言 JSON 包和文档翻译的规则。
- [变更日志](../CHANGELOG.md)：中文权威版本历史，以及同步维护的[英文译文](../CHANGELOG.en.md)。
