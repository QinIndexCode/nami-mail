import { describe, expect, it } from "vitest";
import {
  applyAutoReplyScope,
  autoReplyThreadKey,
  renderAutoReplyTemplate,
  scanSensitiveKeywords,
  screenAutoReply,
  screeningIgnoreReasonText,
  senderDomain,
  type AutoReplyScreeningInput,
} from "../src/agent/auto-reply-screening.js";

function input(overrides: Partial<AutoReplyScreeningInput> = {}): AutoReplyScreeningInput {
  return {
    mailbox: "INBOX",
    folderSpecialUse: null,
    subject: "Project review",
    fromAddress: "ada@example.test",
    autoSubmitted: "",
    listUnsubscribe: "",
    precedence: "",
    returnPath: "ada@example.test",
    labels: [],
    flags: [],
    inReplyTo: null,
    references: null,
    ...overrides,
  };
}

describe("auto-reply offline screening", () => {
  it("keeps ordinary inbox mail and anchors the thread key to the subject", () => {
    const result = screenAutoReply(input());
    expect(result).toEqual({ keep: true, threadKey: "subject:Project review" });
  });

  it("ignores messages in junk folders via special-use or folder path", () => {
    expect(screenAutoReply(input({ folderSpecialUse: "\\Junk" }))).toEqual({ keep: false, reason: "junk-folder" });
    expect(screenAutoReply(input({ folderSpecialUse: "\\Spam" }))).toEqual({ keep: false, reason: "junk-folder" });
    expect(screenAutoReply(input({ mailbox: "Junk" }))).toEqual({ keep: false, reason: "junk-folder" });
    expect(screenAutoReply(input({ mailbox: "junk" }))).toEqual({ keep: false, reason: "junk-folder" });
    expect(screenAutoReply(input({ mailbox: "INBOX/Junk" }))).toEqual({ keep: false, reason: "junk-folder" });
    expect(screenAutoReply(input({ mailbox: "INBOX/Spam" }))).toEqual({ keep: false, reason: "junk-folder" });
    expect(screenAutoReply(input({ mailbox: "INBOX/垃圾邮件" }))).toEqual({ keep: false, reason: "junk-folder" });
    expect(screenAutoReply(input({ mailbox: "Archive" })).keep).toBe(true);
  });

  it("ignores auto-submitted messages (alerts, auto-replies, bounces)", () => {
    expect(screenAutoReply(input({ autoSubmitted: "auto-generated" }))).toEqual({ keep: false, reason: "auto-submitted" });
  });

  it("ignores marketing mail via List-Unsubscribe and Precedence headers", () => {
    expect(screenAutoReply(input({ listUnsubscribe: "<https://list.example/unsub>" })))
      .toEqual({ keep: false, reason: "marketing-list" });
    expect(screenAutoReply(input({ precedence: "Bulk" }))).toEqual({ keep: false, reason: "marketing-precedence" });
    expect(screenAutoReply(input({ precedence: "list" }))).toEqual({ keep: false, reason: "marketing-precedence" });
    expect(screenAutoReply(input({ precedence: "JUNK" }))).toEqual({ keep: false, reason: "marketing-precedence" });
  });

  it("ignores Gmail category labels case-insensitively but keeps important mail", () => {
    expect(screenAutoReply(input({ labels: ["CATEGORY_PROMOTIONS"] }))).toEqual({ keep: false, reason: "gmail-category" });
    expect(screenAutoReply(input({ labels: ["category_updates"] }))).toEqual({ keep: false, reason: "gmail-category" });
    expect(screenAutoReply(input({ labels: ["CATEGORY_SOCIAL"] }))).toEqual({ keep: false, reason: "gmail-category" });
    expect(screenAutoReply(input({ labels: ["CATEGORY_IMPORTANT"] })).keep).toBe(true);
    expect(screenAutoReply(input({ labels: [] })).keep).toBe(true);
  });

  it("never replies to bounces reporting the empty reverse path", () => {
    expect(screenAutoReply(input({ returnPath: "<>" }))).toEqual({ keep: false, reason: "bounce" });
  });

  it("reports missing-sender mail when there is no envelope to judge", () => {
    expect(screenAutoReply(input({ fromAddress: "  " }))).toEqual({ keep: false, reason: "no-sender" });
    expect(screenAutoReply(input({ fromAddress: "", returnPath: "<>" }))).toEqual({ keep: false, reason: "no-sender" });
  });

  it("anchors the thread key to References, then In-Reply-To, then subject", () => {
    expect(screenAutoReply(input({ references: ["<root@example>", "<child@example>"] })))
      .toEqual({ keep: true, threadKey: "thread:<root@example>" });
    expect(screenAutoReply(input({ inReplyTo: "<parent@example>" })))
      .toEqual({ keep: true, threadKey: "thread:<parent@example>" });
    expect(screenAutoReply(input({ references: [] })))
      .toEqual({ keep: true, threadKey: "subject:Project review" });
    expect(autoReplyThreadKey(null, null, "  ")).toBeNull();
    expect(autoReplyThreadKey(null, [], "  Multiple   spaces  ")).toBe("subject:Multiple spaces");
  });

  it("flags sensitive keywords across subject, sender, and body", () => {
    const hits = scanSensitiveKeywords("Password reset", "alice@example.test", "enter the 验证码 below");
    expect(hits).toEqual(["password", "验证码"]);
    expect(scanSensitiveKeywords("nothing to see here")).toEqual([]);
    const many = scanSensitiveKeywords(
      "password passcode otp token payment invoice refund card 银行卡 信用卡 银行 资金 账户 锁定 冻结 挂失 api key",
    );
    expect(many).toHaveLength(8);
    expect(scanSensitiveKeywords("密码", "one-time code", "account recovery")).toEqual([
      "密码",
      "one-time code",
      "account recovery",
      "account",
    ]);
  });

  it("exposes Chinese reason text for the confirmation surface", () => {
    expect(screeningIgnoreReasonText("bounce")).toBe("退信");
    expect(screeningIgnoreReasonText("junk-folder")).toBe("垃圾邮件文件夹");
  });
});

