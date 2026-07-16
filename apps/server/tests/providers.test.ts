import { describe, expect, it } from "vitest";
import { detectProvider, loginUsername } from "../src/providers.js";

describe("provider detection", () => {
  it.each([
    ["hello@gmail.com", "gmail", "imap.gmail.com"],
    ["hello@icloud.com", "icloud", "imap.mail.me.com"],
    ["hello@qq.com", "qq", "imap.qq.com"],
    ["hello@163.com", "netease-163", "imap.163.com"],
    ["hello@hotmail.com", "microsoft", "outlook.office365.com"],
    ["hello@aol.com", "aol", "imap.aol.com"],
    ["hello@fastmail.com", "fastmail", "imap.fastmail.com"],
    ["hello@yandex.com", "yandex", "imap.yandex.com"],
  ])("detects %s", (email, id, host) => {
    const provider = detectProvider(email);
    expect(provider.id).toBe(id);
    expect(provider.imap.host).toBe(host);
  });

  it("falls back to conventional IMAP/SMTP hostnames", () => {
    const provider = detectProvider("hello@example.org");
    expect(provider.isCustom).toBe(true);
    expect(provider.imap.host).toBe("imap.example.org");
    expect(provider.smtp.host).toBe("smtp.example.org");
  });

  it("uses the local part for iCloud IMAP", () => {
    const provider = detectProvider("hello@icloud.com");
    expect(loginUsername("hello@icloud.com", provider)).toBe("hello");
  });

  it("uses the local part for Yandex IMAP", () => {
    const provider = detectProvider("hello@yandex.com");
    expect(loginUsername("hello@yandex.com", provider)).toBe("hello");
  });

  it("uses the current Outlook submission endpoint", () => {
    expect(detectProvider("hello@outlook.com").smtp.host).toBe("smtp-mail.outlook.com");
  });
});
