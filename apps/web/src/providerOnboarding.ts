import type { MailServerPreset, ProviderInfo } from "./types";

export const CUSTOM_IMAP_PROVIDER_ID = "__custom_imap__";

const QUICK_PROVIDER_IDS = [
  "gmail",
  "microsoft",
  "qq",
  "netease-163",
  "netease-126",
  "icloud",
];

const priorityWeight: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

export function orderedProviderCatalog(providers: ProviderInfo[]): ProviderInfo[] {
  return [...providers].sort((left, right) => {
    const priorityDelta = (priorityWeight[left.priority ?? ""] ?? 3) - (priorityWeight[right.priority ?? ""] ?? 3);
    if (priorityDelta !== 0) return priorityDelta;
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

export function quickProviderCatalog(providers: ProviderInfo[]): ProviderInfo[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const preferred = QUICK_PROVIDER_IDS.flatMap((id) => {
    const provider = byId.get(id);
    return provider ? [provider] : [];
  });
  const fallback = orderedProviderCatalog(providers).filter((provider) => (
    provider.priority === "P0" && !QUICK_PROVIDER_IDS.includes(provider.id)
  ));
  return [...preferred, ...fallback].slice(0, QUICK_PROVIDER_IDS.length);
}

export function providerAuthLabel(method?: string): string {
  switch (method) {
    case "oauth2":
      return "安全登录（OAuth2）";
    case "client-authorization-code":
      return "客户端授权码";
    case "app-password":
      return "应用专用密码";
    case "password":
      return "邮箱密码";
    default:
      return "请查看服务商要求";
  }
}

export function serverEndpointLabel(server: Pick<MailServerPreset, "host" | "port" | "transport">): string {
  return `${server.host}:${server.port} · ${server.transport === "tls" ? "TLS/SSL" : "STARTTLS"}`;
}

/** Formats only public server settings so users can share them without exposing credentials. */
export function providerServerConfiguration(
  providerName: string,
  imap: Pick<MailServerPreset, "host" | "port" | "transport">,
  smtp: Pick<MailServerPreset, "host" | "port" | "transport">,
): string {
  const details = (label: string, server: Pick<MailServerPreset, "host" | "port" | "transport">) => [
    label,
    `服务器：${server.host}`,
    `端口：${server.port}`,
    `加密：${server.transport === "tls" ? "TLS/SSL" : "STARTTLS"}`,
  ];

  return [
    `${providerName} 邮件服务器设置`,
    ...details("IMAP（收件）", imap),
    ...details("SMTP（发件）", smtp),
  ].join("\n");
}

export function providerMonogram(provider: ProviderInfo): string {
  const firstDomain = provider.domains[0]?.split(".")[0];
  if (firstDomain) return /^\d{3}$/.test(firstDomain) ? firstDomain : firstDomain.slice(0, 2).toUpperCase();
  return provider.name.slice(0, 2).toUpperCase();
}
