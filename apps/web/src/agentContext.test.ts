import { describe, expect, it } from "vitest";
import { agentScopeFor, sameAgentScope } from "./agentContext";
import type { Account, Message } from "./types";

const account: Account = {
  id: "account-1",
  email: "mail@example.test",
  provider: "custom",
  providerName: "Custom",
  status: "connected",
  lastError: null,
  lastSyncedAt: null,
  signature: "",
  createdAt: "2026-07-27T00:00:00.000Z",
  folders: [],
};

function message(id: string): Message {
  return {
    id,
    accountId: account.id,
    accountEmail: account.email,
    providerName: account.providerName,
    mailbox: "INBOX",
    uid: 1,
    subject: id,
    from: { name: "Sender", address: "sender@example.test" },
    to: [],
    cc: [],
    messageId: `<${id}@example.test>`,
    sentAt: "2026-07-27T00:00:00.000Z",
    snippet: "",
    textBody: "",
    htmlBody: "",
    flags: [],
    seen: false,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 0,
  };
}

describe("Agent mail context", () => {
  it("builds a bounded message scope from the current message", () => {
    const current = message("current");

    expect(agentScopeFor("current_message", current, [account])).toEqual({
      mode: "current_message",
      accountIds: [account.id],
      messageIds: ["current"],
    });
  });

  it("falls back to all accounts without a selected message", () => {
    expect(agentScopeFor("all_accounts", undefined, [account])).toEqual({
      mode: "all_accounts",
      accountIds: [account.id],
      messageIds: [],
    });
  });

  it("keeps scopes exact so a changed context starts a separate conversation", () => {
    const current = message("current");
    const messageScope = agentScopeFor("current_message", current, [account]);
    const allScope = agentScopeFor("all_accounts", undefined, [account]);

    expect(sameAgentScope(messageScope, { ...messageScope })).toBe(true);
    expect(sameAgentScope(messageScope, allScope)).toBe(false);
  });
});
