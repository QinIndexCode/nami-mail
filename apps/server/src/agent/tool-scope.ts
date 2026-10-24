import type { AgentToolExecutionContext } from "@nami/agent-core";

/**
 * Account ids a tool call may act on: trimmed and de-duplicated, so a blank
 * entry from a stale or malformed conversation scope cannot widen a query.
 */
export function scopedAccountIds(context: AgentToolExecutionContext): readonly string[] {
  return [...new Set(context.accountIds.map((accountId) => accountId.trim()).filter(Boolean))];
}
