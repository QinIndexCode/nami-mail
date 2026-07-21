import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "./types";
import {
  CUSTOM_IMAP_PROVIDER_ID,
  orderedProviderCatalog,
  providerAuthLabel,
  providerMonogram,
  providerServerConfiguration,
  quickProviderCatalog,
  serverEndpointLabel,
} from "./providerOnboarding";

function provider(id: string, name: string, priority: "P0" | "P1" | "P2", domain = `${id}.example.com`): ProviderInfo {
  return {
    id,
    name,
    priority,
    domains: [domain],
    credentialHint: "credential hint",
    credentialName: "credential",
    setupSteps: [],
    basicAuthLimited: false,
  };
}

describe("provider onboarding catalog", () => {
  it("keeps the most common global and domestic P0 providers visible first", () => {
    const catalog = [
      provider("netease-163", "163 Mail", "P0"),
      provider("qq", "QQ Mail", "P0"),
      provider("icloud", "iCloud Mail", "P0"),
      provider("microsoft", "Outlook", "P0"),
      provider("gmail", "Gmail", "P0"),
      provider("netease-126", "126 Mail", "P0"),
      provider("yahoo", "Yahoo", "P0"),
      provider("sina", "Sina", "P1"),
    ];

    expect(quickProviderCatalog(catalog).map((item) => item.id)).toEqual([
      "gmail",
      "microsoft",
      "qq",
      "netease-163",
      "netease-126",
      "icloud",
    ]);
  });

  it("sorts the full catalog by priority without mutating the API result", () => {
    const source = [provider("p2", "Z", "P2"), provider("p0", "A", "P0"), provider("p1", "B", "P1")];
    expect(orderedProviderCatalog(source).map((item) => item.id)).toEqual(["p0", "p1", "p2"]);
    expect(source.map((item) => item.id)).toEqual(["p2", "p0", "p1"]);
  });

  it("labels authentication requirements without exposing raw protocol terms", () => {
    expect(providerAuthLabel("oauth2")).toBe("安全登录（OAuth2）");
    expect(providerAuthLabel("client-authorization-code")).toBe("客户端授权码");
    expect(providerMonogram(provider("gmail", "Gmail", "P0", "gmail.com"))).toBe("GM");
    expect(providerMonogram(provider("netease-163", "163 Mail", "P0", "163.com"))).toBe("163");
    expect(CUSTOM_IMAP_PROVIDER_ID).toBe("__custom_imap__");
  });

  it("formats a shareable server configuration without credentials", () => {
    const imap = { host: "imap.gmail.com", port: 993, transport: "tls" as const };
    const smtp = { host: "smtp.gmail.com", port: 587, transport: "starttls" as const };

    expect(serverEndpointLabel(imap)).toBe("imap.gmail.com:993 · TLS/SSL");
    expect(serverEndpointLabel(smtp)).toBe("smtp.gmail.com:587 · STARTTLS");
    expect(providerServerConfiguration("Gmail", imap, smtp)).toBe([
      "Gmail 邮件服务器设置",
      "IMAP（收件）",
      "服务器：imap.gmail.com",
      "端口：993",
      "加密：TLS/SSL",
      "SMTP（发件）",
      "服务器：smtp.gmail.com",
      "端口：587",
      "加密：STARTTLS",
    ].join("\n"));
  });
});
