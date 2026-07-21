import { promises as dns } from "node:dns";

export type MailTransport = "tls" | "starttls";

export type MailServerConfig = {
  host: string;
  port: number;
  transport: MailTransport;
  // Kept for ImapFlow/Nodemailer callers while they migrate to `transport`.
  secure: boolean;
};

export type ProviderPriority = "P0" | "P1" | "P2" | "fallback";
export type ProviderAuthMethod = "oauth2" | "app-password" | "client-authorization-code" | "password";
export type ProviderApiCapability = "gmail-api" | "microsoft-graph" | "zoho-api" | "jmap";
export type ProviderFamily =
  | "google"
  | "apple"
  | "tencent"
  | "netease"
  | "microsoft"
  | "yahoo"
  | "aol"
  | "fastmail"
  | "zoho"
  | "sina"
  | "sohu"
  | "china-mobile"
  | "china-telecom"
  | "aliyun"
  | "yandex"
  | "custom";

export type ProviderCapabilities = {
  imap: boolean;
  smtp: boolean;
  pop: boolean;
  apis: ProviderApiCapability[];
};

export type ProviderPreset = {
  id: string;
  name: string;
  family: ProviderFamily;
  priority: ProviderPriority;
  domains: string[];
  imap: MailServerConfig;
  smtp: MailServerConfig;
  authMethods: ProviderAuthMethod[];
  recommendedAuthMethod: ProviderAuthMethod;
  credentialLabel: string;
  helpText: string;
  caveat?: string;
  capabilities: ProviderCapabilities;
  credentialHint: string;
  credentialName: string;
  setupSteps: string[];
  helpUrl?: string;
  helpLabel?: string;
  /**
   * Legacy shared username rule. Keep this for existing presets and stored
   * accounts, but prefer the protocol-specific rules below for new presets.
   */
  usernameMode?: "email" | "local";
  imapUsernameMode?: "email" | "local";
  smtpUsernameMode?: "email" | "local";
  basicAuthLimited?: boolean;
};

function mailServer(host: string, port: number, transport: MailTransport): MailServerConfig {
  return { host, port, transport, secure: transport === "tls" };
}

function mailCapabilities(apis: ProviderApiCapability[] = [], pop = false): ProviderCapabilities {
  return { imap: true, smtp: true, pop, apis };
}

