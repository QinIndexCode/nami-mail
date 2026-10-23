import { ftsLikeEscape, MESSAGE_FTS_CROSS_JOIN } from "./message-search.js";
import {
  EITHER_FLAGGED_PREDICATE_SQL,
  EITHER_UNSEEN_PREDICATE_SQL,
  FLAGGED_PREDICATE_SQL,
  UNSEEN_PREDICATE_SQL,
} from "./message-flag-indexes.js";
import type { AttachmentKind } from "./attachment-kind.js";

// Authoritative WHERE filter fragments for the message list view. Shared by
// GET /api/messages and the batch-job query resolver, so "select all matching
// this view" matches what the list shows — exactly, apart from the batch
// resolver's deliberate either-reading union (see MessageListSqlOptions).
//
// Folder membership reads the `m.effective_mailbox` VIRTUAL generated column
// rather than the CASE expression it is defined as: the expression is not a
// bare column, so a folder view could not use any index prefix and fell back to
// a full scan plus sorter. EFFECTIVE_MAILBOX_SQL in db-schema.ts is the one
// definition
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

/**
 * Preference order for the copy the Attachments view shows for one message.
 *
 * Mirrors sync.ts's folder priorities: the same physical message exists as one
 * row per folder it carries a label in (Gmail stores INBOX, [Gmail]/All Mail,
 * [Gmail]/Important and Trash copies separately), and the list should open the
 * copy the user would naturally look at. Inbox first, then the outgoing and
 * flagged folders, then All Mail, then the places a message is only kept as a
 * leftover. Unknown folders sort last so a provider-specific label never
 * outranks a real one.
 */
const ATTACHMENT_VIEW_RANK_SQL = `CASE
    WHEN UPPER(m2.effective_mailbox) = 'INBOX' OR f2.special_use = '\\Inbox' THEN 0
    WHEN f2.special_use = '\\Sent' THEN 1
    WHEN f2.special_use = '\\Drafts' THEN 2
    WHEN f2.special_use = '\\Flagged' THEN 3
    WHEN f2.special_use = '\\Important' THEN 4
    WHEN f2.special_use = '\\All' THEN 5
    WHEN f2.special_use = '\\Archive' THEN 6
    WHEN f2.special_use IN ('\\Junk', '\\Spam') THEN 7
    WHEN f2.special_use = '\\Trash' THEN 8
    ELSE 20
  END`;

/**
 * One row per physical message for the Attachments view.
 *
 * `remote_id_lookup` is the provider's stable message identity (Gmail's
 * X-GM-MSGID, keyed per account) and is identical for every folder copy, which
 * is what makes it the right dedupe key: `remote_id_lookup IS NULL` means the
 * provider exposes no such identity, and those rows are left alone rather than
 * grouped. Copies are otherwise invisible to each other — each has its own UID
 * and folder — so the view used to list the same mail once per label and the
 * sidebar count counted it just as many times.
 *
 * The representative is the best-ranked visible copy of the group. The sibling
 * scan repeats `has_attachments = 1` so a copy that failed to parse its
 * attachments can never be chosen and then filtered out by the view itself,
 * which would drop the whole message. The term is written as a correlated
 * id-equality rather than a window function because it composes with the
 * keyset cursor, the FTS join and `countMessageRows` untouched — the list, its
 * total, and a batch job's "select all" stay one predicate.
 *
 * Served by `idx_messages_remote_lookup`; without it, the inner scan would be a
 * full-table scan per candidate row.
 */
export const attachmentViewDedupeFilter = `(
  m.remote_id_lookup IS NULL
  OR m.id = (
    SELECT m2.id
    FROM messages m2
    LEFT JOIN folders f2
      ON f2.account_id = m2.account_id AND f2.path = m2.effective_mailbox
    WHERE m2.account_id = m.account_id
      AND m2.remote_id_lookup = m.remote_id_lookup
      AND m2.has_attachments = 1
    ORDER BY ${ATTACHMENT_VIEW_RANK_SQL}, m2.sort_key DESC, m2.id DESC
    LIMIT 1
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
export type MessageListSqlOptions = {
  /**
   * Which flag state the starred and unread predicates read.
   *
   * "local" (the default, and what the list itself displays) is the user's
   * optimistic target. "local-or-confirmed" matches under either reading, which
   * is what a batch job's selection uses: the list shows the target, so a
   * selection may not exclude a row the user can see, and a message whose
   * earlier job has already committed its new flags locally but not pushed them
   * yet is still in its old state as far as the server is concerned — replaying
   * the same selection must find it again instead of coming back empty. It is a
   * superset of the local view inside the pending window; see the predicate's
   * own comment for what a row count has to expect from it.
   */
  flags?: "local" | "local-or-confirmed";
};

export function buildMessageListSql(query: MessageListFilterQuery, options: MessageListSqlOptions = {}): MessageListSqlSelection {
  const flagPredicate = (local: string, either: string): string => (
    options.flags === "local-or-confirmed" ? either : `m.${local}`
  );
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
    filters.push(flagPredicate(FLAGGED_PREDICATE_SQL, EITHER_FLAGGED_PREDICATE_SQL));
  } else if (!globalSearch && query.snoozed) {
    // The Snoozed view lists messages whose snooze has not fired yet.
    filters.push("m.snoozed_until IS NOT NULL AND m.snoozed_until > ?");
    params.push(new Date().toISOString());
  } else if (!globalSearch && query.hasAttachments) {
    filters.push("m.has_attachments = 1");
    filters.push(attachmentViewDedupeFilter);
  } else if (!globalSearch) {
    filters.push(inboxMessageFilter);
    // Snoozed messages are hidden from the unified inbox until due.
    filters.push("(m.snoozed_until IS NULL OR m.snoozed_until <= ?)");
    params.push(new Date().toISOString());
  }
  if (!globalSearch && query.unread) {
    // Same reasoning as the starred predicate above: this is the spelling
    // `idx_messages_unseen` is keyed on.
    filters.push(flagPredicate(UNSEEN_PREDICATE_SQL, EITHER_UNSEEN_PREDICATE_SQL));
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
      join: MESSAGE_FTS_CROSS_JOIN,
      params: [...ftsParams, ...params],
    };
  }
  return {
    where: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    join: "FROM messages m",
    params,
  };
}