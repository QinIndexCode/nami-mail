import { ftsLikeEscape } from "./message-search.js";
import { FLAGGED_PREDICATE_SQL, UNSEEN_PREDICATE_SQL } from "./message-flag-indexes.js";
import type { AttachmentKind } from "./attachment-kind.js";

// Authoritative WHERE filter fragments for the message list view. Shared by
// GET /api/messages and the batch-job query resolver so "select all matching
// this view" always matches exactly what the list shows.
//
// Folder membership reads the `m.effective_mailbox` VIRTUAL generated column
// rather than the CASE expression it is defined as: the expression is not a
// bare column, so a folder view could not use any index prefix and fell back to
// a full scan plus sorter. EFFECTIVE_MAILBOX_SQL in db.ts is the one definition
// of that value and SQLite owns the column, so this file must never restate the
// expression.

export const inboxMessageFilter = `(
  UPPER(m.effective_mailbox) = 'INBOX'
  OR EXISTS (
    SELECT 1 FROM folders f
    WHERE f.account_id = m.account_id
      AND f.path = m.effective_mailbox
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
      AND f.path = m.effective_mailbox
      AND f.special_use = '\\Archive'
  )
  OR (
    m.all_mail_archived = 1
    AND EXISTS (
      SELECT 1 FROM folders f
      WHERE f.account_id = m.account_id
        AND f.path = m.effective_mailbox
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
  // The Attachments view: messages carrying files, across every folder of the
  // selected account (all accounts when no accountId is bound). Replaces the
  // unified-inbox fallback, so it never needs a folder.
  hasAttachments?: boolean;
  // Attachment-kind segmentation: only messages whose stored attachments
  // include the selected kind. Refines any view, including global search.
  attachmentKind?: AttachmentKind;
  // Exclusive date bounds over the effective sent time, as ISO-UTC instants
  // ("after" is inclusive, "before" exclusive). The renderer converts local
  // calendar dates to UTC before sending, so the comparison is pure string
  // ordering against the stored COALESCE(sent_at, created_at) timestamps.
  after?: string;
  before?: string;
  // "all" searches every account and mailbox (any view). Only meaningful
  // together with q; without q it is ignored, so a client can never turn the
  // list into an unbounded full-database dump by accident.
  scope?: "all";
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
  const search = query.q?.trim();
  // A global search drops every view/account/folder restriction so the FTS
  // match alone decides the candidate set. It is a search-only mode: without
  // q the standard view precedence applies and scope is ignored.
  const globalSearch = query.scope === "all" && Boolean(search);
  if (!globalSearch && query.accountId) {
    filters.push("m.account_id = ?");
    params.push(query.accountId);
  }
  if (!globalSearch && query.folder) {
    filters.push("m.effective_mailbox = ?");
    params.push(query.folder);
  } else if (!globalSearch && query.archived) {
    filters.push(archivedMessageFilter);
  } else if (!globalSearch && query.starred) {
    // Starred is a cross-folder view, unlike the normal unified inbox. The
    // pattern is the one the `idx_messages_flagged` partial index is keyed on,
    // imported rather than restated: a partial index is only usable when SQLite
    // can prove the query's predicate implies its WHERE clause, so the two
    // spellings have to stay identical down to the backslashes.
    filters.push(`m.${FLAGGED_PREDICATE_SQL}`);
  } else if (!globalSearch && query.snoozed) {
    // The Snoozed view lists messages whose snooze has not fired yet.
    filters.push("m.snoozed_until IS NOT NULL AND m.snoozed_until > ?");
    params.push(new Date().toISOString());
  } else if (!globalSearch && query.hasAttachments) {
    filters.push("m.has_attachments = 1");
  } else if (!globalSearch) {
    filters.push(inboxMessageFilter);
    // Snoozed messages are hidden from the unified inbox until due.
    filters.push("(m.snoozed_until IS NULL OR m.snoozed_until <= ?)");
    params.push(new Date().toISOString());
  }
  if (!globalSearch && query.unread) {
    // Same reasoning as the starred predicate above: this is the spelling
    // `idx_messages_unseen` is keyed on.
    filters.push(`m.${UNSEEN_PREDICATE_SQL}`);
  }
  // Kind and date refinements apply to every mode, including global search:
  // they narrow the candidate set, they never widen it.
  if (query.attachmentKind) {
    // The stored column is JSON text; the kind token is quoted so a kind can
    // never match another kind's substring by accident.
    filters.push("m.attachment_kinds_json LIKE ?");
    params.push(`%"${query.attachmentKind}"%`);
  }
  if (query.after) {
    // Deliberately still the expression rather than m.sort_key. Switching is
    // safe on value exactly when the column can never be NULL or stale: the
    // expression yields created_at whenever sent_at is NULL, so the two agree
    // only if the column is always derived from that same expression. A
    // VIRTUAL generated column guarantees it and created_at is NOT NULL, so
    // the values are now identical by construction; the remaining question is
    // only whether the range predicate would be served as an index seek on
    // idx_messages_account_sort_key instead of a scan, which is worth
    // measuring before changing a query every list view runs.
    filters.push("COALESCE(m.sent_at, m.created_at) >= ?");
    params.push(query.after);
  }
  if (query.before) {
    filters.push("COALESCE(m.sent_at, m.created_at) < ?");
    params.push(query.before);
  }
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
      // CROSS JOIN, not JOIN: it is the same inner join, but it also pins the
      // join order, and the order is the whole point. Left to itself SQLite
      // drives the search from `messages` — it can then walk
      // idx_messages_account_sort_key in (sort_key DESC, id DESC) order and
      // skip the sorter — but that makes it re-run the *entire* FTS scan once
      // per candidate message, so the page costs
      // O(messages_in_account x fts_rows) instead of O(fts_rows). The
      // selectivity is the other way round: the FTS match is the narrow side
      // (measured on 4 000 rows: 80 matches against 4 000 messages), so the FTS
      // scan has to drive and `messages` is probed by primary key.
      //
      // The sorter this brings back is not a regression: it now sorts only the
      // rows that matched, and `messages.id` lookups it then does are the same
      // ones the old plan performed. Measured on 4 000 rows x 48KB payload,
      // page time by match density — 2%: 33 925ms -> 37ms, 15%: 4 351ms ->
      // 56ms, 50%: 943ms -> 93ms, 100% (every row matches): 234ms -> 164ms, so
      // it wins at every density including the degenerate one. The id sequence
      // returned is byte-identical to the old plan's at every density.
      join: "FROM messages_fts fts CROSS JOIN messages m ON m.id = fts.message_id",
      params: [...ftsParams, ...params],
    };
  }
  return {
    where: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    join: "FROM messages m",
    params,
  };
}