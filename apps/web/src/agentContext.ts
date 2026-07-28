import type { AgentConversationScope, AgentScopeMode } from "./agentTypes";
import type { Account, Message } from "./types";

function mailHeaderIds(message: Message): string[] {
  return [...new Set([
    message.messageId,
    message.inReplyTo,
    ...(message.references ?? []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0))];
}

/**
 * Uses only mail already loaded in the renderer. The server remains the
 * authorization boundary because it receives the resulting exact message IDs.
 */
export function currentThreadMessageIds(currentMessage: Message, messages: readonly Message[], maximum = 100): string[] {
  const candidates = [
    currentMessage,
    ...messages.filter((message) => message.accountId === currentMessage.accountId && message.id !== currentMessage.id),
  ];
  const knownHeaders = new Set(mailHeaderIds(currentMessage));
  const selected = new Set([currentMessage.id]);
  let changed = true;

  while (changed && selected.size < maximum) {
    changed = false;
    for (const candidate of candidates) {
      if (selected.has(candidate.id)) continue;
      const headers = mailHeaderIds(candidate);
      if (!headers.some((header) => knownHeaders.has(header))) continue;
      selected.add(candidate.id);
      for (const header of headers) knownHeaders.add(header);
      changed = true;
      if (selected.size >= maximum) break;
    }
  }

  return [...selected].sort((left, right) => left.localeCompare(right));
}

export function agentScopeFor(
  mode: AgentScopeMode,
  currentMessage: Message | undefined,
  messages: readonly Message[],
  accounts: readonly Account[],
): AgentConversationScope {
  const allAccountIds = accounts.map((account) => account.id);
  const accountIds = currentMessage ? [currentMessage.accountId] : allAccountIds;
  const messageIds = mode === "current_message" && currentMessage
    ? [currentMessage.id]
    : mode === "current_thread" && currentMessage
      ? currentThreadMessageIds(currentMessage, messages)
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
