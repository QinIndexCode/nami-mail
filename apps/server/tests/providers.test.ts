import { describe, expect, it } from "vitest";
import {
  detectProvider,
  loginUsername,
  resolveProvider,
  type ProviderDnsResolver,
} from "../src/providers.js";

const emptyResolver: ProviderDnsResolver = {
  resolveSrv: async () => [],
  resolveMx: async () => [],
};

describe("provider detection", () => {
  it.each([
    ["hello@gmail.com", "gmail", "imap.gmail.com", "P0"],
    ["hello@googlemail.com", "gmail", "imap.gmail.com", "P0"],
    ["hello@icloud.com", "icloud", "imap.mail.me.com", "P0"],
    ["hello@me.com", "icloud", "imap.mail.me.com", "P0"],
    ["hello@mac.com", "icloud", "imap.mail.me.com", "P0"],
    ["hello@qq.com", "qq", "imap.qq.com", "P0"],
    ["hello@vip.qq.com", "qq", "imap.qq.com", "P0"],
    ["hello@foxmail.com", "qq", "imap.qq.com", "P0"],
    ["hello@163.com", "netease-163", "imap.163.com", "P0"],
    ["hello@126.com", "netease-126", "imap.126.com", "P0"],
    ["hello@yeah.net", "netease-yeah", "imap.yeah.net", "P0"],
    ["hello@outlook.com", "microsoft", "outlook.office365.com", "P0"],
    ["hello@hotmail.com", "microsoft", "outlook.office365.com", "P0"],
    ["hello@live.com", "microsoft", "outlook.office365.com", "P0"],
    ["hello@msn.com", "microsoft", "outlook.office365.com", "P0"],
    ["hello@contoso.onmicrosoft.com", "microsoft", "outlook.office365.com", "P0"],
    ["hello@yahoo.com", "yahoo", "imap.mail.yahoo.com", "P0"],
    ["hello@aol.com", "aol", "imap.aol.com", "P0"],
    ["hello@fastmail.com", "fastmail", "imap.fastmail.com", "P0"],
    ["hello@zoho.com", "zoho", "imap.zoho.com", "P0"],
    ["hello@zohomail.com", "zoho", "imap.zoho.com", "P0"],
    ["hello@sina.com", "sina", "imap.sina.com", "P0"],
    ["hello@sina.cn", "sina-cn", "imap.sina.cn", "P0"],
    ["hello@188.com", "netease-188", "imap.188.com", "P1"],
    ["hello@vip.163.com", "netease-vip-163", "imap.vip.163.com", "P1"],
    ["hello@vip.126.com", "netease-vip-126", "imap.vip.126.com", "P1"],
    ["hello@vip.sina.com", "sina-vip", "imap.vip.sina.com", "P1"],
    ["hello@vip.sina.cn", "sina-vip-cn", "imap.vip.sina.cn", "P1"],
    ["hello@sohu.com", "sohu", "imap.sohu.com", "P1"],
    ["hello@139.com", "china-mobile-139", "imap.139.com", "P1"],
    ["hello@189.cn", "china-telecom-189", "imap.189.cn", "P1"],
    ["hello@aliyun.com", "aliyun", "imap.aliyun.com", "P1"],
  ])("detects %s as %s (%s)", (email, id, imapHost, priority) => {
    const provider = detectProvider(email);

    expect(provider.id).toBe(id);
    expect(provider.priority).toBe(priority);
    expect(provider.imap.host).toBe(imapHost);
    expect(provider.source).toBe("preset");
    expect(provider.confidence).toBe("high");
  });

  it("keeps 163.net out of the NetEase family", () => {
    const provider = detectProvider("hello@163.net");

    expect(provider.id).toBe("custom");
    expect(provider.family).toBe("custom");
    expect(provider.imap.host).toBe("imap.163.net");
  });

  it("keeps Yahoo Japan on conservative manual discovery", () => {
    const provider = detectProvider("hello@yahoo.co.jp");

    expect(provider.id).toBe("custom");
    expect(provider.imap.host).toBe("imap.yahoo.co.jp");
    expect(provider.smtp.host).toBe("smtp.yahoo.co.jp");
    expect(provider.source).toBe("conventional");
  });

  it("uses TLS for Outlook IMAP and STARTTLS for Outlook SMTP", () => {
    const provider = detectProvider("hello@outlook.com");

    expect(provider.imap).toMatchObject({
      host: "outlook.office365.com",
      port: 993,
      transport: "tls",
      secure: true,
    });
    expect(provider.smtp).toMatchObject({
      host: "smtp-mail.outlook.com",
      port: 587,
      transport: "starttls",
      secure: false,
    });
  });

  it("recognizes Microsoft 365 tenant domains without waiting for DNS discovery", () => {
    const provider = detectProvider("member@contoso.onmicrosoft.com");

    expect(provider).toMatchObject({
      id: "microsoft",
      name: "Microsoft 365",
      family: "microsoft",
      isCustom: false,
      source: "preset",
      confidence: "high",
      imap: { host: "outlook.office365.com", port: 993, transport: "tls" },
      smtp: { host: "smtp.office365.com", port: 587, transport: "starttls" },
    });
  });

  it("keeps Yahoo and Zoho on the supported credential paths", () => {
    const yahoo = detectProvider("hello@yahoo.com");
    expect(yahoo).toMatchObject({
      authMethods: ["app-password"],
      recommendedAuthMethod: "app-password",
      credentialLabel: "Yahoo 第三方应用密码",
    });
    expect(yahoo.credentialHint).toContain("第三方应用密码");

    const zoho = detectProvider("hello@zoho.com");
    expect(zoho).toMatchObject({
      authMethods: ["app-password", "password"],
      recommendedAuthMethod: "app-password",
      credentialLabel: "Zoho 应用专用密码或邮箱密码",
    });
    expect(zoho.credentialHint).toContain("邮箱密码");
    expect(zoho.capabilities.apis).not.toContain("zoho-api");
  });

  it("falls back to conventional IMAP/SMTP hostnames", () => {
    const provider = detectProvider("hello@example.org");

    expect(provider.isCustom).toBe(true);
    expect(provider.imap.host).toBe("imap.example.org");
    expect(provider.smtp.host).toBe("smtp.example.org");
  });

  it("does not advertise OAuth for generic providers without an OAuth connection flow", () => {
    const provider = detectProvider("hello@example.org");

    expect(provider.authMethods).toEqual(["password", "app-password", "client-authorization-code"]);
    expect(provider.helpText).not.toContain("OAuth");
    expect(provider.setupSteps.at(-1)).toContain("仅 Google 和 Microsoft");
  });

  it("uses the local part for iCloud IMAP", () => {
    const provider = detectProvider("hello@icloud.com");
    expect(loginUsername("hello@icloud.com", provider)).toBe("hello");
  });

  it("uses the full address for Yandex IMAP", () => {
    const provider = detectProvider("hello@yandex.com");
    expect(loginUsername("hello@yandex.com", provider)).toBe("hello@yandex.com");
  });
});

