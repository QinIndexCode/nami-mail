// Provider catalog copy (credential guidance, setup steps, help links) is
// authored once in the locale packs and referenced here by preset id. Both
// the live catalog (server API presets) and the demo catalog render through
// `localizedProviderOnboarding`, which resolves these keys in the active
// locale instead of shipping hardcoded Chinese prose to English UIs.

export type ProviderCopyField = "credentialLabel" | "credentialName" | "credentialHint" | "helpText" | "caveat" | "helpLabel";

export type ProviderCopyKeys = {
  [field in ProviderCopyField]?: string;
} & {
  setupSteps?: string[];
};

function key(id: string, field: string): string {
  return `provider.copy.${id}.${field}`;
}

function steps(id: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => key(id, `setupSteps.${index}`));
}

export const providerCopyKeys: Readonly<Record<string, ProviderCopyKeys>> = {
  gmail: {
    credentialLabel: key("gmail", "credentialLabel"), credentialName: key("gmail", "credentialName"), credentialHint: key("gmail", "credentialHint"),
    helpText: key("gmail", "helpText"), caveat: key("gmail", "caveat"), helpLabel: key("gmail", "helpLabel"), setupSteps: steps("gmail", 3),
  },
  icloud: {
    credentialLabel: key("icloud", "credentialLabel"), credentialName: key("icloud", "credentialName"), credentialHint: key("icloud", "credentialHint"),
    helpText: key("icloud", "helpText"), caveat: key("icloud", "caveat"), helpLabel: key("icloud", "helpLabel"), setupSteps: steps("icloud", 3),
  },
  qq: {
    credentialLabel: key("qq", "credentialLabel"), credentialName: key("qq", "credentialName"), credentialHint: key("qq", "credentialHint"),
    helpText: key("qq", "helpText"), caveat: key("qq", "caveat"), helpLabel: key("qq", "helpLabel"), setupSteps: steps("qq", 3),
  },
  "netease-163": {
    credentialLabel: key("netease-163", "credentialLabel"), credentialName: key("netease-163", "credentialName"), credentialHint: key("netease-163", "credentialHint"),
    helpText: key("netease-163", "helpText"), caveat: key("netease-163", "caveat"), helpLabel: key("netease-163", "helpLabel"), setupSteps: steps("netease-163", 3),
  },
  "netease-126": {
    credentialLabel: key("netease-126", "credentialLabel"), credentialName: key("netease-126", "credentialName"), credentialHint: key("netease-126", "credentialHint"),
    helpText: key("netease-126", "helpText"), helpLabel: key("netease-126", "helpLabel"), setupSteps: steps("netease-126", 3),
  },
  "netease-yeah": {
    credentialLabel: key("netease-yeah", "credentialLabel"), credentialName: key("netease-yeah", "credentialName"), credentialHint: key("netease-yeah", "credentialHint"),
    helpText: key("netease-yeah", "helpText"), helpLabel: key("netease-yeah", "helpLabel"), setupSteps: steps("netease-yeah", 3),
  },
  "netease-188": {
    credentialLabel: key("netease-188", "credentialLabel"), credentialName: key("netease-188", "credentialName"), credentialHint: key("netease-188", "credentialHint"),
    helpText: key("netease-188", "helpText"), caveat: key("netease-188", "caveat"), helpLabel: key("netease-188", "helpLabel"), setupSteps: steps("netease-188", 3),
  },
  "netease-vip-163": {
    credentialLabel: key("netease-vip-163", "credentialLabel"), credentialName: key("netease-vip-163", "credentialName"), credentialHint: key("netease-vip-163", "credentialHint"),
    helpText: key("netease-vip-163", "helpText"), helpLabel: key("netease-vip-163", "helpLabel"), setupSteps: steps("netease-vip-163", 3),
  },
  "netease-vip-126": {
    credentialLabel: key("netease-vip-126", "credentialLabel"), credentialName: key("netease-vip-126", "credentialName"), credentialHint: key("netease-vip-126", "credentialHint"),
    helpText: key("netease-vip-126", "helpText"), helpLabel: key("netease-vip-126", "helpLabel"), setupSteps: steps("netease-vip-126", 3),
  },
  microsoft: {
    credentialLabel: key("microsoft", "credentialLabel"), credentialName: key("microsoft", "credentialName"), credentialHint: key("microsoft", "credentialHint"),
    helpText: key("microsoft", "helpText"), caveat: key("microsoft", "caveat"), helpLabel: key("microsoft", "helpLabel"), setupSteps: steps("microsoft", 3),
  },
  yahoo: {
    credentialLabel: key("yahoo", "credentialLabel"), credentialName: key("yahoo", "credentialName"), credentialHint: key("yahoo", "credentialHint"),
    helpText: key("yahoo", "helpText"), caveat: key("yahoo", "caveat"), helpLabel: key("yahoo", "helpLabel"), setupSteps: steps("yahoo", 3),
  },
  aol: {
    credentialLabel: key("aol", "credentialLabel"), credentialName: key("aol", "credentialName"), credentialHint: key("aol", "credentialHint"),
    helpText: key("aol", "helpText"), caveat: key("aol", "caveat"), helpLabel: key("aol", "helpLabel"), setupSteps: steps("aol", 3),
  },
  fastmail: {
    credentialLabel: key("fastmail", "credentialLabel"), credentialName: key("fastmail", "credentialName"), credentialHint: key("fastmail", "credentialHint"),
    helpText: key("fastmail", "helpText"), caveat: key("fastmail", "caveat"), helpLabel: key("fastmail", "helpLabel"), setupSteps: steps("fastmail", 3),
  },
  zoho: {
    credentialLabel: key("zoho", "credentialLabel"), credentialName: key("zoho", "credentialName"), credentialHint: key("zoho", "credentialHint"),
    helpText: key("zoho", "helpText"), caveat: key("zoho", "caveat"), helpLabel: key("zoho", "helpLabel"), setupSteps: steps("zoho", 3),
  },
  sina: {
    credentialLabel: key("sina", "credentialLabel"), credentialName: key("sina", "credentialName"), credentialHint: key("sina", "credentialHint"),
    helpText: key("sina", "helpText"), helpLabel: key("sina", "helpLabel"), setupSteps: steps("sina", 3),
  },
  "sina-cn": {
    credentialLabel: key("sina-cn", "credentialLabel"), credentialName: key("sina-cn", "credentialName"), credentialHint: key("sina-cn", "credentialHint"),
    helpText: key("sina-cn", "helpText"), caveat: key("sina-cn", "caveat"), helpLabel: key("sina-cn", "helpLabel"), setupSteps: steps("sina-cn", 3),
  },
  "sina-vip": {
    credentialLabel: key("sina-vip", "credentialLabel"), credentialName: key("sina-vip", "credentialName"), credentialHint: key("sina-vip", "credentialHint"),
    helpText: key("sina-vip", "helpText"), helpLabel: key("sina-vip", "helpLabel"), setupSteps: steps("sina-vip", 3),
  },
  "sina-vip-cn": {
    credentialLabel: key("sina-vip-cn", "credentialLabel"), credentialName: key("sina-vip-cn", "credentialName"), credentialHint: key("sina-vip-cn", "credentialHint"),
    helpText: key("sina-vip-cn", "helpText"), caveat: key("sina-vip-cn", "caveat"), helpLabel: key("sina-vip-cn", "helpLabel"), setupSteps: steps("sina-vip-cn", 3),
  },
  sohu: {
    credentialLabel: key("sohu", "credentialLabel"), credentialName: key("sohu", "credentialName"), credentialHint: key("sohu", "credentialHint"),
    helpText: key("sohu", "helpText"), helpLabel: key("sohu", "helpLabel"), setupSteps: steps("sohu", 3),
  },
  "china-mobile-139": {
    credentialLabel: key("china-mobile-139", "credentialLabel"), credentialName: key("china-mobile-139", "credentialName"), credentialHint: key("china-mobile-139", "credentialHint"),
    helpText: key("china-mobile-139", "helpText"), caveat: key("china-mobile-139", "caveat"), helpLabel: key("china-mobile-139", "helpLabel"), setupSteps: steps("china-mobile-139", 3),
  },
  "china-telecom-189": {
    credentialLabel: key("china-telecom-189", "credentialLabel"), credentialName: key("china-telecom-189", "credentialName"), credentialHint: key("china-telecom-189", "credentialHint"),
    helpText: key("china-telecom-189", "helpText"), helpLabel: key("china-telecom-189", "helpLabel"), setupSteps: steps("china-telecom-189", 3),
  },
  aliyun: {
    credentialLabel: key("aliyun", "credentialLabel"), credentialName: key("aliyun", "credentialName"), credentialHint: key("aliyun", "credentialHint"),
    helpText: key("aliyun", "helpText"), helpLabel: key("aliyun", "helpLabel"), setupSteps: steps("aliyun", 3),
  },
  yandex: {
    credentialLabel: key("yandex", "credentialLabel"), credentialName: key("yandex", "credentialName"), credentialHint: key("yandex", "credentialHint"),
    helpText: key("yandex", "helpText"), helpLabel: key("yandex", "helpLabel"), setupSteps: steps("yandex", 3),
  },
  custom: {
    credentialLabel: key("custom", "credentialLabel"), credentialName: key("custom", "credentialName"), credentialHint: key("custom", "credentialHint"),
    helpText: key("custom", "helpText"), caveat: key("custom", "caveat"), setupSteps: steps("custom", 4),
  },
};