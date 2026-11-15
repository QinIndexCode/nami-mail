import { describe, expect, it } from "vitest";
import {
  oauthProviderFor,
  providerAuthMethods,
  resolveOAuthEntry,
  validEmail,
  type OAuthEntryInput,
} from "./oauth-entry";

// Obviously fake addresses: tests never carry real credentials.
const OUTLOOK_EMAIL = "demo.user@outlook.com";
const GMAIL_EMAIL = "demo.user@gmail.com";
const QQ_EMAIL = "demo.user@qq.com";
const NETEASE_EMAIL = "demo.user@163.com";
const ICLOUD_EMAIL = "demo.user@icloud.com";
const CUSTOM_EMAIL = "demo.user@company.example";

function baseInput(overrides: Partial<OAuthEntryInput> = {}): OAuthEntryInput {
  return {
    discoveryEmail: "",
    normalizedEmail: "",
    discovery: null,
    activeDiscovery: undefined,
    matchedProvider: undefined,
    selectedProvider: undefined,
    selectedProviderId: "",
    explicitAuthMode: null,
    manualOpen: false,
    isGmail: false,
    ...overrides,
  };
}

const microsoftDiscovery: OAuthEntryInput["activeDiscovery"] = {
  id: "microsoft",
  family: "microsoft",
  authMethods: ["oauth2"],
  recommendedAuthMethod: "oauth2",
};

const microsoftProvider: OAuthEntryInput["matchedProvider"] = {
  id: "microsoft",
  authMethods: ["oauth2"],
  oauthAvailable: false,
};

/** The pre-fix inline chain, kept verbatim to prove valid-email behavior did not drift. */
function legacyEntry(input: OAuthEntryInput) {
  const activeOAuthProvider = input.discoveryEmail === input.normalizedEmail && input.discovery
    ? input.discovery.oauthProvider
    : input.activeDiscovery ? oauthProviderFor(input.activeDiscovery) : undefined;
  const oauthAvailable = input.discoveryEmail === input.normalizedEmail && input.discovery
    ? input.discovery.oauthAvailable
    : input.matchedProvider?.oauthAvailable ?? true;
  const needsProviderDiscovery = validEmail(input.normalizedEmail)
    && !input.matchedProvider
    && input.discoveryEmail !== input.normalizedEmail;
  const authMethods = input.activeDiscovery?.authMethods ?? providerAuthMethods(input.matchedProvider);
  const oauthOnly = Boolean(activeOAuthProvider) && authMethods.length > 0 && authMethods.every((method) => method === "oauth2");
  const canUsePassword = !oauthOnly;
  const providerPrefersOAuth = Boolean(
    activeOAuthProvider && oauthAvailable && input.activeDiscovery?.recommendedAuthMethod !== "app-password" && !input.isGmail
  );
  const showOAuthPanel = Boolean(
    activeOAuthProvider
    && !input.manualOpen
    && (input.explicitAuthMode === "oauth" || (input.explicitAuthMode === null && providerPrefersOAuth))
  );
  const usingPassword = (validEmail(input.normalizedEmail) || Boolean(input.selectedProviderId) || Boolean(input.matchedProvider))
    && !needsProviderDiscovery
    && canUsePassword
    && (input.manualOpen || !showOAuthPanel);
  return { oauthOnly, canUsePassword, providerPrefersOAuth, showOAuthPanel, usingPassword };
}