describe("provider discovery", () => {
  it("uses the Microsoft 365 STARTTLS endpoint for an MX-detected custom domain", async () => {
    const resolver: ProviderDnsResolver = {
      ...emptyResolver,
      resolveMx: async () => [{ exchange: "m365-test.mail.protection.outlook.com.", priority: 10 }],
    };

    const provider = await resolveProvider("hello@m365.test", resolver);

    expect(provider.smtp).toEqual({
      host: "smtp.office365.com",
      port: 587,
      transport: "starttls",
      secure: false,
    });
  });

  it("uses the lowest-priority usable SRV target for IMAP and SMTP", async () => {
    const resolver: ProviderDnsResolver = {
      resolveSrv: async (hostname) => {
        if (hostname === "_imaps._tcp.company.test") {
          return [
            { name: "imap-high.company.test.", port: 993, priority: 20, weight: 99 },
            { name: "imap-low.company.test.", port: 993, priority: 10, weight: 1 },
          ];
        }
        if (hostname === "_submissions._tcp.company.test") {
          return [
            { name: "smtp-high.company.test.", port: 465, priority: 20, weight: 99 },
            { name: "smtp-low.company.test.", port: 465, priority: 10, weight: 1 },
          ];
        }
        return [];
      },
      resolveMx: async () => [],
    };

    const provider = await resolveProvider("hello@company.test", resolver);

    expect(provider.source).toBe("srv");
    expect(provider.confidence).toBe("high");
    expect(provider.imap).toMatchObject({
      host: "imap-low.company.test",
      port: 993,
      transport: "tls",
    });
    expect(provider.smtp).toMatchObject({
      host: "smtp-low.company.test",
      port: 465,
      transport: "tls",
    });
  });

  it.each([
    ["workspace.test", "aspmx.l.google.com.", "gmail", "Google Workspace", "imap.gmail.com"],
    [
      "m365.test",
      "m365-test.mail.protection.outlook.com.",
      "microsoft",
      "Microsoft 365",
      "outlook.office365.com",
    ],
    [
      "fastmail-domain.test",
      "in1-smtp.messagingengine.com.",
      "fastmail",
      "Fastmail custom domain",
      "imap.fastmail.com",
    ],
    ["zoho-domain.test", "mx.zoho.eu.", "zoho", "Zoho Mail custom domain", "imap.zoho.com"],
  ])("recognizes %s from MX", async (domain, exchange, id, name, imapHost) => {
    const resolver: ProviderDnsResolver = {
      ...emptyResolver,
      resolveMx: async () => [{ exchange, priority: 10 }],
    };

    const provider = await resolveProvider(`hello@${domain}`, resolver);

    expect(provider).toMatchObject({
      id,
      name,
      domain,
      isCustom: true,
      source: "mx",
      confidence: "medium",
    });
    expect(provider.imap.host).toBe(imapHost);
  });

  it("falls back cleanly when all discovery queries fail", async () => {
    const resolver: ProviderDnsResolver = {
      resolveSrv: async () => {
        throw new Error("SRV unavailable");
      },
      resolveMx: async () => {
        throw new Error("MX unavailable");
      },
    };

    const provider = await resolveProvider("hello@offline.test", resolver);

    expect(provider).toMatchObject({
      id: "custom",
      domain: "offline.test",
      isCustom: true,
      source: "conventional",
      confidence: "low",
    });
    expect(provider.imap.host).toBe("imap.offline.test");
    expect(provider.smtp.host).toBe("smtp.offline.test");
  });
});
