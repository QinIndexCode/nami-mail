# 邮箱接入指南

[简体中文](EMAIL-PROVIDERS.md) | [English](EMAIL-PROVIDERS.en.md)

Nami Mail 通过 IMAP 同步和 SMTP 发送邮件。它会优先使用内置服务商预设，并为自定义域名尝试 DNS 自动发现；发现结果是连接起点，不会替代企业管理员或邮箱服务商给出的最终配置。

## 开始前

1. 在邮箱服务商的网页设置中确认 IMAP/SMTP 已开启。服务商可能要求二次验证、手机验证或管理员批准。
2. 准备长期使用的客户端凭据：应用专用密码、客户端授权码、独立密码或 OAuth 授权。不要填写短信、邮件或验证器中的一次性验证码。
3. 输入完整邮箱地址，让 Nami Mail 显示该服务商的认证引导。自定义域、学校和企业邮箱应优先核对管理员提供的服务器与策略。
4. 连接失败时先阅读界面中的错误原因，再按本页的排障步骤处理；反复尝试普通网页登录密码通常不会解决 OAuth、授权码或管理员策略问题。

Nami Mail 只会将凭据用于直接连接你选择的邮箱服务商。凭据、OAuth 刷新令牌和敏感邮件数据的本地加密边界见 [隐私与本地数据说明](PRIVACY.md)。

## 常见服务商

| 服务商或账户类型 | 常见后缀 | 推荐认证 | 先完成的准备 |
| --- | --- | --- | --- |
| Gmail / Google Workspace | `gmail.com`、`googlemail.com`、企业自定义域 | Google OAuth2；应用专用密码为兼容路径 | 优先选择 Google 登录；密码路径先开启两步验证并生成应用专用密码。自定义域可能需要 OAuth 或 MX 发现。 |
| Outlook.com / Microsoft 365 | `outlook.com`、`hotmail.com`、`live.com`、`msn.com`、`office365.com`、组织自定义域 | Microsoft OAuth2 | 使用 Microsoft 登录。组织管理员可能禁止 IMAP，需确认邮件协议和授权策略。 |
| iCloud Mail | `icloud.com`、`me.com`、`mac.com` | Apple App 专用密码 | 在 Apple 账户中开启双重认证后生成 App 专用密码；iCloud 不支持 POP。 |
| QQ / QQ VIP / Foxmail | `qq.com`、`vip.qq.com`、`foxmail.com` | QQ 客户端授权码 | 在 QQ 邮箱网页设置中开启 IMAP/SMTP，并完成安全验证后生成授权码。 |
| 网易 | `163.com`、`126.com`、`yeah.net`、`188.com`、`vip.163.com`、`vip.126.com` | 网易客户端授权密码 | 开启 IMAP/SMTP 并生成客户端授权密码。`188.com` 和 VIP 账户如遇端点差异，请以账户设置为准。 |
| Yahoo / AOL | Yahoo 常见国际后缀、`aol.com`，部分 `verizon.net` | 第三方应用密码 | 在账户安全页面创建应用密码。Yahoo Japan 与未迁移的历史 Verizon 账户可能需要手动配置。 |
| Fastmail / Zoho | Fastmail 历史后缀、`zoho.com`、`zohomail.com` | 应用专用密码优先 | 确认套餐开放第三方 IMAP/SMTP。Zoho 企业域名可能使用不同 IMAP 端点。 |
| 新浪 / 搜狐 / 139 / 189 / 阿里云 | `sina.com`、`sina.cn`、`sohu.com`、`139.com`、`189.cn`、`aliyun.com` | 服务商授权码、独立密码或客户端密码 | 先在服务商网页确认客户端协议开关和对应凭据；预设失败时使用官方端点手动配置。 |
| Yandex | `yandex.com`、`yandex.ru`、`ya.ru` | 应用专用密码 | 先开启 IMAP，再为邮件客户端生成应用密码。 |
| 企业、学校和自建邮箱 | 任意自定义域 | 管理员指定的密码、应用密码或 OAuth | 先尝试自动发现；仍不确定时向管理员索取 IMAP、SMTP、端口、加密方式和用户名规则。 |

上表列出当前预设的常见入口，不代表每个服务商、国家站点、账户套餐或企业租户都已做过真实账户兼容性验证。服务商可随时改变协议和认证政策；界面中的官方帮助链接与管理员配置优先于过期的截图或第三方教程。

## Google 与 Microsoft OAuth

Nami Mail 当前只实现 Google 和 Microsoft 的 OAuth 登录入口。OAuth 使用公共客户端和本机回环回调，不需要也不接受 client secret。

- **Google**：使用 Google Cloud 的 Desktop app 客户端。若组织账号被管理员限制，按组织管理员的 OAuth 规则操作。
- **Microsoft**：使用 Microsoft Entra 的 Mobile and desktop applications / public client 配置。组织账号如提示 IMAP 或权限限制，需要管理员启用相应能力。
- **按钮不可用**：这通常表示当前安装版没有配置对应的公共 client ID，或该账号的发现结果不支持该入口。不要用普通账号密码代替 Microsoft OAuth；对 Gmail 仅可在服务商允许时使用应用专用密码兼容路径。

开发者配置回调、client ID 和租户的方式见 [README 的 OAuth 配置](../README.md#oauth-配置)。普通用户不应把 client secret 写入 `nami-mail.env`、Issue、日志或截图。

## 手动 IMAP / SMTP 配置

当自动发现的结果不确定、服务商预设不适用或管理员给出了专用端点时，展开应用中的“手动配置 IMAP / SMTP”：

1. 从服务商官方文档或管理员处取得 IMAP 与 SMTP 主机名、端口、加密方式和各协议用户名。
2. 对照填写两个协议。部分服务商的 IMAP 用户名与 SMTP 用户名不同；例如 iCloud 的 IMAP 用户名可使用 `@` 前的本地部分。
3. 选择 TLS 或 STARTTLS。Nami Mail 不支持用明文认证绕过连接问题。
4. 保存前逐项核对域名拼写、端口、传输方式和凭据类型。预设中的 `imap.<域名>` / `smtp.<域名>` 只是未知域名的保守起点，不是对所有企业邮箱都成立的承诺。

## 常见问题

### 认证失败

确认你填写的是应用专用密码、授权码或独立密码，而非网页登录密码或一次性验证码。重新生成凭据后再连接，并确认 IMAP/SMTP 已开启。Microsoft 365 与受管 Google Workspace 账户还可能被管理员策略拒绝。

### TLS、网络或超时

先检查网络连接、DNS、代理/VPN、安全软件和系统时间。然后核对 IMAP/SMTP 主机、端口与 TLS/STARTTLS 组合。不要为了“连接成功”降低为明文认证；若公司网络拦截邮件端口，请联系网络管理员。

### 企业或学校自定义域

邮箱后缀本身不足以判断后台是 Google Workspace、Microsoft 365、Coremail 或自建系统。让自动发现完成；结果不确定时使用手动配置，并向管理员确认 IMAP、SMTP、OAuth 和多因素认证策略。

### 需要提交 Issue

请提供脱敏的服务商类型、应用版本、系统、运行方式、选择的认证类别、错误分类和最小复现步骤。不要提供真实邮箱、邮件正文、附件名、OAuth 回调参数、令牌、授权码或密码。提交流程见 [支持指南](../SUPPORT.md)。
