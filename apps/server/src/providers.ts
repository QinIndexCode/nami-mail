import { promises as dns } from "node:dns";

export type MailServerConfig = {
  host: string;
  port: number;
  secure: boolean;
};

export type ProviderPreset = {
  id: string;
  name: string;
  domains: string[];
  imap: MailServerConfig;
  smtp: MailServerConfig;
  credentialHint: string;
  credentialName: string;
  setupSteps: string[];
  helpUrl?: string;
  helpLabel?: string;
  usernameMode?: "email" | "local";
  basicAuthLimited?: boolean;
};

export const providerPresets: ProviderPreset[] = [
  {
    id: "gmail",
    name: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    credentialHint: "请使用开启两步验证后生成的 16 位应用专用密码",
    credentialName: "16 位应用专用密码",
    setupSteps: [
      "打开 Google 账户的“安全性”，先启用两步验证。",
      "进入“应用专用密码”，应用名称填写 Nami Mail 并生成。",
      "复制生成的 16 位密码，粘贴到下方密码框；显示空格不属于密码。",
    ],
    helpUrl: "https://myaccount.google.com/apppasswords",
    helpLabel: "打开 Google 应用专用密码",
  },
  {
    id: "icloud",
    name: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    credentialHint: "请使用 Apple 账户生成的应用专用密码",
    credentialName: "App 专用密码",
    setupSteps: [
      "确认 Apple 账户已经开启双重认证。",
      "登录 Apple 账户，在“登录与安全”中选择“App 专用密码”。",
      "为 Nami Mail 生成密码，将完整结果粘贴到下方密码框。",
    ],
    helpUrl: "https://account.apple.com/account/manage",
    helpLabel: "打开 Apple 账户安全设置",
    usernameMode: "local",
  },
  {
    id: "qq",
    name: "QQ Mail",
    domains: ["qq.com", "foxmail.com"],
    imap: { host: "imap.qq.com", port: 993, secure: true },
    smtp: { host: "smtp.qq.com", port: 465, secure: true },
    credentialHint: "请使用 QQ 邮箱设置中生成的授权码",
    credentialName: "16 位客户端授权码",
    setupSteps: [
      "登录 QQ 邮箱网页版，进入“设置 → 账号”。",
      "找到 POP3/IMAP/SMTP 服务，开启 IMAP/SMTP 并完成安全验证。",
      "复制生成的 16 位授权码，区分大小写，粘贴到下方密码框。",
    ],
    helpUrl: "https://mail.qq.com/",
    helpLabel: "打开 QQ 邮箱设置",
  },
  {
    id: "netease-163",
    name: "163 Mail",
    domains: ["163.com"],
    imap: { host: "imap.163.com", port: 993, secure: true },
    smtp: { host: "smtp.163.com", port: 465, secure: true },
    credentialHint: "请使用客户端授权密码，而不是网页登录密码",
    credentialName: "客户端授权密码",
    setupSteps: [
      "登录 163 邮箱网页版，进入“设置 → POP3/SMTP/IMAP”。",
      "开启 IMAP/SMTP 服务，并按提示完成手机安全验证。",
      "设置或复制客户端授权密码，用它代替网页登录密码。",
    ],
    helpUrl: "https://mail.163.com/",
    helpLabel: "打开 163 邮箱设置",
  },
  {
    id: "netease-126",
    name: "126 Mail",
    domains: ["126.com"],
    imap: { host: "imap.126.com", port: 993, secure: true },
    smtp: { host: "smtp.126.com", port: 465, secure: true },
    credentialHint: "请使用客户端授权密码，而不是网页登录密码",
    credentialName: "客户端授权密码",
    setupSteps: [
      "登录 126 邮箱网页版，进入邮箱设置。",
      "开启 IMAP/SMTP 服务，并完成手机安全验证。",
      "设置客户端授权密码，用它代替网页登录密码。",
    ],
    helpUrl: "https://mail.126.com/",
    helpLabel: "打开 126 邮箱设置",
  },
  {
    id: "netease-yeah",
    name: "Yeah Mail",
    domains: ["yeah.net"],
    imap: { host: "imap.yeah.net", port: 993, secure: true },
    smtp: { host: "smtp.yeah.net", port: 465, secure: true },
    credentialHint: "请使用客户端授权密码，而不是网页登录密码",
    credentialName: "客户端授权密码",
    setupSteps: [
      "登录 Yeah 邮箱网页版，进入邮箱设置。",
      "开启 IMAP/SMTP 服务，并完成手机安全验证。",
      "设置客户端授权密码，用它代替网页登录密码。",
    ],
    helpUrl: "https://www.yeah.net/",
    helpLabel: "打开 Yeah 邮箱设置",
  },
  {
    id: "microsoft",
    name: "Outlook / Hotmail",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "office365.com"],
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
    credentialHint: "Microsoft 通常要求 OAuth2；普通密码可能被服务器拒绝",
    credentialName: "应用密码（可能仍被拒绝）",
    setupSteps: [
      "Microsoft 已对大多数 IMAP 账户停用基础密码认证。",
      "即使开启两步验证并生成应用密码，组织策略仍可能拒绝连接。",
      "若连接失败，需要使用 OAuth 2.0；当前严格双字段模式无法完成 OAuth 授权。",
    ],
    helpUrl: "https://support.microsoft.com/en-US/accounts-billing/manage/how-to-get-and-use-app-passwords",
    helpLabel: "查看 Microsoft 官方说明",
    basicAuthLimited: true,
  },
  {
    id: "yahoo",
    name: "Yahoo Mail",
    domains: ["yahoo.com", "yahoo.co.jp", "ymail.com"],
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
    credentialHint: "请使用 Yahoo 生成的应用密码",
    credentialName: "第三方应用密码",
    setupSteps: [
      "登录 Yahoo 账户安全页面。",
      "在“外部连接”中选择创建应用密码，并命名为 Nami Mail。",
      "复制生成的密码，粘贴到下方密码框。",
    ],
    helpUrl: "https://login.yahoo.com/account/security",
    helpLabel: "打开 Yahoo 账户安全",
  },
  {
    id: "aol",
    name: "AOL Mail",
    domains: ["aol.com"],
    imap: { host: "imap.aol.com", port: 993, secure: true },
    smtp: { host: "smtp.aol.com", port: 465, secure: true },
    credentialHint: "请使用 AOL 账户生成的应用密码",
    credentialName: "第三方应用密码",
    setupSteps: [
      "登录 AOL 账户安全页面，打开账户安全设置。",
      "创建用于 Nami Mail 的应用密码，而不是填写网页登录密码。",
      "复制生成的密码并粘贴到下方密码框。",
    ],
    helpUrl: "https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail",
    helpLabel: "查看 AOL 官方邮件客户端设置",
  },
  {
    id: "fastmail",
    name: "Fastmail",
    domains: ["fastmail.com"],
    imap: { host: "imap.fastmail.com", port: 993, secure: true },
    smtp: { host: "smtp.fastmail.com", port: 465, secure: true },
    credentialHint: "请使用 Fastmail 的应用专用密码；Basic 方案不支持第三方 IMAP/SMTP",
    credentialName: "应用专用密码",
    setupSteps: [
      "打开 Fastmail 设置中的密码与安全页面。",
      "创建一个仅用于邮件客户端的应用密码。",
      "Basic 方案不提供第三方 IMAP/SMTP；请确认账户方案支持该功能。",
    ],
    helpUrl: "https://www.fastmail.help/hc/en-us/articles/1500000278342",
    helpLabel: "查看 Fastmail 官方设置",
  },
  {
    id: "yandex",
    name: "Yandex Mail",
    domains: ["yandex.com", "yandex.ru", "ya.ru"],
    imap: { host: "imap.yandex.com", port: 993, secure: true },
    smtp: { host: "smtp.yandex.com", port: 465, secure: true },
    credentialHint: "请先启用 IMAP，再使用 Yandex 应用密码",
    credentialName: "应用专用密码",
    setupSteps: [
      "在 Yandex Mail 设置中启用“通过 imap.yandex.com 使用 IMAP”。",
      "在账户安全设置中开启应用密码，并创建邮件客户端密码。",
      "复制应用密码并粘贴到下方密码框；用户名使用邮箱地址的本地部分。",
    ],
    helpUrl: "https://yandex.com/support/yandex-360/customers/mail/en/mail-clients/others",
    helpLabel: "查看 Yandex 官方设置",
    usernameMode: "local",
  },
  {
    id: "zoho",
    name: "Zoho Mail",
    domains: ["zoho.com", "zohomail.com"],
    imap: { host: "imap.zoho.com", port: 993, secure: true },
    smtp: { host: "smtp.zoho.com", port: 465, secure: true },
    credentialHint: "开启两步验证时请使用应用专用密码",
    credentialName: "应用专用密码",
    setupSteps: [
      "登录 Zoho Accounts，进入“安全”。",
      "打开“应用专用密码”，为 Nami Mail 生成新密码。",
      "记录一次性显示的密码，并粘贴到下方密码框。",
    ],
    helpUrl: "https://accounts.zoho.com/home#security/app_password",
    helpLabel: "打开 Zoho 应用密码",
  },
];