export const providerPresets: ProviderPreset[] = [
  {
    id: "gmail",
    name: "Gmail",
    family: "google",
    priority: "P0",
    domains: ["gmail.com", "googlemail.com"],
    imap: mailServer("imap.gmail.com", 993, "tls"),
    smtp: mailServer("smtp.gmail.com", 465, "tls"),
    authMethods: ["oauth2", "app-password"],
    recommendedAuthMethod: "oauth2",
    credentialLabel: "使用 Google 登录或应用专用密码",
    helpText: "优先使用 Google OAuth2；密码模式仅接受开启两步验证后生成的 16 位应用专用密码。",
    caveat: "不要填写 Google 账户普通密码。Google Workspace 自定义域名需要通过 OAuth 或 MX 自动发现。",
    capabilities: mailCapabilities(["gmail-api"], true),
    credentialHint: "请使用开启两步验证后生成的 16 位应用专用密码",
    credentialName: "16 位应用专用密码",
    setupSteps: [
      "优先选择“使用 Google 登录”完成 OAuth2 授权。",
      "如使用 IMAP 密码模式，请先在 Google 账户中启用两步验证。",
      "进入“应用专用密码”，为 Nami Mail 生成并粘贴 16 位密码。",
    ],
    helpUrl: "https://myaccount.google.com/apppasswords",
    helpLabel: "打开 Google 应用专用密码",
  },
  {
    id: "icloud",
    name: "iCloud Mail",
    family: "apple",
    priority: "P0",
    domains: ["icloud.com", "me.com", "mac.com"],
    imap: mailServer("imap.mail.me.com", 993, "tls"),
    smtp: mailServer("smtp.mail.me.com", 587, "starttls"),
    authMethods: ["app-password"],
    recommendedAuthMethod: "app-password",
    credentialLabel: "Apple App 专用密码",
    helpText: "请使用 Apple 账户生成的 App 专用密码。",
    caveat: "iCloud Mail 不支持 POP；SMTP 587 端口需要 STARTTLS。",
    capabilities: mailCapabilities([], false),
    credentialHint: "请使用 Apple 账户生成的应用专用密码",
    credentialName: "App 专用密码",
    setupSteps: [
      "确认 Apple 账户已经开启双重认证。",
      "在 Apple 账户的“登录与安全”中选择“App 专用密码”。",
      "为 Nami Mail 生成密码，并将完整结果粘贴到密码框。",
    ],
    helpUrl: "https://account.apple.com/account/manage",
    helpLabel: "打开 Apple 账户安全设置",
    imapUsernameMode: "local",
    smtpUsernameMode: "email",
  },
  {
    id: "qq",
    name: "QQ Mail",
    family: "tencent",
    priority: "P0",
    domains: ["qq.com", "vip.qq.com", "foxmail.com"],
    imap: mailServer("imap.qq.com", 993, "tls"),
    smtp: mailServer("smtp.qq.com", 465, "tls"),
    authMethods: ["client-authorization-code"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "QQ 客户端授权码",
    helpText: "请在 QQ 邮箱设置中开启 IMAP/SMTP，并使用生成的客户端授权码。",
    caveat: "QQ、QQ VIP 与 Foxmail 属于同一服务族；不能填写 QQ 登录密码。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用 QQ 邮箱设置中生成的授权码",
    credentialName: "16 位客户端授权码",
    setupSteps: [
      "登录 QQ 邮箱网页版，进入“设置 → 账号”。",
      "开启 IMAP/SMTP 服务并完成安全验证。",
      "复制生成的 16 位授权码，区分大小写并粘贴到密码框。",
    ],
    helpUrl: "https://mail.qq.com/",
    helpLabel: "打开 QQ 邮箱设置",
  },
  {
    id: "netease-163",
    name: "163 Mail",
    family: "netease",
    priority: "P0",
    domains: ["163.com"],
    imap: mailServer("imap.163.com", 993, "tls"),
    smtp: mailServer("smtp.163.com", 465, "tls"),
    authMethods: ["client-authorization-code"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "网易客户端授权密码",
    helpText: "请开启 IMAP/SMTP，并使用网易邮箱生成的客户端授权密码。",
    caveat: "不要使用网页登录密码；163.net 是 TOM VIP 邮箱，不属于网易服务族。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用客户端授权密码，而不是网页登录密码",
    credentialName: "客户端授权密码",
    setupSteps: [
      "登录 163 邮箱网页版，进入“设置 → POP3/SMTP/IMAP”。",
      "开启 IMAP/SMTP 服务并完成手机安全验证。",
      "设置客户端授权密码，用它代替网页登录密码。",
    ],
    helpUrl: "https://mail.163.com/",
    helpLabel: "打开 163 邮箱设置",
  },
  {
    id: "netease-126",
    name: "126 Mail",
    family: "netease",
    priority: "P0",
    domains: ["126.com"],
    imap: mailServer("imap.126.com", 993, "tls"),
    smtp: mailServer("smtp.126.com", 465, "tls"),
    authMethods: ["client-authorization-code"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "网易客户端授权密码",
    helpText: "请开启 IMAP/SMTP，并使用网易邮箱生成的客户端授权密码。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用客户端授权密码，而不是网页登录密码",
    credentialName: "客户端授权密码",
    setupSteps: [
      "登录 126 邮箱网页版并进入邮箱设置。",
      "开启 IMAP/SMTP 服务并完成手机安全验证。",
      "设置客户端授权密码，用它代替网页登录密码。",
    ],
    helpUrl: "https://mail.126.com/",
    helpLabel: "打开 126 邮箱设置",
  },
  {
    id: "netease-yeah",
    name: "Yeah Mail",
    family: "netease",
    priority: "P0",
    domains: ["yeah.net"],
    imap: mailServer("imap.yeah.net", 993, "tls"),
    smtp: mailServer("smtp.yeah.net", 465, "tls"),
    authMethods: ["client-authorization-code"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "网易客户端授权密码",
    helpText: "请开启 IMAP/SMTP，并使用网易邮箱生成的客户端授权密码。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用客户端授权密码，而不是网页登录密码",
    credentialName: "客户端授权密码",
    setupSteps: [
      "登录 Yeah 邮箱网页版并进入邮箱设置。",
      "开启 IMAP/SMTP 服务并完成手机安全验证。",
      "设置客户端授权密码，用它代替网页登录密码。",
    ],
    helpUrl: "https://www.yeah.net/",
    helpLabel: "打开 Yeah 邮箱设置",
  },
  {
    id: "netease-188",
    name: "188 Mail",
    family: "netease",
    priority: "P1",
    domains: ["188.com"],
    imap: mailServer("imap.188.com", 993, "tls"),
    smtp: mailServer("smtp.188.com", 465, "tls"),
    authMethods: ["client-authorization-code"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "网易客户端授权密码",
    helpText: "请在 188 邮箱设置中开启 IMAP/SMTP，并使用客户端授权密码。",
    caveat: "188.com 存在不同历史账户类型；如预设失败，请使用手动配置核对服务端点。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用客户端授权密码，而不是网页登录密码",
    credentialName: "客户端授权密码",
    setupSteps: [
      "登录 188 邮箱网页版并进入客户端设置。",
      "开启 IMAP/SMTP 服务并生成客户端授权密码。",
      "如账户显示不同服务器地址，请改用手动配置。",
    ],
    helpUrl: "https://www.188.com/",
    helpLabel: "打开 188 邮箱",
  },
  {
    id: "netease-vip-163",
    name: "163 VIP Mail",
    family: "netease",
    priority: "P1",
    domains: ["vip.163.com"],
    imap: mailServer("imap.vip.163.com", 993, "tls"),
    smtp: mailServer("smtp.vip.163.com", 465, "tls"),
    authMethods: ["client-authorization-code"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "网易 VIP 客户端授权密码",
    helpText: "请使用网易 VIP 邮箱生成的客户端授权密码。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用客户端授权密码，而不是网页登录密码",
    credentialName: "客户端授权密码",
    setupSteps: ["登录网易 VIP 邮箱。", "开启 IMAP/SMTP 服务。", "生成并填写客户端授权密码。"],
    helpUrl: "https://vip.163.com/",
    helpLabel: "打开 163 VIP 邮箱",
  },
  {
    id: "netease-vip-126",
    name: "126 VIP Mail",
    family: "netease",
    priority: "P1",
    domains: ["vip.126.com"],
    imap: mailServer("imap.vip.126.com", 993, "tls"),
    smtp: mailServer("smtp.vip.126.com", 465, "tls"),
    authMethods: ["client-authorization-code"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "网易 VIP 客户端授权密码",
    helpText: "请使用网易 VIP 邮箱生成的客户端授权密码。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用客户端授权密码，而不是网页登录密码",
    credentialName: "客户端授权密码",
    setupSteps: ["登录网易 VIP 邮箱。", "开启 IMAP/SMTP 服务。", "生成并填写客户端授权密码。"],
    helpUrl: "https://vip.126.com/",
    helpLabel: "打开 126 VIP 邮箱",
  },
  {
    id: "microsoft",
    name: "Outlook / Hotmail",
    family: "microsoft",
    priority: "P0",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "office365.com"],
    imap: mailServer("outlook.office365.com", 993, "tls"),
    smtp: mailServer("smtp-mail.outlook.com", 587, "starttls"),
    authMethods: ["oauth2"],
    recommendedAuthMethod: "oauth2",
    credentialLabel: "使用 Microsoft 登录",
    helpText: "Outlook.com 与 Microsoft 365 要求 Modern Auth，请使用 Microsoft OAuth2。",
    caveat: "企业管理员可能禁用 IMAP；Microsoft 365 应优先使用 Graph API，IMAP 仅作为兼容层。",
    capabilities: mailCapabilities(["microsoft-graph"], false),
    credentialHint: "Microsoft 通常要求 OAuth2；普通密码可能被服务器拒绝",
    credentialName: "应用密码（可能仍被拒绝）",
    setupSteps: [
      "选择“使用 Microsoft 登录”完成 OAuth2 授权。",
      "Microsoft 已对大多数账户停用 IMAP 基础密码认证。",
      "企业或学校账户如仍失败，请联系管理员确认 IMAP 或 Graph 权限。",
    ],
    helpUrl: "https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040",
    helpLabel: "查看 Microsoft 官方设置",
    basicAuthLimited: true,
  },
  {
    id: "yahoo",
    name: "Yahoo Mail",
    family: "yahoo",
    priority: "P0",
    domains: [
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
      "yahoo.ie",
    ],
    imap: mailServer("imap.mail.yahoo.com", 993, "tls"),
    smtp: mailServer("smtp.mail.yahoo.com", 465, "tls"),
    authMethods: ["app-password"],
    recommendedAuthMethod: "app-password",
    credentialLabel: "Yahoo 第三方应用密码",
    helpText: "Nami Mail 当前仅支持 Google 和 Microsoft OAuth；Yahoo 请使用账户安全页面生成的第三方应用密码。",
    caveat: "Yahoo Japan 是独立服务，yahoo.co.jp 不会套用全球 Yahoo 端点。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用 Yahoo 生成的第三方应用密码，不要填写网页登录密码",
    credentialName: "第三方应用密码",
    setupSteps: [
      "登录 Yahoo 账户安全页面。",
      "在外部连接中创建用于 Nami Mail 的应用密码。",
      "复制生成的密码并粘贴到密码框。",
    ],
    helpUrl: "https://login.yahoo.com/account/security",
    helpLabel: "打开 Yahoo 账户安全",
  },
  {
    id: "aol",
    name: "AOL Mail",
    family: "aol",
    priority: "P0",
    domains: ["aol.com", "verizon.net"],
    imap: mailServer("imap.aol.com", 993, "tls"),
    smtp: mailServer("smtp.aol.com", 465, "tls"),
    authMethods: ["app-password"],
    recommendedAuthMethod: "app-password",
    credentialLabel: "AOL 第三方应用密码",
    helpText: "请使用 AOL 账户生成的第三方应用密码。",
    caveat: "只有已迁移至 AOL 的历史 Verizon 邮箱适用此预设；其他历史账户应使用手动配置。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用 AOL 账户生成的应用密码",
    credentialName: "第三方应用密码",
    setupSteps: [
      "登录 AOL 账户安全页面。",
      "为 Nami Mail 创建应用密码，不要填写网页登录密码。",
      "复制生成的密码并粘贴到密码框。",
    ],
    helpUrl: "https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail",
    helpLabel: "查看 AOL 官方邮件客户端设置",
  },
  {
    id: "fastmail",
    name: "Fastmail",
    family: "fastmail",
    priority: "P0",
    domains: [
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
      "eml.cc",
    ],
    imap: mailServer("imap.fastmail.com", 993, "tls"),
    smtp: mailServer("smtp.fastmail.com", 465, "tls"),
    authMethods: ["app-password"],
    recommendedAuthMethod: "app-password",
    credentialLabel: "Fastmail 应用专用密码",
    helpText: "请使用 Fastmail 应用专用密码；账户普通密码不可用于第三方客户端。",
    caveat: "Basic 方案不提供第三方 IMAP/SMTP；Fastmail 还支持 JMAP。",
    capabilities: mailCapabilities(["jmap"], false),
    credentialHint: "请使用 Fastmail 的应用专用密码；Basic 方案不支持第三方 IMAP/SMTP",
    credentialName: "应用专用密码",
    setupSteps: [
      "打开 Fastmail 的密码与安全设置。",
      "创建仅用于邮件客户端的应用密码。",
      "确认账户方案支持第三方 IMAP/SMTP。",
    ],
    helpUrl: "https://www.fastmail.help/hc/en-us/articles/1500000278342",
    helpLabel: "查看 Fastmail 官方设置",
  },
  {
    id: "zoho",
    name: "Zoho Mail",
    family: "zoho",
    priority: "P0",
    domains: ["zoho.com", "zohomail.com"],
    imap: mailServer("imap.zoho.com", 993, "tls"),
    smtp: mailServer("smtp.zoho.com", 465, "tls"),
    authMethods: ["app-password", "password"],
    recommendedAuthMethod: "app-password",
    credentialLabel: "Zoho 应用专用密码或邮箱密码",
    helpText: "Nami Mail 当前仅支持 Google 和 Microsoft OAuth；Zoho 请优先使用应用专用密码，未开启两步验证时可使用邮箱密码。",
    caveat: "新注册的免费方案可能未开放 IMAP；企业自定义域账户可能使用 imappro.zoho.com。",
    capabilities: mailCapabilities([], true),
    credentialHint: "优先使用 Zoho 应用专用密码；未开启两步验证时可使用邮箱密码",
    credentialName: "应用专用密码或邮箱密码",
    setupSteps: [
      "登录 Zoho Accounts，进入“安全”。",
      "开启两步验证时，为 Nami Mail 生成应用专用密码；否则填写邮箱密码。",
      "如为企业自定义域，请核对管理员提供的 IMAP 服务器。",
    ],
    helpUrl: "https://accounts.zoho.com/home#security/app_password",
    helpLabel: "打开 Zoho 应用密码",
  },
  {
    id: "sina",
    name: "Sina Mail",
    family: "sina",
    priority: "P0",
    domains: ["sina.com"],
    imap: mailServer("imap.sina.com", 993, "tls"),
    smtp: mailServer("smtp.sina.com", 465, "tls"),
    authMethods: ["client-authorization-code", "password"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "新浪客户端授权码或独立密码",
    helpText: "请在新浪邮箱设置中开启 IMAP/SMTP，并优先使用客户端授权码或独立密码。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用新浪邮箱客户端授权码或独立密码",
    credentialName: "客户端授权码或独立密码",
    setupSteps: ["登录新浪邮箱网页版。", "开启 IMAP/SMTP 服务。", "生成并填写客户端授权凭据。"],
    helpUrl: "https://mail.sina.com.cn/",
    helpLabel: "打开新浪邮箱",
  },
  {
    id: "sina-cn",
    name: "Sina CN Mail",
    family: "sina",
    priority: "P0",
    domains: ["sina.cn"],
    imap: mailServer("imap.sina.cn", 993, "tls"),
    smtp: mailServer("smtp.sina.cn", 465, "tls"),
    authMethods: ["client-authorization-code", "password"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "新浪客户端授权码或独立密码",
    helpText: "请在新浪邮箱设置中开启 IMAP/SMTP，并优先使用客户端授权码或独立密码。",
    caveat: "新浪不同后缀使用对应服务器；如果网页设置显示其他端点，请使用手动配置。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用新浪邮箱客户端授权码或独立密码",
    credentialName: "客户端授权码或独立密码",
    setupSteps: ["登录新浪邮箱网页版。", "开启 IMAP/SMTP 服务。", "生成并填写客户端授权凭据。"],
    helpUrl: "https://mail.sina.com.cn/",
    helpLabel: "打开新浪邮箱",
  },
  {
    id: "sina-vip",
    name: "Sina VIP Mail",
    family: "sina",
    priority: "P1",
    domains: ["vip.sina.com"],
    imap: mailServer("imap.vip.sina.com", 993, "tls"),
    smtp: mailServer("smtp.vip.sina.com", 465, "tls"),
    authMethods: ["client-authorization-code", "password"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "新浪 VIP 客户端授权码或独立密码",
    helpText: "请使用新浪 VIP 邮箱提供的客户端凭据。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用新浪 VIP 邮箱客户端授权码或独立密码",
    credentialName: "客户端授权码或独立密码",
    setupSteps: ["登录新浪 VIP 邮箱。", "开启 IMAP/SMTP 服务。", "填写客户端授权凭据。"],
    helpUrl: "https://vip.sina.com.cn/",
    helpLabel: "打开新浪 VIP 邮箱",
  },
  {
    id: "sina-vip-cn",
    name: "Sina VIP CN Mail",
    family: "sina",
    priority: "P1",
    domains: ["vip.sina.cn"],
    imap: mailServer("imap.vip.sina.cn", 993, "tls"),
    smtp: mailServer("smtp.vip.sina.cn", 465, "tls"),
    authMethods: ["client-authorization-code", "password"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "新浪 VIP 客户端授权码或独立密码",
    helpText: "请使用新浪 VIP 邮箱提供的客户端凭据。",
    caveat: "如果网页设置显示其他端点，请使用手动配置。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用新浪 VIP 邮箱客户端授权码或独立密码",
    credentialName: "客户端授权码或独立密码",
    setupSteps: ["登录新浪 VIP 邮箱。", "开启 IMAP/SMTP 服务。", "填写客户端授权凭据。"],
    helpUrl: "https://vip.sina.com.cn/",
    helpLabel: "打开新浪 VIP 邮箱",
  },
  {
    id: "sohu",
    name: "Sohu Mail",
    family: "sohu",
    priority: "P1",
    domains: ["sohu.com"],
    imap: mailServer("imap.sohu.com", 993, "tls"),
    smtp: mailServer("smtp.sohu.com", 465, "tls"),
    authMethods: ["client-authorization-code"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "搜狐客户端独立密码",
    helpText: "请在搜狐邮箱中开启 IMAP/SMTP，并生成客户端独立密码。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用搜狐邮箱生成的客户端独立密码",
    credentialName: "客户端独立密码",
    setupSteps: ["登录搜狐邮箱。", "开启 IMAP/SMTP 服务。", "生成并填写客户端独立密码。"],
    helpUrl: "https://mail.sohu.com/",
    helpLabel: "打开搜狐邮箱",
  },
  {
    id: "china-mobile-139",
    name: "139 Mail",
    family: "china-mobile",
    priority: "P1",
    domains: ["139.com"],
    imap: mailServer("imap.139.com", 993, "tls"),
    smtp: mailServer("smtp.139.com", 465, "tls"),
    authMethods: ["client-authorization-code", "password"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "139 邮箱客户端密码",
    helpText: "请在 139 邮箱安全设置中开启客户端服务，并使用客户端专用凭据。",
    caveat: "手机号邮箱的登录名和安全策略可能因账户类型不同，请以网页版设置为准。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用 139 邮箱提供的客户端密码",
    credentialName: "客户端密码",
    setupSteps: ["登录 139 邮箱。", "开启 IMAP/SMTP 客户端服务。", "填写客户端专用凭据。"],
    helpUrl: "https://mail.10086.cn/",
    helpLabel: "打开 139 邮箱",
  },
  {
    id: "china-telecom-189",
    name: "189 Mail",
    family: "china-telecom",
    priority: "P1",
    domains: ["189.cn"],
    imap: mailServer("imap.189.cn", 993, "tls"),
    smtp: mailServer("smtp.189.cn", 465, "tls"),
    authMethods: ["client-authorization-code"],
    recommendedAuthMethod: "client-authorization-code",
    credentialLabel: "189 邮箱客户端专用密码",
    helpText: "请在 189 邮箱安全设置中生成客户端专用密码。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用 189 邮箱客户端专用密码",
    credentialName: "客户端专用密码",
    setupSteps: ["登录 189 邮箱。", "开启 IMAP/SMTP 服务。", "生成并填写客户端专用密码。"],
    helpUrl: "https://webmail30.189.cn/",
    helpLabel: "打开 189 邮箱",
  },
  {
    id: "aliyun",
    name: "Aliyun Mail",
    family: "aliyun",
    priority: "P1",
    domains: ["aliyun.com"],
    imap: mailServer("imap.aliyun.com", 993, "tls"),
    smtp: mailServer("smtp.aliyun.com", 465, "tls"),
    authMethods: ["password", "app-password"],
    recommendedAuthMethod: "app-password",
    credentialLabel: "阿里云邮箱密码或客户端安全密码",
    helpText: "优先使用客户端安全密码；未启用增强安全策略的账户也可能接受邮箱密码。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请使用阿里云邮箱密码或客户端安全密码",
    credentialName: "邮箱密码或客户端安全密码",
    setupSteps: ["登录阿里云个人邮箱。", "确认 IMAP/SMTP 已开启。", "按账户安全策略填写密码或客户端安全密码。"],
    helpUrl: "https://mail.aliyun.com/",
    helpLabel: "打开阿里云邮箱",
  },
  {
    id: "yandex",
    name: "Yandex Mail",
    family: "yandex",
    priority: "P2",
    domains: ["yandex.com", "yandex.ru", "ya.ru"],
    imap: mailServer("imap.yandex.com", 993, "tls"),
    smtp: mailServer("smtp.yandex.com", 465, "tls"),
    authMethods: ["app-password"],
    recommendedAuthMethod: "app-password",
    credentialLabel: "Yandex 应用专用密码",
    helpText: "请先启用 IMAP，再使用 Yandex 应用专用密码。",
    capabilities: mailCapabilities([], true),
    credentialHint: "请先启用 IMAP，再使用 Yandex 应用密码",
    credentialName: "应用专用密码",
    setupSteps: [
      "在 Yandex Mail 设置中启用 IMAP。",
      "在账户安全设置中创建邮件客户端应用密码。",
      "复制应用密码；IMAP 和 SMTP 用户名均使用完整邮箱地址。",
    ],
    helpUrl: "https://yandex.com/support/yandex-360/customers/mail/en/mail-clients/others",
    helpLabel: "查看 Yandex 官方设置",
    imapUsernameMode: "email",
    smtpUsernameMode: "email",
  },
];

export type ProviderDiscoverySource = "preset" | "srv" | "mx" | "conventional";
export type ProviderDiscoveryConfidence = "high" | "medium" | "low";

export type DetectedProvider = ProviderPreset & {
  domain: string;
  isCustom: boolean;
  source: ProviderDiscoverySource;
  confidence: ProviderDiscoveryConfidence;
};

export type ProviderSrvRecord = {
  name: string;
  port: number;
  priority: number;
  weight: number;
};

export type ProviderMxRecord = {
  exchange: string;
  priority: number;
};

export type ProviderDnsResolver = {
  resolveSrv(hostname: string): Promise<readonly ProviderSrvRecord[]>;
  resolveMx(hostname: string): Promise<readonly ProviderMxRecord[]>;
};

const systemDnsResolver: ProviderDnsResolver = {
  resolveSrv: (hostname) => dns.resolveSrv(hostname),
  resolveMx: (hostname) => dns.resolveMx(hostname),
};

export function emailDomain(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) throw new Error("请输入有效的邮箱地址。");
  return normalized.slice(at + 1);
}

function customProvider(domain: string): DetectedProvider {
  return {
    id: "custom",
    name: domain,
    family: "custom",
    priority: "fallback",
    domains: [domain],
    domain,
    isCustom: true,
    source: "conventional",
    confidence: "low",
    imap: mailServer(`imap.${domain}`, 993, "tls"),
    smtp: mailServer(`smtp.${domain}`, 465, "tls"),
    authMethods: ["password", "app-password", "client-authorization-code"],
    recommendedAuthMethod: "password",
    credentialLabel: "邮箱密码或客户端授权码",
    helpText: "使用邮箱服务商提供的密码、应用专用密码或客户端授权码。",
    caveat: "自动发现只是候选配置；连接失败时请使用服务商或管理员提供的手动 IMAP/SMTP 参数。",
    capabilities: mailCapabilities([], false),
    credentialHint: "使用该邮箱服务商提供的密码或客户端授权码",
    credentialName: "邮箱密码或客户端授权码",
    setupSteps: [
      "登录邮箱服务商的网页设置，确认已经开启 IMAP 与 SMTP。",
      "如果账户启用了两步验证，请生成应用专用密码或客户端授权码。",
      "核对管理员提供的服务器、端口与 TLS 模式；必要时使用手动配置。",
      "仅 Google 和 Microsoft 提供应用内安全登录；其他仅支持 OAuth 的组织账户请先向管理员确认 IMAP/SMTP 兼容凭据。",
    ],
  };
}

export function detectProvider(email: string): DetectedProvider {
  const domain = emailDomain(email);
  const preset = providerPresets.find((item) => item.domains.includes(domain));
  if (preset) {
    return { ...preset, domain, isCustom: false, source: "preset", confidence: "high" };
  }
  const tenantPreset = microsoft365TenantProvider(domain);
  if (tenantPreset) {
    return { ...tenantPreset, domain, isCustom: false, source: "preset", confidence: "high" };
  }
  return customProvider(domain);
}

type SrvCandidate = { name: string; transport: MailTransport };

async function firstSrv(
  candidates: SrvCandidate[],
  resolver: ProviderDnsResolver,
): Promise<MailServerConfig | null> {
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const records = await resolver.resolveSrv(candidate.name);
        const record = [...records]
          .filter((item) => item.name !== ".")
          .sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
        if (!record) return null;
        return mailServer(record.name.replace(/\.$/, "").toLowerCase(), record.port, candidate.transport);
      } catch {
        return null;
      }
    }),
  );
  return results.find((result) => result !== null) ?? null;
}

async function resolveMx(domain: string, resolver: ProviderDnsResolver): Promise<ProviderMxRecord[]> {
  try {
    return [...(await resolver.resolveMx(domain))].sort((a, b) => a.priority - b.priority);
  } catch {
    return [];
  }
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function presetById(id: string): ProviderPreset {
  const preset = providerPresets.find((item) => item.id === id);
  if (!preset) throw new Error(`Provider preset not found: ${id}`);
  return preset;
}

function microsoft365Provider(domain: string): ProviderPreset {
  return {
    ...presetById("microsoft"),
    name: "Microsoft 365",
    domains: [domain],
    smtp: mailServer("smtp.office365.com", 587, "starttls"),
  };
}

function microsoft365TenantProvider(domain: string): ProviderPreset | null {
  // Every Microsoft 365 tenant receives a tenant-name.onmicrosoft.com domain.
  // Recognize only a subdomain so the public suffix itself is never treated as
  // a mailbox domain.
  if (!domain.endsWith(".onmicrosoft.com")) return null;
  return microsoft365Provider(domain);
}

function providerFromMx(records: ProviderMxRecord[], domain: string): ProviderPreset | null {
  for (const record of records) {
    const exchange = record.exchange.replace(/\.$/, "").toLowerCase();
    if (hostMatches(exchange, "google.com")) {
      return { ...presetById("gmail"), name: "Google Workspace", domains: [domain] };
    }
    if (hostMatches(exchange, "mail.protection.outlook.com")) {
      return microsoft365Provider(domain);
    }
    if (hostMatches(exchange, "messagingengine.com")) {
      return { ...presetById("fastmail"), name: "Fastmail custom domain", domains: [domain] };
    }
    if (
      hostMatches(exchange, "zoho.com") ||
      hostMatches(exchange, "zoho.eu") ||
      hostMatches(exchange, "zoho.in") ||
      hostMatches(exchange, "zoho.com.au") ||
      hostMatches(exchange, "zoho.jp") ||
      hostMatches(exchange, "zoho.ca")
    ) {
      return {
        ...presetById("zoho"),
        name: "Zoho Mail custom domain",
        domains: [domain],
        caveat: "MX 表明该域使用 Zoho；企业账户可能需要 imappro.zoho.com，请以管理员提供的端点为准。",
      };
    }
  }
  return null;
}

export async function resolveProvider(
  email: string,
  resolver: ProviderDnsResolver = systemDnsResolver,
): Promise<DetectedProvider> {
  const detected = detectProvider(email);
  if (!detected.isCustom) return detected;

  const [imap, smtp, mxRecords] = await Promise.all([
    firstSrv(
      [
        { name: `_imaps._tcp.${detected.domain}`, transport: "tls" },
        { name: `_imap._tcp.${detected.domain}`, transport: "starttls" },
      ],
      resolver,
    ),
    firstSrv(
      [
        { name: `_submissions._tcp.${detected.domain}`, transport: "tls" },
        { name: `_submission._tcp.${detected.domain}`, transport: "starttls" },
      ],
      resolver,
    ),
    resolveMx(detected.domain, resolver),
  ]);
  const mxProvider = providerFromMx(mxRecords, detected.domain);
  const base = mxProvider ?? detected;
  const hasSrv = Boolean(imap || smtp);

  return {
    ...base,
    domain: detected.domain,
    isCustom: true,
    source: hasSrv ? "srv" : mxProvider ? "mx" : "conventional",
    confidence: hasSrv ? "high" : mxProvider ? "medium" : "low",
    imap: imap ?? base.imap,
    smtp: smtp ?? base.smtp,
  };
}

export function loginUsername(
  email: string,
  provider: ProviderPreset,
  protocol: "imap" | "smtp" = "imap",
): string {
  const usernameMode = protocol === "imap"
    ? provider.imapUsernameMode
    : provider.smtpUsernameMode;
  const mode = usernameMode ?? provider.usernameMode ?? "email";
  return mode === "local" ? email.slice(0, email.lastIndexOf("@")) : email;
}
