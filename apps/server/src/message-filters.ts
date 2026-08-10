import { ftsLikeEscape } from "./message-search.js";

// Authoritative WHERE filter fragments for the message list view. Shared by
// GET /api/messages and the batch-job query resolver so "select all matching
// this view" always matches exactly what the list shows.

export const effectiveMailboxExpression = "CASE WHEN m.pending_move_state = 'intent' THEN m.mailbox ELSE COALESCE(NULLIF(m.pending_move_destination, ''), m.mailbox) END";

export const inboxMessageFilter = `(
  UPPER(${effectiveMailboxExpression}) = 'INBOX'
  OR EXISTS (
    SELECT 1 FROM folders f
    WHERE f.account_id = m.account_id
      AND f.path = ${effectiveMailboxExpression}
      AND f.special_use = '\\Inbox'
  )
)`;

export const archivedMessageFilter = `(
  (
    m.pending_move_destination IS NOT NULL
    AND COALESCE(m.pending_move_state, 'confirmed') = 'confirmed'
    AND (
      m.pending_move_special_use = '\\Archive'
      OR (m.pending_move_special_use = '\\All' AND m.all_mail_archived = 1)
    )
  )
  OR EXISTS (
    SELECT 1 FROM folders f
    WHERE f.account_id = m.account_id
      AND f.path = ${effectiveMailboxExpression}
      AND f.special_use = '\\Archive'
  )
  OR (
    m.all_mail_archived = 1
    AND EXISTS (
      SELECT 1 FROM folders f
      WHERE f.account_id = m.account_id
        AND f.path = ${effectiveMailboxExpression}
        AND f.special_use = '\\All'
    )
    AND NOT EXISTS (
      SELECT 1 FROM folders archive_folder
      WHERE archive_folder.account_id = m.account_id
        AND archive_folder.special_use = '\\Archive'
    )
  )
)`;

export type MessageListFilterQuery = {
  accountId?: string;
  folder?: string;
  q?: string;
  starred?: boolean;
  unread?: boolean;
  archived?: boolean;
  snoozed?: boolean;
};

export type MessageListSqlSelection = {
  // Full WHERE clause including the "WHERE " prefix ("" when no filters).
  where: string;
  // FROM fragment: the FTS join when searching, otherwise plain messages.
  join: string;
  // Bound parameters in the same order as the WHERE placeholders.
  params: unknown[];
};

/**
 * Builds the SQL selection for the current list view. Filter precedence
 * mirrors the list endpoint: an explicit folder wins, then archived/starred/
 * snoozed views, otherwise the unified inbox (snoozed-hidden until due).
 * A `q` search switches to the FTS join and prepends its LIKE parameters.
 */
export function buildMessageListSql(query: MessageListFilterQuery): MessageListSqlSelection {
  const filters: string[] = [];
  const params: unknown[] = [];
  if (query.accountId) {
    filters.push("m.account_id = ?");
    params.push(query.accountId);
  }
  if (query.folder) {
    filters.push(`${effectiveMailboxExpression} = ?`);
    params.push(query.folder);
  } else if (query.archived) {
    filters.push(archivedMessageFilter);
  } else if (query.starred) {
    // Starred is a cross-folder view, unlike the normal unified inbox.
    filters.push("m.flags_json LIKE '%\\\\Flagged%'");
  } else if (query.snoozed) {
    // The Snoozed view lists messages whose snooze has not fired yet.
    filters.push("m.snoozed_until IS NOT NULL AND m.snoozed_until > ?");
    params.push(new Date().toISOString());
  } else {
    filters.push(inboxMessageFilter);
    // Snoozed messages are hidden from the unified inbox until due.
    filters.push("(m.snoozed_until IS NULL OR m.snoozed_until <= ?)");
    params.push(new Date().toISOString());
  }
  if (query.unread) {
    filters.push("m.flags_json NOT LIKE '%\\\\Seen%'");
  }
  const search = query.q?.trim();
  if (search) {
    const pattern = `%${ftsLikeEscape(search)}%`;
    const ftsMatch = `(fts.subject LIKE ? ESCAPE '\\'
      OR fts.from_name LIKE ? ESCAPE '\\'
      OR fts.from_address LIKE ? ESCAPE '\\'
      OR fts.body LIKE ? ESCAPE '\\')`;
    const ftsParams = [pattern, pattern, pattern, pattern];
    const where = filters.length ? `${ftsMatch} AND (${filters.join(" AND ")})` : ftsMatch;
    return {
      where: `WHERE ${where}`,
      join: "FROM messages_fts fts JOIN messages m ON m.id = fts.message_id",
      params: [...ftsParams, ...params],
    };
  }
  return {
    where: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    join: "FROM messages m",
    params,
  };
}