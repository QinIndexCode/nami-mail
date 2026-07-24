import { hasTranslation, resolveLocale, translate, type Translate } from "./i18n";
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
const defaultTranslate: Translate = (key, values) => translate("zh-CN", key, values);
const defaultLocale = "zh-CN";

export function orderedProviderCatalog(providers: ProviderInfo[], locale = defaultLocale): ProviderInfo[] {
  return [...providers].sort((left, right) => {
    const priorityDelta = (priorityWeight[left.priority ?? ""] ?? 3) - (priorityWeight[right.priority ?? ""] ?? 3);
    if (priorityDelta !== 0) return priorityDelta;
    return left.name.localeCompare(right.name, locale);
  });
}

export function quickProviderCatalog(providers: ProviderInfo[], locale = defaultLocale): ProviderInfo[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const preferred = QUICK_PROVIDER_IDS.flatMap((id) => {
    const provider = byId.get(id);
    return provider ? [provider] : [];
  });
  const fallback = orderedProviderCatalog(providers, locale).filter((provider) => (
    provider.priority === "P0" && !QUICK_PROVIDER_IDS.includes(provider.id)
  ));
  return [...preferred, ...fallback].slice(0, QUICK_PROVIDER_IDS.length);
}

export function providerAuthLabel(method?: string, t: Translate = defaultTranslate): string {
  switch (method) {
    case "oauth2":
      return t("provider.auth.oauth2");
    case "client-authorization-code":
      return t("provider.auth.clientAuthorizationCode");
    case "app-password":
      return t("provider.auth.appPassword");
    case "password":
      return t("provider.auth.password");
    default:
      return t("provider.auth.unknown");
  }
}

export function serverEndpointLabel(server: Pick<MailServerPreset, "host" | "port" | "transport">, _t: Translate = defaultTranslate): string {
  return `${server.host}:${server.port} · ${server.transport === "tls" ? "TLS/SSL" : "STARTTLS"}`;
}

/** Formats only public server settings so users can share them without exposing credentials. */
export function providerServerConfiguration(
  providerName: string,
  imap: Pick<MailServerPreset, "host" | "port" | "transport">,
  smtp: Pick<MailServerPreset, "host" | "port" | "transport">,
  t: Translate = defaultTranslate,
): string {
  const details = (label: string, server: Pick<MailServerPreset, "host" | "port" | "transport">) => [
    label,
    t("provider.server.host", { host: server.host }),
    t("provider.server.port", { port: server.port }),
    t("provider.server.encryption", { transport: server.transport === "tls" ? "TLS/SSL" : "STARTTLS" }),
  ];

  return [
    t("provider.server.title", { provider: providerName }),
    ...details(t("provider.server.imap"), imap),
    ...details(t("provider.server.smtp"), smtp),
  ].join("\n");
}

export function providerMonogram(provider: ProviderInfo): string {
  const firstDomain = provider.domains[0]?.split(".")[0];
  if (firstDomain) return /^\d{3}$/.test(firstDomain) ? firstDomain : firstDomain.slice(0, 2).toUpperCase();
  return provider.name.slice(0, 2).toUpperCase();
}

type ProviderOnboardingSource = Pick<
  ProviderInfo,
  "id" | "name" | "credentialHint" | "credentialName" | "setupSteps" | "helpUrl" | "helpLabel" | "credentialLabel" | "helpText" | "caveat" | "recommendedAuthMethod"
>;

export type LocalizedProviderOnboarding = {
  name: string;
  credentialLabel: string;
  credentialName: string;
  credentialHint: string;
  setupSteps: string[];
  helpText?: string;
  caveat?: string;
  helpLabel?: string;
};

export function providerDisplayName(
  provider: Pick<ProviderOnboardingSource, "id" | "name">,
  locale: string,
  t: Translate,
): string {
  const key = `provider.name.${provider.id}`;
  return hasTranslation(locale, key) ? t(key) : provider.name;
}

function genericSetupSteps(providerName: string, method: string | undefined, t: Translate): string[] {
  if (method === "oauth2") {
    return [
      t("provider.setup.oauth.signIn", { provider: providerName }),
      t("provider.setup.oauth.authorize"),
      t("provider.setup.oauth.admin"),
    ];
  }
  if (method === "client-authorization-code") {
    return [
      t("provider.setup.clientCode.signIn", { provider: providerName }),
      t("provider.setup.clientCode.enable"),
      t("provider.setup.clientCode.paste"),
    ];
  }
  if (method === "app-password") {
    return [
      t("provider.setup.appPassword.signIn", { provider: providerName }),
      t("provider.setup.appPassword.create"),
      t("provider.setup.appPassword.paste"),
    ];
  }
  return [
    t("provider.setup.password.signIn", { provider: providerName }),
    t("provider.setup.password.enable"),
    t("provider.setup.password.paste"),
  ];
}

/**
 * Keeps server-delivered provider data intact for the default Chinese UI.
 * Other locales receive translated, credential-safe guidance instead of raw
 * Chinese provider prose, while endpoint values and official help links stay exact.
 */
export function localizedProviderOnboarding(
  provider: ProviderOnboardingSource,
  locale: string,
  t: Translate,
): LocalizedProviderOnboarding {
  if (resolveLocale(locale) === defaultLocale) {
    return {
      name: provider.name,
      credentialLabel: provider.credentialLabel ?? provider.credentialName,
      credentialName: provider.credentialName,
      credentialHint: provider.credentialHint,
      setupSteps: provider.setupSteps,
      helpText: provider.helpText,
      caveat: provider.caveat,
      helpLabel: provider.helpLabel,
    };
  }

  const name = providerDisplayName(provider, locale, t);
  const credential = providerAuthLabel(provider.recommendedAuthMethod, t);
  return {
    name,
    credentialLabel: credential,
    credentialName: credential,
    credentialHint: t("provider.generic.credentialHint", { credential }),
    setupSteps: genericSetupSteps(name, provider.recommendedAuthMethod, t),
    helpText: t("provider.generic.helpText", { provider: name }),
    caveat: provider.caveat ? t("provider.generic.caveat") : undefined,
    helpLabel: provider.helpUrl ? t("provider.generic.helpLink", { provider: name }) : provider.helpLabel,
  };
}
