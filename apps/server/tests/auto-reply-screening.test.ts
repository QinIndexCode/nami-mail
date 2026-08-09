import { describe, expect, it } from "vitest";
import {
  autoReplyThreadKey,
  scanSensitiveKeywords,
  screenAutoReply,
  screeningIgnoreReasonText,
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
