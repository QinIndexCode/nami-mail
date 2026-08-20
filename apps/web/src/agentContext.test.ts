import { describe, expect, it } from "vitest";
import { agentScopeFor, sameAgentScope, scopeTargetForConversation } from "./agentContext";
import type { Account } from "./types";

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

const second: Account = {
  ...account,
  id: "account-2",
  email: "second@example.test",
};

describe("agent scope targets", () => {
  it("builds a selected_account scope from a concrete account target", () => {
    expect(agentScopeFor("account-1", [account, second])).toEqual({
      mode: "selected_account",
      accountIds: ["account-1"],
      messageIds: [],
    });
  });

  it("builds an all_accounts scope from the all target", () => {
    expect(agentScopeFor("all", [account, second])).toEqual({
      mode: "all_accounts",
      accountIds: ["account-1", "account-2"],
      messageIds: [],
    });
  });

  it("uses the target verbatim even when the account is not in the list", () => {
    expect(agentScopeFor("account-gone", [account])).toEqual({
      mode: "selected_account",
      accountIds: ["account-gone"],
      messageIds: [],
    });
  });

  it("maps stored scopes back to picker targets", () => {
    expect(scopeTargetForConversation({ mode: "all_accounts", accountIds: [], messageIds: [] }, [account])).toBe("all");
    expect(scopeTargetForConversation({ mode: "selected_account", accountIds: ["account-1"], messageIds: [] }, [account, second])).toBe("account-1");
    // A folded legacy scope resolves to its owner account...
    expect(scopeTargetForConversation({ mode: "current_message", accountIds: ["account-1"], messageIds: ["message-1"] }, [account])).toBe("account-1");
    // ...and a scope whose account was deleted falls back to all.
    expect(scopeTargetForConversation({ mode: "selected_account", accountIds: ["account-gone"], messageIds: [] }, [account])).toBe("all");
  });

  it("keeps scopes exact so a changed target starts a separate conversation", () => {
    const single = agentScopeFor("account-1", [account, second]);
    const all = agentScopeFor("all", [account, second]);

    expect(sameAgentScope(single, { ...single })).toBe(true);
    expect(sameAgentScope(single, all)).toBe(false);
  });
});