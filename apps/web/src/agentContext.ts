import type { AgentConversationScope, AgentScopeMode } from "./agentTypes";
import type { Account, Message } from "./types";

export function agentScopeFor(
  mode: AgentScopeMode,
  currentMessage: Message | undefined,
  accounts: readonly Account[],
): AgentConversationScope {
  const allAccountIds = accounts.map((account) => account.id);
  const accountIds = currentMessage ? [currentMessage.accountId] : allAccountIds;
  const messageIds = mode === "current_message" && currentMessage
    ? [currentMessage.id]
    : [];
  return {
    mode,
    accountIds: mode === "all_accounts" ? allAccountIds : accountIds,
    messageIds,
  };
}

export function sameAgentScope(left: AgentConversationScope, right: AgentConversationScope): boolean {
  return left.mode === right.mode
    && left.accountIds.length === right.accountIds.length
    && left.messageIds.length === right.messageIds.length
    && left.accountIds.every((value, index) => value === right.accountIds[index])
    && left.messageIds.every((value, index) => value === right.messageIds[index]);
}
