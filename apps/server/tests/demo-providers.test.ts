import { describe, expect, it } from "vitest";
// 收窄到纯数据模块：demo.ts 会经 i18n.tsx 引入 Vite 专有的 import.meta.glob 与 React，
// 脱离 Vite 管道（tsx / 编译后直跑）即失败。这里只需要比对目录数据本身。
import { demoProviderCatalog as demoProviders } from "../../web/src/demoProviderCatalog.js";
import { providerPresets } from "../src/providers.js";

function comparableProvider(provider: typeof providerPresets[number] | typeof demoProviders[number]) {
  return {
    id: provider.id,
    name: provider.name,
    family: provider.family,
    priority: provider.priority,
    domains: provider.domains,
    imap: provider.imap,
    smtp: provider.smtp,
    authMethods: provider.authMethods,
    recommendedAuthMethod: provider.recommendedAuthMethod,
    credentialLabel: provider.credentialLabel,
    helpText: provider.helpText,
    caveat: provider.caveat,
    capabilities: provider.capabilities,
    credentialHint: provider.credentialHint,
    credentialName: provider.credentialName,
    setupSteps: provider.setupSteps,
    helpUrl: provider.helpUrl,
    helpLabel: provider.helpLabel,
    usernameMode: provider.usernameMode ?? "email",
    imapUsernameMode: provider.imapUsernameMode ?? provider.usernameMode ?? "email",
    smtpUsernameMode: provider.smtpUsernameMode ?? provider.usernameMode ?? "email",
    basicAuthLimited: Boolean(provider.basicAuthLimited),
  };
}

describe("demo provider catalog", () => {
  it("mirrors every production preset and its onboarding guidance", () => {
    expect(demoProviders.map(comparableProvider)).toEqual(providerPresets.map(comparableProvider));
  });

  it("enables the demo OAuth routes that can complete locally", () => {
    expect(demoProviders.find((provider) => provider.id === "gmail")).toMatchObject({ oauthProvider: "google", oauthAvailable: true });
    expect(demoProviders.find((provider) => provider.id === "microsoft")).toMatchObject({ oauthProvider: "microsoft", oauthAvailable: true });
  });
});