export type DetectedProvider = ProviderPreset & { domain: string; isCustom: boolean };

export function emailDomain(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) throw new Error("请输入有效的邮箱地址。");
  return normalized.slice(at + 1);
}

export function detectProvider(email: string): DetectedProvider {
  const domain = emailDomain(email);
  const preset = providerPresets.find((item) => item.domains.includes(domain));
  if (preset) return { ...preset, domain, isCustom: false };
  return {
    id: "custom",
    name: domain,
    domains: [domain],
    domain,
    isCustom: true,
    imap: { host: `imap.${domain}`, port: 993, secure: true },
    smtp: { host: `smtp.${domain}`, port: 465, secure: true },
    credentialHint: "使用该邮箱服务商提供的密码或客户端授权码",
    credentialName: "邮箱密码或客户端授权码",
    setupSteps: [
      "登录邮箱服务商的网页设置，确认已经开启 IMAP 与 SMTP。",
      "如果账户启用了两步验证，请生成应用专用密码或客户端授权码。",
      "把生成的专用凭据粘贴到下方密码框，而不是填写一次性验证码。",
    ],
  };
}

async function firstSrv(name: string): Promise<MailServerConfig | null> {
  try {
    const records = await dns.resolveSrv(name);
    const record = records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
    if (!record) return null;
    return { host: record.name.replace(/\.$/, ""), port: record.port, secure: record.port === 993 || record.port === 465 };
  } catch {
    return null;
  }
}

export async function resolveProvider(email: string): Promise<DetectedProvider> {
  const detected = detectProvider(email);
  if (!detected.isCustom) return detected;
  const [imap, smtp] = await Promise.all([
    firstSrv(`_imaps._tcp.${detected.domain}`),
    firstSrv(`_submission._tcp.${detected.domain}`),
  ]);
  return { ...detected, imap: imap ?? detected.imap, smtp: smtp ?? detected.smtp };
}

export function loginUsername(email: string, provider: ProviderPreset): string {
  return provider.usernameMode === "local" ? email.slice(0, email.lastIndexOf("@")) : email;
}
