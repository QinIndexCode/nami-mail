import { describe, expect, it } from "vitest";
import { agentScopeFor, currentThreadMessageIds, sameAgentScope } from "./agentContext";
import type { Account, Message } from "./types";

const account: Account = {
  id: "account-1",
  email: "mail@example.test",
  provider: "custom",
  providerName: "Custom",
  status: "connected",
  lastError: null,
  lastSyncedAt: null,
  createdAt: "2026-07-27T00:00:00.000Z",
  folders: [],
};

function message(id: string, messageId: string, references: string[] = [], inReplyTo?: string): Message {
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
    messageId,
    ...(inReplyTo ? { inReplyTo } : {}),
    references,
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
  it("builds a bounded, same-account thread context from loaded mail", () => {
    const root = message("root", "<root@example.test>");
    const reply = message("reply", "<reply@example.test>", ["<root@example.test>"], "<root@example.test>");
    const unrelated = { ...message("other", "<other@example.test>"), accountId: "account-2" };

    expect(currentThreadMessageIds(reply, [root, reply, unrelated])).toEqual(["reply", "root"]);
    expect(agentScopeFor("current_thread", reply, [root, reply, unrelated], [account])).toEqual({
      mode: "current_thread",
      accountIds: [account.id],
      messageIds: ["reply", "root"],
    });
  });

  it("keeps scopes exact so a changed context starts a separate conversation", () => {
    const current = message("current", "<current@example.test>");
    const messageScope = agentScopeFor("current_message", current, [current], [account]);
    const threadScope = agentScopeFor("current_thread", current, [current], [account]);

    expect(sameAgentScope(messageScope, { ...messageScope })).toBe(true);
    expect(sameAgentScope(messageScope, threadScope)).toBe(false);
  });
});
