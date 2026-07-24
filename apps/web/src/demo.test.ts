import { describe, expect, it } from "vitest";
import { demoAccounts, demoMessageTranslation, demoMessages, demoStats } from "./demo";
import { applyMessageMove, isArchivedMessage, isInboxMessage } from "./mailListState";

describe("demo mailbox data", () => {
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
});
