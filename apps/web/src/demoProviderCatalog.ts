import type { ProviderInfo } from "./types";

// Kept in lockstep with the server preset catalog by demo-providers.test.ts.
export const demoProviderCatalog: ProviderInfo[] = [
  {
    "id": "gmail",
    "name": "Gmail",
    "family": "google",
    "priority": "P0",
    "domains": [
      "gmail.com",
      "googlemail.com"
    ],
    "imap": {
      "host": "imap.gmail.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.gmail.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "oauth2",
      "app-password"
    ],
    "recommendedAuthMethod": "oauth2",
    "credentialLabel": "使用 Google 登录或应用专用密码",
    "helpText": "优先使用 Google OAuth2；密码模式仅接受开启两步验证后生成的 16 位应用专用密码。",
    "caveat": "不要填写 Google 账户普通密码。Google Workspace 自定义域名需要通过 OAuth 或 MX 自动发现。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": [
        "gmail-api"
      ]
    },
    "credentialHint": "请使用开启两步验证后生成的 16 位应用专用密码",
    "credentialName": "16 位应用专用密码",
    "setupSteps": [
      "优先选择“使用 Google 登录”完成 OAuth2 授权。",
      "如使用 IMAP 密码模式，请先在 Google 账户中启用两步验证。",
      "进入“应用专用密码”，为 Nami Mail 生成并粘贴 16 位密码。"
    ],
    "helpUrl": "https://myaccount.google.com/apppasswords",
    "helpLabel": "打开 Google 应用专用密码",
    "basicAuthLimited": false,
    "usernameMode": "email",
    "oauthProvider": "google",
    "oauthAvailable": true
  },
  {
    "id": "icloud",
    "name": "iCloud Mail",
    "family": "apple",
    "priority": "P0",
    "domains": [
      "icloud.com",
      "me.com",
      "mac.com"
    ],
    "imap": {
      "host": "imap.mail.me.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.mail.me.com",
      "port": 587,
      "transport": "starttls",
      "secure": false
    },
    "authMethods": [
      "app-password"
    ],
    "recommendedAuthMethod": "app-password",
    "credentialLabel": "Apple App 专用密码",
    "helpText": "请使用 Apple 账户生成的 App 专用密码。",
    "caveat": "iCloud Mail 不支持 POP；SMTP 587 端口需要 STARTTLS。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": false,
      "apis": []
    },
    "credentialHint": "请使用 Apple 账户生成的应用专用密码",
    "credentialName": "App 专用密码",
    "setupSteps": [
      "确认 Apple 账户已经开启双重认证。",
      "在 Apple 账户的“登录与安全”中选择“App 专用密码”。",
      "为 Nami Mail 生成密码，并将完整结果粘贴到密码框。"
    ],
    "helpUrl": "https://account.apple.com/account/manage",
    "helpLabel": "打开 Apple 账户安全设置",
    "imapUsernameMode": "local",
    "smtpUsernameMode": "email",
    "basicAuthLimited": false
  },
  {
    "id": "qq",
    "name": "QQ Mail",
    "family": "tencent",
    "priority": "P0",
    "domains": [
      "qq.com",
      "vip.qq.com",
      "foxmail.com"
    ],
    "imap": {
      "host": "imap.qq.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.qq.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "QQ 客户端授权码",
    "helpText": "请在 QQ 邮箱设置中开启 IMAP/SMTP，并使用生成的客户端授权码。",
    "caveat": "QQ、QQ VIP 与 Foxmail 属于同一服务族；不能填写 QQ 登录密码。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用 QQ 邮箱设置中生成的授权码",
    "credentialName": "16 位客户端授权码",
    "setupSteps": [
      "登录 QQ 邮箱网页版，进入“设置 → 账号”。",
      "开启 IMAP/SMTP 服务并完成安全验证。",
      "复制生成的 16 位授权码，区分大小写并粘贴到密码框。"
    ],
    "helpUrl": "https://mail.qq.com/",
    "helpLabel": "打开 QQ 邮箱设置",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "netease-163",
    "name": "163 Mail",
    "family": "netease",
    "priority": "P0",
    "domains": [
      "163.com"
    ],
    "imap": {
      "host": "imap.163.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.163.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "网易客户端授权密码",
    "helpText": "请开启 IMAP/SMTP，并使用网易邮箱生成的客户端授权密码。",
    "caveat": "不要使用网页登录密码；163.net 是 TOM VIP 邮箱，不属于网易服务族。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用客户端授权密码，而不是网页登录密码",
    "credentialName": "客户端授权密码",
    "setupSteps": [
      "登录 163 邮箱网页版，进入“设置 → POP3/SMTP/IMAP”。",
      "开启 IMAP/SMTP 服务并完成手机安全验证。",
      "设置客户端授权密码，用它代替网页登录密码。"
    ],
    "helpUrl": "https://mail.163.com/",
    "helpLabel": "打开 163 邮箱设置",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "netease-126",
    "name": "126 Mail",
    "family": "netease",
    "priority": "P0",
    "domains": [
      "126.com"
    ],
    "imap": {
      "host": "imap.126.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.126.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "网易客户端授权密码",
    "helpText": "请开启 IMAP/SMTP，并使用网易邮箱生成的客户端授权密码。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用客户端授权密码，而不是网页登录密码",
    "credentialName": "客户端授权密码",
    "setupSteps": [
      "登录 126 邮箱网页版并进入邮箱设置。",
      "开启 IMAP/SMTP 服务并完成手机安全验证。",
      "设置客户端授权密码，用它代替网页登录密码。"
    ],
    "helpUrl": "https://mail.126.com/",
    "helpLabel": "打开 126 邮箱设置",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "netease-yeah",
    "name": "Yeah Mail",
    "family": "netease",
    "priority": "P0",
    "domains": [
      "yeah.net"
    ],
    "imap": {
      "host": "imap.yeah.net",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.yeah.net",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "网易客户端授权密码",
    "helpText": "请开启 IMAP/SMTP，并使用网易邮箱生成的客户端授权密码。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用客户端授权密码，而不是网页登录密码",
    "credentialName": "客户端授权密码",
    "setupSteps": [
      "登录 Yeah 邮箱网页版并进入邮箱设置。",
      "开启 IMAP/SMTP 服务并完成手机安全验证。",
      "设置客户端授权密码，用它代替网页登录密码。"
    ],
    "helpUrl": "https://www.yeah.net/",
    "helpLabel": "打开 Yeah 邮箱设置",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "netease-188",
    "name": "188 Mail",
    "family": "netease",
    "priority": "P1",
    "domains": [
      "188.com"
    ],
    "imap": {
      "host": "imap.188.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.188.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "网易客户端授权密码",
    "helpText": "请在 188 邮箱设置中开启 IMAP/SMTP，并使用客户端授权密码。",
    "caveat": "188.com 存在不同历史账户类型；如预设失败，请使用手动配置核对服务端点。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用客户端授权密码，而不是网页登录密码",
    "credentialName": "客户端授权密码",
    "setupSteps": [
      "登录 188 邮箱网页版并进入客户端设置。",
      "开启 IMAP/SMTP 服务并生成客户端授权密码。",
      "如账户显示不同服务器地址，请改用手动配置。"
    ],
    "helpUrl": "https://www.188.com/",
    "helpLabel": "打开 188 邮箱",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "netease-vip-163",
    "name": "163 VIP Mail",
    "family": "netease",
    "priority": "P1",
    "domains": [
      "vip.163.com"
    ],
    "imap": {
      "host": "imap.vip.163.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.vip.163.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "网易 VIP 客户端授权密码",
    "helpText": "请使用网易 VIP 邮箱生成的客户端授权密码。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用客户端授权密码，而不是网页登录密码",
    "credentialName": "客户端授权密码",
    "setupSteps": [
      "登录网易 VIP 邮箱。",
      "开启 IMAP/SMTP 服务。",
      "生成并填写客户端授权密码。"
    ],
    "helpUrl": "https://vip.163.com/",
    "helpLabel": "打开 163 VIP 邮箱",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "netease-vip-126",
    "name": "126 VIP Mail",
    "family": "netease",
    "priority": "P1",
    "domains": [
      "vip.126.com"
    ],
    "imap": {
      "host": "imap.vip.126.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.vip.126.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "网易 VIP 客户端授权密码",
    "helpText": "请使用网易 VIP 邮箱生成的客户端授权密码。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用客户端授权密码，而不是网页登录密码",
    "credentialName": "客户端授权密码",
    "setupSteps": [
      "登录网易 VIP 邮箱。",
      "开启 IMAP/SMTP 服务。",
      "生成并填写客户端授权密码。"
    ],
    "helpUrl": "https://vip.126.com/",
    "helpLabel": "打开 126 VIP 邮箱",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "microsoft",
    "name": "Outlook / Hotmail",
    "family": "microsoft",
    "priority": "P0",
    "domains": [
      "outlook.com",
      "hotmail.com",
      "live.com",
      "msn.com",
      "office365.com"
    ],
    "imap": {
      "host": "outlook.office365.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp-mail.outlook.com",
      "port": 587,
      "transport": "starttls",
      "secure": false
    },
    "authMethods": [
      "oauth2"
    ],
    "recommendedAuthMethod": "oauth2",
    "credentialLabel": "使用 Microsoft 登录",
    "helpText": "Outlook.com 与 Microsoft 365 要求 Modern Auth，请使用 Microsoft OAuth2。",
    "caveat": "企业管理员可能禁用 IMAP；Microsoft 365 应优先使用 Graph API，IMAP 仅作为兼容层。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": false,
      "apis": [
        "microsoft-graph"
      ]
    },
    "credentialHint": "Microsoft 通常要求 OAuth2；普通密码可能被服务器拒绝",
    "credentialName": "应用密码（可能仍被拒绝）",
    "setupSteps": [
      "选择“使用 Microsoft 登录”完成 OAuth2 授权。",
      "Microsoft 已对大多数账户停用 IMAP 基础密码认证。",
      "企业或学校账户如仍失败，请联系管理员确认 IMAP 或 Graph 权限。"
    ],
    "helpUrl": "https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040",
    "helpLabel": "查看 Microsoft 官方设置",
    "basicAuthLimited": true,
    "usernameMode": "email",
    "oauthProvider": "microsoft",
    "oauthAvailable": true
  },
  {
    "id": "yahoo",
    "name": "Yahoo Mail",
    "family": "yahoo",
    "priority": "P0",
    "domains": [
      "yahoo.com",
      "ymail.com",
      "rocketmail.com",
      "yahoo.co.uk",
      "yahoo.ca",
      "yahoo.de",
      "yahoo.fr",
      "yahoo.it",
      "yahoo.es",
      "yahoo.com.au",
      "yahoo.com.br",
      "yahoo.com.mx",
      "yahoo.co.in",
      "yahoo.in",
      "yahoo.com.sg",
      "yahoo.com.hk",
      "yahoo.co.nz",
      "yahoo.ie"
    ],
    "imap": {
      "host": "imap.mail.yahoo.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.mail.yahoo.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "app-password"
    ],
    "recommendedAuthMethod": "app-password",
    "credentialLabel": "Yahoo 第三方应用密码",
    "helpText": "Nami Mail 当前仅支持 Google 和 Microsoft OAuth；Yahoo 请使用账户安全页面生成的第三方应用密码。",
    "caveat": "Yahoo Japan 是独立服务，yahoo.co.jp 不会套用全球 Yahoo 端点。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用 Yahoo 生成的第三方应用密码，不要填写网页登录密码",
    "credentialName": "第三方应用密码",
    "setupSteps": [
      "登录 Yahoo 账户安全页面。",
      "在外部连接中创建用于 Nami Mail 的应用密码。",
      "复制生成的密码并粘贴到密码框。"
    ],
    "helpUrl": "https://login.yahoo.com/account/security",
    "helpLabel": "打开 Yahoo 账户安全",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "aol",
    "name": "AOL Mail",
    "family": "aol",
    "priority": "P0",
    "domains": [
      "aol.com",
      "verizon.net"
    ],
    "imap": {
      "host": "imap.aol.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.aol.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "app-password"
    ],
    "recommendedAuthMethod": "app-password",
    "credentialLabel": "AOL 第三方应用密码",
    "helpText": "请使用 AOL 账户生成的第三方应用密码。",
    "caveat": "只有已迁移至 AOL 的历史 Verizon 邮箱适用此预设；其他历史账户应使用手动配置。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用 AOL 账户生成的应用密码",
    "credentialName": "第三方应用密码",
    "setupSteps": [
      "登录 AOL 账户安全页面。",
      "为 Nami Mail 创建应用密码，不要填写网页登录密码。",
      "复制生成的密码并粘贴到密码框。"
    ],
    "helpUrl": "https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail",
    "helpLabel": "查看 AOL 官方邮件客户端设置",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "fastmail",
    "name": "Fastmail",
    "family": "fastmail",
    "priority": "P0",
    "domains": [
      "fastmail.com",
      "fastmail.fm",
      "fastmailbox.net",
      "fmail.co.uk",
      "fmgirl.com",
      "fmguy.com",
      "mailbolt.com",
      "mailcan.com",
      "mailhaven.com",
      "myfastmail.com",
      "proinbox.com",
      "rushpost.com",
      "sent.as",
      "sent.at",
      "sent.com",
      "speedymail.org",
      "warpmail.net",
      "xsmail.com",
      "123mail.org",
      "airpost.net",
      "eml.cc"
    ],
    "imap": {
      "host": "imap.fastmail.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.fastmail.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "app-password"
    ],
    "recommendedAuthMethod": "app-password",
    "credentialLabel": "Fastmail 应用专用密码",
    "helpText": "请使用 Fastmail 应用专用密码；账户普通密码不可用于第三方客户端。",
    "caveat": "Basic 方案不提供第三方 IMAP/SMTP；Fastmail 还支持 JMAP。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": false,
      "apis": [
        "jmap"
      ]
    },
    "credentialHint": "请使用 Fastmail 的应用专用密码；Basic 方案不支持第三方 IMAP/SMTP",
    "credentialName": "应用专用密码",
    "setupSteps": [
      "打开 Fastmail 的密码与安全设置。",
      "创建仅用于邮件客户端的应用密码。",
      "确认账户方案支持第三方 IMAP/SMTP。"
    ],
    "helpUrl": "https://www.fastmail.help/hc/en-us/articles/1500000278342",
    "helpLabel": "查看 Fastmail 官方设置",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "zoho",
    "name": "Zoho Mail",
    "family": "zoho",
    "priority": "P0",
    "domains": [
      "zoho.com",
      "zohomail.com"
    ],
    "imap": {
      "host": "imap.zoho.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.zoho.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "app-password",
      "password"
    ],
    "recommendedAuthMethod": "app-password",
    "credentialLabel": "Zoho 应用专用密码或邮箱密码",
    "helpText": "Nami Mail 当前仅支持 Google 和 Microsoft OAuth；Zoho 请优先使用应用专用密码，未开启两步验证时可使用邮箱密码。",
    "caveat": "新注册的免费方案可能未开放 IMAP；企业自定义域账户可能使用 imappro.zoho.com。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "优先使用 Zoho 应用专用密码；未开启两步验证时可使用邮箱密码",
    "credentialName": "应用专用密码或邮箱密码",
    "setupSteps": [
      "登录 Zoho Accounts，进入“安全”。",
      "开启两步验证时，为 Nami Mail 生成应用专用密码；否则填写邮箱密码。",
      "如为企业自定义域，请核对管理员提供的 IMAP 服务器。"
    ],
    "helpUrl": "https://accounts.zoho.com/home#security/app_password",
    "helpLabel": "打开 Zoho 应用密码",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "sina",
    "name": "Sina Mail",
    "family": "sina",
    "priority": "P0",
    "domains": [
      "sina.com"
    ],
    "imap": {
      "host": "imap.sina.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.sina.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code",
      "password"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "新浪客户端授权码或独立密码",
    "helpText": "请在新浪邮箱设置中开启 IMAP/SMTP，并优先使用客户端授权码或独立密码。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用新浪邮箱客户端授权码或独立密码",
    "credentialName": "客户端授权码或独立密码",
    "setupSteps": [
      "登录新浪邮箱网页版。",
      "开启 IMAP/SMTP 服务。",
      "生成并填写客户端授权凭据。"
    ],
    "helpUrl": "https://mail.sina.com.cn/",
    "helpLabel": "打开新浪邮箱",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "sina-cn",
    "name": "Sina CN Mail",
    "family": "sina",
    "priority": "P0",
    "domains": [
      "sina.cn"
    ],
    "imap": {
      "host": "imap.sina.cn",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.sina.cn",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code",
      "password"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "新浪客户端授权码或独立密码",
    "helpText": "请在新浪邮箱设置中开启 IMAP/SMTP，并优先使用客户端授权码或独立密码。",
    "caveat": "新浪不同后缀使用对应服务器；如果网页设置显示其他端点，请使用手动配置。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用新浪邮箱客户端授权码或独立密码",
    "credentialName": "客户端授权码或独立密码",
    "setupSteps": [
      "登录新浪邮箱网页版。",
      "开启 IMAP/SMTP 服务。",
      "生成并填写客户端授权凭据。"
    ],
    "helpUrl": "https://mail.sina.com.cn/",
    "helpLabel": "打开新浪邮箱",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "sina-vip",
    "name": "Sina VIP Mail",
    "family": "sina",
    "priority": "P1",
    "domains": [
      "vip.sina.com"
    ],
    "imap": {
      "host": "imap.vip.sina.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.vip.sina.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code",
      "password"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "新浪 VIP 客户端授权码或独立密码",
    "helpText": "请使用新浪 VIP 邮箱提供的客户端凭据。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用新浪 VIP 邮箱客户端授权码或独立密码",
    "credentialName": "客户端授权码或独立密码",
    "setupSteps": [
      "登录新浪 VIP 邮箱。",
      "开启 IMAP/SMTP 服务。",
      "填写客户端授权凭据。"
    ],
    "helpUrl": "https://vip.sina.com.cn/",
    "helpLabel": "打开新浪 VIP 邮箱",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "sina-vip-cn",
    "name": "Sina VIP CN Mail",
    "family": "sina",
    "priority": "P1",
    "domains": [
      "vip.sina.cn"
    ],
    "imap": {
      "host": "imap.vip.sina.cn",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.vip.sina.cn",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code",
      "password"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "新浪 VIP 客户端授权码或独立密码",
    "helpText": "请使用新浪 VIP 邮箱提供的客户端凭据。",
    "caveat": "如果网页设置显示其他端点，请使用手动配置。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用新浪 VIP 邮箱客户端授权码或独立密码",
    "credentialName": "客户端授权码或独立密码",
    "setupSteps": [
      "登录新浪 VIP 邮箱。",
      "开启 IMAP/SMTP 服务。",
      "填写客户端授权凭据。"
    ],
    "helpUrl": "https://vip.sina.com.cn/",
    "helpLabel": "打开新浪 VIP 邮箱",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "sohu",
    "name": "Sohu Mail",
    "family": "sohu",
    "priority": "P1",
    "domains": [
      "sohu.com"
    ],
    "imap": {
      "host": "imap.sohu.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.sohu.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "搜狐客户端独立密码",
    "helpText": "请在搜狐邮箱中开启 IMAP/SMTP，并生成客户端独立密码。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用搜狐邮箱生成的客户端独立密码",
    "credentialName": "客户端独立密码",
    "setupSteps": [
      "登录搜狐邮箱。",
      "开启 IMAP/SMTP 服务。",
      "生成并填写客户端独立密码。"
    ],
    "helpUrl": "https://mail.sohu.com/",
    "helpLabel": "打开搜狐邮箱",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "china-mobile-139",
    "name": "139 Mail",
    "family": "china-mobile",
    "priority": "P1",
    "domains": [
      "139.com"
    ],
    "imap": {
      "host": "imap.139.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.139.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code",
      "password"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "139 邮箱客户端密码",
    "helpText": "请在 139 邮箱安全设置中开启客户端服务，并使用客户端专用凭据。",
    "caveat": "手机号邮箱的登录名和安全策略可能因账户类型不同，请以网页版设置为准。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用 139 邮箱提供的客户端密码",
    "credentialName": "客户端密码",
    "setupSteps": [
      "登录 139 邮箱。",
      "开启 IMAP/SMTP 客户端服务。",
      "填写客户端专用凭据。"
    ],
    "helpUrl": "https://mail.10086.cn/",
    "helpLabel": "打开 139 邮箱",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "china-telecom-189",
    "name": "189 Mail",
    "family": "china-telecom",
    "priority": "P1",
    "domains": [
      "189.cn"
    ],
    "imap": {
      "host": "imap.189.cn",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.189.cn",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "client-authorization-code"
    ],
    "recommendedAuthMethod": "client-authorization-code",
    "credentialLabel": "189 邮箱客户端专用密码",
    "helpText": "请在 189 邮箱安全设置中生成客户端专用密码。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用 189 邮箱客户端专用密码",
    "credentialName": "客户端专用密码",
    "setupSteps": [
      "登录 189 邮箱。",
      "开启 IMAP/SMTP 服务。",
      "生成并填写客户端专用密码。"
    ],
    "helpUrl": "https://webmail30.189.cn/",
    "helpLabel": "打开 189 邮箱",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "aliyun",
    "name": "Aliyun Mail",
    "family": "aliyun",
    "priority": "P1",
    "domains": [
      "aliyun.com"
    ],
    "imap": {
      "host": "imap.aliyun.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.aliyun.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "password",
      "app-password"
    ],
    "recommendedAuthMethod": "app-password",
    "credentialLabel": "阿里云邮箱密码或客户端安全密码",
    "helpText": "优先使用客户端安全密码；未启用增强安全策略的账户也可能接受邮箱密码。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请使用阿里云邮箱密码或客户端安全密码",
    "credentialName": "邮箱密码或客户端安全密码",
    "setupSteps": [
      "登录阿里云个人邮箱。",
      "确认 IMAP/SMTP 已开启。",
      "按账户安全策略填写密码或客户端安全密码。"
    ],
    "helpUrl": "https://mail.aliyun.com/",
    "helpLabel": "打开阿里云邮箱",
    "basicAuthLimited": false,
    "usernameMode": "email"
  },
  {
    "id": "yandex",
    "name": "Yandex Mail",
    "family": "yandex",
    "priority": "P2",
    "domains": [
      "yandex.com",
      "yandex.ru",
      "ya.ru"
    ],
    "imap": {
      "host": "imap.yandex.com",
      "port": 993,
      "transport": "tls",
      "secure": true
    },
    "smtp": {
      "host": "smtp.yandex.com",
      "port": 465,
      "transport": "tls",
      "secure": true
    },
    "authMethods": [
      "app-password"
    ],
    "recommendedAuthMethod": "app-password",
    "credentialLabel": "Yandex 应用专用密码",
    "helpText": "请先启用 IMAP，再使用 Yandex 应用专用密码。",
    "capabilities": {
      "imap": true,
      "smtp": true,
      "pop": true,
      "apis": []
    },
    "credentialHint": "请先启用 IMAP，再使用 Yandex 应用密码",
    "credentialName": "应用专用密码",
    "setupSteps": [
      "在 Yandex Mail 设置中启用 IMAP。",
      "在账户安全设置中创建邮件客户端应用密码。",
      "复制应用密码；IMAP 和 SMTP 用户名均使用完整邮箱地址。"
    ],
    "helpUrl": "https://yandex.com/support/yandex-360/customers/mail/en/mail-clients/others",
    "helpLabel": "查看 Yandex 官方设置",
    "imapUsernameMode": "email",
    "smtpUsernameMode": "email",
    "basicAuthLimited": false
  }
];
