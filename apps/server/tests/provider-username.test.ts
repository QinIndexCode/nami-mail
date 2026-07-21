import { describe, expect, it } from "vitest";
import { detectProvider, loginUsername } from "../src/providers.js";

describe("provider protocol usernames", () => {
  it("uses iCloud's local-part IMAP username and full-email SMTP username", () => {
    const provider = detectProvider("nami@icloud.com");

    expect(provider.imapUsernameMode).toBe("local");
    expect(provider.smtpUsernameMode).toBe("email");
    expect(loginUsername("nami@icloud.com", provider, "imap")).toBe("nami");
    expect(loginUsername("nami@icloud.com", provider, "smtp")).toBe("nami@icloud.com");
  });

  it("uses the full email address for both Yandex protocols", () => {
    const provider = detectProvider("nami@yandex.com");

    expect(provider.imapUsernameMode ?? provider.usernameMode ?? "email").toBe("email");
    expect(provider.smtpUsernameMode ?? provider.usernameMode ?? "email").toBe("email");
    expect(loginUsername("nami@yandex.com", provider, "imap")).toBe("nami@yandex.com");
    expect(loginUsername("nami@yandex.com", provider, "smtp")).toBe("nami@yandex.com");
  });

  it("keeps a legacy shared username rule for older presets", () => {
    const provider = {
      ...detectProvider("nami@icloud.com"),
      imapUsernameMode: undefined,
      smtpUsernameMode: undefined,
      usernameMode: "local" as const,
    };

    expect(loginUsername("nami@icloud.com", provider, "imap")).toBe("nami");
    expect(loginUsername("nami@icloud.com", provider, "smtp")).toBe("nami");
  });
});