describe("resolveOAuthEntry", () => {
  it("shows the OAuth panel for microsoft with a valid email even when oauth is unconfigured", () => {
    const entry = resolveOAuthEntry(baseInput({
      discoveryEmail: OUTLOOK_EMAIL,
      normalizedEmail: OUTLOOK_EMAIL,
      discovery: { oauthProvider: "microsoft", oauthAvailable: false },
      activeDiscovery: microsoftDiscovery,
      matchedProvider: microsoftProvider,
      selectedProviderId: "microsoft",
      selectedProvider: { id: "microsoft" },
    }));

    expect(entry.showOAuthPanel).toBe(true);
    expect(entry.providerPrefersOAuth).toBe(true);
    expect(entry.oauthOnly).toBe(true);
    expect(entry.canUsePassword).toBe(false);
    expect(entry.usingPassword).toBe(false);
    expect(entry.oauthAvailable).toBe(false);
  });

  it("keeps the panel and the enabled button path when microsoft oauth is configured", () => {
    const entry = resolveOAuthEntry(baseInput({
      discoveryEmail: OUTLOOK_EMAIL,
      normalizedEmail: OUTLOOK_EMAIL,
      discovery: { oauthProvider: "microsoft", oauthAvailable: true },
      activeDiscovery: microsoftDiscovery,
      matchedProvider: { id: "microsoft", authMethods: ["oauth2"], oauthAvailable: true },
      selectedProviderId: "microsoft",
      selectedProvider: { id: "microsoft" },
    }));

    expect(entry.oauthAvailable).toBe(true);
    expect(entry.showOAuthPanel).toBe(true);
    expect(entry.providerPrefersOAuth).toBe(true);
    expect(entry.canUsePassword).toBe(false);
    expect(entry.usingPassword).toBe(false);
  });

  it("hides the panel and the password field while the outlook email is still incomplete", () => {
    const entry = resolveOAuthEntry(baseInput({
      normalizedEmail: "@outlook.com",
      selectedProviderId: "microsoft",
      selectedProvider: { id: "microsoft" },
    }));

    expect(entry.showOAuthPanel).toBe(false);
    expect(entry.providerPrefersOAuth).toBe(false);
    expect(entry.oauthOnly).toBe(true);
    expect(entry.canUsePassword).toBe(false);
    expect(entry.usingPassword).toBe(false);
    expect(entry.needsProviderDiscovery).toBe(false);
  });

  it("keeps gmail on the password-first path", () => {
    const entry = resolveOAuthEntry(baseInput({
      discoveryEmail: GMAIL_EMAIL,
      normalizedEmail: GMAIL_EMAIL,
      discovery: { oauthProvider: "google", oauthAvailable: true },
      activeDiscovery: {
        id: "gmail",
        family: "google",
        authMethods: ["app-password", "oauth2"],
        recommendedAuthMethod: "app-password",
      },
      matchedProvider: { id: "gmail", authMethods: ["app-password", "oauth2"], oauthAvailable: true },
      selectedProviderId: "gmail",
      isGmail: true,
    }));

    expect(entry.providerPrefersOAuth).toBe(false);
    expect(entry.showOAuthPanel).toBe(false);
    expect(entry.oauthOnly).toBe(false);
    expect(entry.canUsePassword).toBe(true);
    expect(entry.usingPassword).toBe(true);
  });

  it("treats a custom IMAP discovery as password-capable", () => {
    const entry = resolveOAuthEntry(baseInput({
      discoveryEmail: CUSTOM_EMAIL,
      normalizedEmail: CUSTOM_EMAIL,
      discovery: { oauthAvailable: false },
      activeDiscovery: {
        id: "custom",
        family: "custom",
        authMethods: ["password", "app-password", "client-authorization-code"],
        recommendedAuthMethod: "password",
      },
      selectedProviderId: "__custom_imap__",
    }));

    expect(entry.oauthOnly).toBe(false);
    expect(entry.canUsePassword).toBe(true);
    expect(entry.usingPassword).toBe(true);
    expect(entry.showOAuthPanel).toBe(false);
  });

  it("respects an explicit password choice for microsoft", () => {
    const entry = resolveOAuthEntry(baseInput({
      discoveryEmail: OUTLOOK_EMAIL,
      normalizedEmail: OUTLOOK_EMAIL,
      discovery: { oauthProvider: "microsoft", oauthAvailable: true },
      activeDiscovery: microsoftDiscovery,
      matchedProvider: { id: "microsoft", authMethods: ["oauth2"], oauthAvailable: true },
      selectedProviderId: "microsoft",
      explicitAuthMode: "password",
    }));

    expect(entry.providerPrefersOAuth).toBe(true);
    expect(entry.showOAuthPanel).toBe(false);
  });

  it("stays password-first when the provider recommends an app password", () => {
    const entry = resolveOAuthEntry(baseInput({
      discoveryEmail: GMAIL_EMAIL,
      normalizedEmail: GMAIL_EMAIL,
      discovery: { oauthProvider: "google", oauthAvailable: true },
      activeDiscovery: {
        id: "google-workspace",
        family: "google",
        authMethods: ["app-password", "oauth2"],
        recommendedAuthMethod: "app-password",
      },
      matchedProvider: { id: "google-workspace", authMethods: ["app-password", "oauth2"], oauthAvailable: true },
      isGmail: false,
    }));

    expect(entry.providerPrefersOAuth).toBe(false);
    expect(entry.showOAuthPanel).toBe(false);
    expect(entry.canUsePassword).toBe(true);
  });

  it("keeps the OAuth panel hidden while manual configuration is open", () => {
    const entry = resolveOAuthEntry(baseInput({
      discoveryEmail: OUTLOOK_EMAIL,
      normalizedEmail: OUTLOOK_EMAIL,
      discovery: { oauthProvider: "microsoft", oauthAvailable: true },
      activeDiscovery: microsoftDiscovery,
      matchedProvider: { id: "microsoft", authMethods: ["oauth2"], oauthAvailable: true },
      selectedProviderId: "microsoft",
      manualOpen: true,
    }));

    expect(entry.providerPrefersOAuth).toBe(true);
    expect(entry.showOAuthPanel).toBe(false);
  });

  it("matches the pre-fix chain for oauthOnly/usingPassword on every valid-email provider", () => {
    const cases: OAuthEntryInput[] = [
      baseInput({
        discoveryEmail: GMAIL_EMAIL,
        normalizedEmail: GMAIL_EMAIL,
        discovery: { oauthProvider: "google", oauthAvailable: true },
        activeDiscovery: {
          id: "gmail",
          family: "google",
          authMethods: ["app-password", "oauth2"],
          recommendedAuthMethod: "app-password",
        },
        matchedProvider: { id: "gmail", authMethods: ["app-password", "oauth2"], oauthAvailable: true },
        selectedProviderId: "gmail",
        isGmail: true,
      }),
      baseInput({
        discoveryEmail: QQ_EMAIL,
        normalizedEmail: QQ_EMAIL,
        activeDiscovery: { id: "qq", family: "tencent", authMethods: ["app-password"], recommendedAuthMethod: "app-password" },
        matchedProvider: { id: "qq", authMethods: ["app-password"] },
        selectedProviderId: "qq",
      }),
      baseInput({
        discoveryEmail: NETEASE_EMAIL,
        normalizedEmail: NETEASE_EMAIL,
        activeDiscovery: {
          id: "netease-163",
          family: "netease",
          authMethods: ["app-password"],
          recommendedAuthMethod: "app-password",
        },
        matchedProvider: { id: "netease-163", authMethods: ["app-password"] },
        selectedProviderId: "netease-163",
      }),
      baseInput({
        discoveryEmail: ICLOUD_EMAIL,
        normalizedEmail: ICLOUD_EMAIL,
        activeDiscovery: {
          id: "icloud",
          family: "apple",
          authMethods: ["app-password"],
          recommendedAuthMethod: "app-password",
        },
        matchedProvider: { id: "icloud", authMethods: ["app-password"] },
        selectedProviderId: "icloud",
      }),
      baseInput({
        discoveryEmail: CUSTOM_EMAIL,
        normalizedEmail: CUSTOM_EMAIL,
        discovery: { oauthAvailable: false },
        activeDiscovery: {
          id: "custom",
          family: "custom",
          authMethods: ["password", "app-password", "client-authorization-code"],
          recommendedAuthMethod: "password",
        },
        selectedProviderId: "__custom_imap__",
      }),
    ];

    for (const input of cases) {
      const entry = resolveOAuthEntry(input);
      const legacy = legacyEntry(input);
      expect({ email: input.normalizedEmail, ...entry }).toMatchObject({
        email: input.normalizedEmail,
        oauthOnly: legacy.oauthOnly,
        canUsePassword: legacy.canUsePassword,
        providerPrefersOAuth: legacy.providerPrefersOAuth,
        showOAuthPanel: legacy.showOAuthPanel,
        usingPassword: legacy.usingPassword,
      });
      expect(entry.oauthOnly).toBe(false);
      expect(entry.canUsePassword).toBe(true);
      expect(entry.usingPassword).toBe(true);
    }
  });
});
