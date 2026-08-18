import { describe, expect, it } from "vitest";
import { createDemoAccounts, createDemoSubmissions, demoMessageTranslation, demoMessages, demoStats } from "./demo";
import { findVerificationCodes } from "./verificationCode";
import { applyMessageMove, isArchivedMessage, isInboxMessage } from "./mailListState";

describe("demo mailbox data", () => {
  const demoAccounts = createDemoAccounts("zh-CN");
  it("keeps every displayed folder badge and unified stat aligned with the five demo messages", () => {
    const inboxMessages = demoMessages.filter((message) => isInboxMessage(message, demoAccounts));

    expect(demoStats).toMatchObject({
      accounts: demoAccounts.length,
      messages: inboxMessages.length,
      unread: inboxMessages.filter((message) => !message.seen).length,
    });

    for (const account of demoAccounts) {
      for (const folder of account.folders) {
        const messages = demoMessages.filter((message) => message.accountId === account.id && message.mailbox === folder.path);
        expect(folder.total).toBe(messages.length);
        expect(folder.unseen).toBe(messages.filter((message) => !message.seen).length);
      }
    }
  });

  it("keeps a demo archive move visible through iCloud Archive and Gmail All Mail targets", () => {
    const icloudArchive = demoAccounts.find((account) => account.id === "personal")?.folders.find((folder) => folder.specialUse === "\\Archive");
    const gmailAllMail = demoAccounts.find((account) => account.id === "work")?.folders.find((folder) => folder.specialUse === "\\All");
    const personalMessage = demoMessages.find((message) => message.accountId === "personal");
    const workMessage = demoMessages.find((message) => message.accountId === "work");

    expect(icloudArchive).toBeDefined();
    expect(gmailAllMail).toBeDefined();
    expect(personalMessage).toBeDefined();
    expect(workMessage).toBeDefined();

    const moved = applyMessageMove(demoAccounts, [personalMessage!], demoStats, personalMessage!.id, icloudArchive!.path, 9001);
    expect(moved.messages).toEqual([expect.objectContaining({ mailbox: icloudArchive!.path, uid: 9001 })]);
    expect(isArchivedMessage(moved.messages[0]!, moved.accounts)).toBe(true);

    const gmailMoved = applyMessageMove(demoAccounts, [workMessage!], demoStats, workMessage!.id, gmailAllMail!.path, 9002);
    expect(isArchivedMessage(gmailMoved.messages[0]!, gmailMoved.accounts)).toBe(true);
  });

  it("provides deterministic local translation previews without a network request", () => {
    const message = demoMessages.find((item) => item.id === "m2");
    expect(message).toBeDefined();
    expect(demoMessageTranslation(message!, "zh-CN")).toEqual({
      detectedLanguage: "en",
      translatedText: expect.stringContaining("更安静的导航方向"),
    });
    expect(demoMessageTranslation(message!, "en-US")).toEqual({
      detectedLanguage: "en",
      translatedText: expect.stringContaining("quieter navigation direction"),
    });
  });

  it("includes a demo message whose sign-in code is detected as a verification code", () => {
    const message = demoMessages.find((item) => item.id === "m7");
    expect(message).toBeDefined();
    const codes = findVerificationCodes({ subject: message!.subject, body: message!.textBody });
    expect(codes.some((candidate) => candidate.code === "483926")).toBe(true);
  });

  it("keeps zh-CN demo copy byte-identical to the established literals", () => {
    const zh = createDemoAccounts("zh-CN");
    const personal = zh.find((account) => account.id === "personal");
    expect(personal?.signature).toBe("——\n林晓\nNami Studio · 设计师");
    expect(personal?.folders.find((folder) => folder.path === "Drafts")?.name).toBe("草稿");
    expect(personal?.folders.find((folder) => folder.path === "Sent Messages")?.name).toBe("已发送");

    const zhSubmissions = createDemoSubmissions("zh-CN");
    expect(zhSubmissions.find((item) => item.deliveryStatus === "submitting")?.subject).toBe("周末行程与预订信息");
    expect(zhSubmissions.find((item) => item.deliveryStatus === "confirmed")?.subject).toBe("照片下载链接");
    expect(zhSubmissions.find((item) => item.deliveryStatus === "unknown_delivery")?.errorMessage)
      .toBe("发送连接在等待最终响应时中断，服务端是否接受邮件暂时无法确认。");
  });

  it("localizes demo accounts and submissions for the en-US locale", () => {
    const en = createDemoAccounts("en-US");
    const personal = en.find((account) => account.id === "personal");
    expect(personal?.folders.find((folder) => folder.path === "INBOX")?.name).toBe("Inbox");
    const work = en.find((account) => account.id === "work");
    expect(work?.folders.find((folder) => folder.path === "[Gmail]/All Mail")?.name).toBe("All Mail");
    expect(personal?.signature).toContain("Xiao Lin");
    expect(personal?.signature).not.toContain("林晓");

    const enSubmissions = createDemoSubmissions("en-US");
    expect(enSubmissions.find((item) => item.deliveryStatus === "confirmed")?.subject).toBe("Photo download link");
    expect(enSubmissions.find((item) => item.deliveryStatus === "unknown_delivery")?.errorMessage).toContain("connection");
  });
});
