import { describe, expect, it } from "vitest";
import { demoAccounts, demoMessages, demoStats } from "./demo";
import { isInboxMessage } from "./mailListState";

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
});
