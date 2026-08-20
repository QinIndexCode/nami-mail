import type { AgentConversationScope } from "./agentTypes";
import type { Account } from "./types";

/**
 * The header scope picker's selection: a concrete account id, or "all" for
 * every connected account. Mail references (explicitly introduced messages)
 * are independent of this boundary and do not influence the scope.
 */
export type AgentScopeTarget = "all" | string;

export function agentScopeFor(target: AgentScopeTarget, accounts: readonly Account[]): AgentConversationScope {
  if (target === "all") {
    return { mode: "all_accounts", accountIds: accounts.map((account) => account.id), messageIds: [] };
  }
  return { mode: "selected_account", accountIds: [target], messageIds: [] };
}

/** Maps a stored conversation scope back to a header picker target. Legacy
 *  folded scopes (current_message/current_thread from old sessions) resolve to
 *  their owner account; a scope whose account no longer exists falls back to
 *  all. The mode is accepted as a string so historical scopes map cleanly. */
export function scopeTargetForConversation(scope: { mode: string; accountIds: readonly string[]; messageIds?: readonly string[] }, accounts: readonly Account[]): AgentScopeTarget {
  if (scope.mode === "all_accounts") return "all";
  const owner = scope.accountIds[0];
  if (owner && accounts.some((account) => account.id === owner)) return owner;
  return "all";
}

export function sameAgentScope(left: AgentConversationScope, right: AgentConversationScope): boolean {
  return left.mode === right.mode
    && left.accountIds.length === right.accountIds.length
    && left.messageIds.length === right.messageIds.length
    && left.accountIds.every((value, index) => value === right.accountIds[index])
    && left.messageIds.every((value, index) => value === right.messageIds[index]);
}