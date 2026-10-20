import type { AgentConversationSummary } from "../agentTypes";

type ConversationMergeInput = {
  /** The list currently rendered in the sidebar. */
  current: AgentConversationSummary[];
  /** The rows the server just returned. */
  serverItems: AgentConversationSummary[];
  /** Rows whose delete is in flight; they must never come back until confirmed. */
  pendingDeleteIds: ReadonlySet<string>;
  /** Rows created in this session, which a snapshot may not carry yet. */
  createdThisSession: ReadonlySet<string>;
  /** A non-empty search term makes the server result authoritative. */
  query: string;
};

/**
 * Fold a conversation-list snapshot into the rows already on screen.
 *
 * Replacing wholesale would flash a disappearing sidebar row: a profile may
 * have just been created, or its turn may still be mid-write, so the snapshot
 * can momentarily omit it. Server rows are adopted; a local-only row survives
 * only when it was created this session or is at least as fresh as the newest
 * server row. Anything older — deleted here or on another device — is left to
 * the server's authoritative result so it cannot resurrect.
 *
 * A locally-deleted row is the one exception to "adopt server rows": the
 * server delete may not have committed yet, so its snapshot can still carry
 * the row. Those are filtered out so an optimistic delete cannot flicker back.
 */
export function mergeConversationList({
  current,
  serverItems,
  pendingDeleteIds,
  createdThisSession,
  query,
}: ConversationMergeInput): AgentConversationSummary[] {
  if (query) return serverItems.filter((item) => !pendingDeleteIds.has(item.id));
  const newestServer = serverItems[0]?.updatedAt ?? "";
  const serverById = new Map(
    serverItems
      .filter((item) => !pendingDeleteIds.has(item.id))
      .map((item) => [item.id, item]),
  );
  const merged = [...serverById.values()];
  for (const item of current) {
    if (pendingDeleteIds.has(item.id)) continue;
    if (serverById.has(item.id)) continue;
    const newThisSession = createdThisSession.has(item.id);
    const freshEnough = (item.updatedAt ?? "").localeCompare(newestServer) >= 0;
    if (newThisSession || freshEnough) merged.push(item);
  }
  return merged.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