describe("auto-reply user scope", () => {
  it("derives the sender domain from a bare address and ignores missing ones", () => {
    expect(senderDomain("ada@example.test")).toBe("example.test");
    expect(senderDomain("Ada Lovelace <ada@Example.TEST>")).toBe("example.test");
    expect(senderDomain("no-such-address")).toBe("");
  });

  it("keeps mail inside the date window and declines outside of it", () => {
    const base = {
      fromAddress: "ada@example.test",
      fromDomain: "example.test",
      subject: "Hello",
      today: "2026-08-10",
      contacts: new Set<string>(),
    };
    expect(applyAutoReplyScope(base, { startDate: "2026-08-01", endDate: "2026-08-31" })).toEqual({ keep: true });
    expect(applyAutoReplyScope(base, { startDate: "2026-08-11", endDate: null })).toEqual({ keep: false, reason: "outside-date-range" });
    expect(applyAutoReplyScope(base, { startDate: null, endDate: "2026-08-09" })).toEqual({ keep: false, reason: "outside-date-range" });
  });

  it("declines senders outside the address book when contactsOnly is set", () => {
    const input = {
      fromAddress: "stranger@example.test",
      fromDomain: "example.test",
      subject: "Hello",
      today: "2026-08-10",
      contacts: new Set(["ada@example.test"]),
    };
    expect(applyAutoReplyScope(input, { contactsOnly: true })).toEqual({ keep: false, reason: "not-contact" });
    expect(applyAutoReplyScope(input, { contactsOnly: false })).toEqual({ keep: true });
    expect(applyAutoReplyScope({ ...input, fromAddress: "ADA@example.test" }, { contactsOnly: true })).toEqual({ keep: true });
  });

  it("short-circuits on ignore rules before the whitelist is consulted", () => {
    const input = {
      fromAddress: "news@newsletter.test",
      fromDomain: "newsletter.test",
      subject: "Weekly digest",
      today: "2026-08-10",
      contacts: new Set<string>(),
    };
    const rules = [
      { id: "r1", field: "domain" as const, op: "contains" as const, value: "newsletter", action: "ignore" as const, enabled: true },
      { id: "r2", field: "domain" as const, op: "contains" as const, value: "vendor.test", action: "reply" as const, enabled: true },
    ];
    expect(applyAutoReplyScope(input, { rules })).toEqual({ keep: false, reason: "ignore-rule", ruleId: "r1" });
  });

  it("treats reply rules as an implicit whitelist", () => {
    const input = {
      fromAddress: "vendor@vendor.test",
      fromDomain: "vendor.test",
      subject: "Invoice",
      today: "2026-08-10",
      contacts: new Set<string>(),
    };
    const rules = [
      { id: "r1", field: "domain" as const, op: "contains" as const, value: "vendor.test", action: "reply" as const, enabled: true },
    ];
    expect(applyAutoReplyScope(input, { rules })).toEqual({ keep: true });
    expect(applyAutoReplyScope({ ...input, fromAddress: "other@elsewhere.test", fromDomain: "elsewhere.test" }, { rules }))
      .toEqual({ keep: false, reason: "not-in-whitelist" });
  });

  it("matches subject rules case-insensitively and honors not-contains/equals", () => {
    const input = {
      fromAddress: "a@example.test",
      fromDomain: "example.test",
      subject: "Quarterly Report",
      today: "2026-08-10",
      contacts: new Set<string>(),
    };
    const match = (op: "contains" | "not-contains" | "equals", value: string) =>
      applyAutoReplyScope(input, {
        rules: [{ id: "r", field: "subject" as const, op, value, action: "reply" as const, enabled: true }],
      });
    expect(match("contains", "report")).toEqual({ keep: true });
    expect(match("contains", "weekly")).toEqual({ keep: false, reason: "not-in-whitelist" });
    expect(match("not-contains", "weekly")).toEqual({ keep: true });
    expect(match("equals", "Quarterly Report")).toEqual({ keep: true });
    expect(match("equals", "quarterly report")).toEqual({ keep: true });
    expect(match("equals", "Report")).toEqual({ keep: false, reason: "not-in-whitelist" });
  });

  it("ignores disabled rules in both directions", () => {
    const input = {
      fromAddress: "a@example.test",
      fromDomain: "example.test",
      subject: "Hello",
      today: "2026-08-10",
      contacts: new Set<string>(),
    };
    const rules = [
      { id: "r1", field: "domain" as const, op: "contains" as const, value: "example", action: "ignore" as const, enabled: false },
      { id: "r2", field: "domain" as const, op: "contains" as const, value: "never", action: "reply" as const, enabled: false },
    ];
    expect(applyAutoReplyScope(input, { rules })).toEqual({ keep: true });
  });
});

describe("auto-reply template rendering", () => {
  const vars = {
    senderName: "Ada",
    senderAddress: "ada@example.test",
    senderDomain: "example.test",
    subject: "Hello",
  };

  it("substitutes every placeholder and trims the result", () => {
    expect(renderAutoReplyTemplate(
      "Hi {{senderName}} ({{senderAddress}}, {{senderDomain}}), re: {{subject}} — away now.",
      vars,
    )).toBe("Hi Ada (ada@example.test, example.test), re: Hello — away now.");
  });

  it("leaves unknown placeholders untouched and handles empty templates", () => {
    expect(renderAutoReplyTemplate("See {{senderName}} and {{typo}}", vars)).toBe("See Ada and {{typo}}");
    expect(renderAutoReplyTemplate("   ", vars)).toBe("");
  });
});
