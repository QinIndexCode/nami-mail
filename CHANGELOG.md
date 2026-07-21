# 变更日志

本文件记录面向用户的显著变化，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的分类方式和语义化版本号。

## [Unreleased]

### 文档

- 补充从 GitHub Release 安装、首次启动、更新选择、卸载与 Windows SmartScreen 风险的用户指南；
- 补充常见邮箱服务商的认证准备、OAuth 边界、手动 IMAP/SMTP 和排障指南。
- 新增可直接用于首发的 [v0.1.0 Release Notes](docs/releases/v0.1.0.md)，以及将真实线上升级验收与候选文案分开的 [v0.1.1 模板](docs/releases/v0.1.1-candidate.md)。
- 将安全策略和 GitHub Issue 联系入口固定为已启用的 GitHub 私密漏洞通报路径，不再指向未配置的联系方式。

## [0.1.0] - 2026-07-22

- 本地优先的多账户 IMAP/SMTP 邮箱聚合、阅读、草稿、发送和同步；
- Google 与 Microsoft 公共客户端 OAuth，以及常见邮箱的应用专用密码/授权码引导；
- Windows 桌面版、本地数据加密与 GitHub Release ZIP 更新基础设施；
- 启动检查、更新/跳过/稍后提醒、ZIP 完整性复核和更新后缓存清理；
- 开源贡献、安全、隐私、支持、开发和发布文档。

面向用户的首发说明见 [v0.1.0 Release Notes](docs/releases/v0.1.0.md)。

该版本的 Release 资源与本地更新链路需要分别完成真实网络验证；在旧版到新版的公开线上升级验收完成前，不应将本条目视为自动更新的线上验证结论。
