/**
 * The sidebar's counts, derived from `messages` instead of maintained by hand.
 *
 * The `folders.total` / `folders.unseen` columns are gone (contract §3.6): a
 * count that is nudged by ±1 at every write point drifts the moment one writer
 * forgets, and this build had six of them on three different paths plus a
 * client-side mirror in the renderer. What replaced them is a query over the
 * `messages` rows themselves — the same target state the list renders — so the
 * badge and the list cannot disagree by construction (I4).
 *
 * The two query SHAPES here are load-bearing, not style (contract §4.5,
 * measured in §0.2 on 51k rows / 704MB):
 *
 * - `total` is one `GROUP BY effective_mailbox` count, which the existing
 *   `idx_messages_account_effective_mailbox` already serves: 1.67ms per
 *   account. No new index is needed for it.
 * - `unseen` MUST be one top-level WHERE per folder. Folding the same predicate
 *   into `SUM(CASE WHEN ...)` costs the partial index entirely — measured
 *   363.81ms against 0.86ms, because SQLite cannot prove a CASE arm implies the
 *   index's WHERE clause. An index the planner declines looks exactly like no
 *   index at all, which is the failure mode message-flag-indexes.ts warns about.
 *
 * A folder's `unseen` deliberately does NOT exclude actively-snoozed messages,
 * and the unified-inbox badge in {@link mailboxBadges} deliberately does. That
 * asymmetry is the list's own: `buildMessageListSql` hides snoozed rows only in
 * the unified view (`message-filters.ts`, its last branch), while selecting a
 * folder explicitly shows everything filed there — including a message whose
 * snooze has not fired. I4 requires the badge to equal the list it describes,
 * so the snooze term belongs to the view that hides, not to the folder.
 */
import type { DatabaseHandle } from "./db.js";
import { FLAGGED_PREDICATE_SQL, UNSEEN_PREDICATE_SQL } from "./message-flag-indexes.js";

export type FolderCount = { path: string; total: number; unseen: number };

/** The per-folder badge counts of one account, keyed by folder path. */
export function folderCounts(db: DatabaseHandle, accountId: string): FolderCount[] {
  const paths = (db.prepare("SELECT path FROM folders WHERE account_id = ? ORDER BY name, path").all(accountId) as Array<{ path: string }>)
    .map((row) => row.path);
  const totals = new Map(
    (db.prepare(`
      SELECT effective_mailbox AS path, COUNT(*) AS total
      FROM messages
      WHERE account_id = ?
      GROUP BY effective_mailbox
    `).all(accountId) as Array<{ path: string; total: number }>)
      .map((row) => [row.path, row.total] as const),
  );
  // One indexed count per folder: the shape the partial index in
  // message-flag-indexes.ts can actually serve. Every folder the sidebar shows
  // gets a row even when nothing is filed in it, because the answer is keyed on
  // `folders` and only the numbers come from `messages`.
  const unseen = db.prepare(`
    SELECT COUNT(*) AS unseen
    FROM messages
    WHERE account_id = ? AND effective_mailbox = ? AND ${UNSEEN_PREDICATE_SQL}
  `);
  return paths.map((path) => ({
    path,
    total: totals.get(path) ?? 0,
    unseen: (unseen.get(accountId, path) as { unseen: number }).unseen,
  }));
}

export type MailboxBadges = {
  messages: number;
  unread: number;
  starred: number;
  snoozed: number;
  attachments: number;
  accounts: number;
};

/**
 * The cross-folder badges `/api/stats` reports: the unified inbox's message and
 * unread counts, plus the starred / snoozed / attachments view counts.
 *
 * The unified inbox is answered in TWO steps — resolve the inbox paths from the
 * (tiny) `folders` table, then run the indexed per-folder count once per path.
 * The correlated form this replaces (one `SUM(CASE ...)` arm whose filter
 * carried an `EXISTS (SELECT 1 FROM folders ...)`) was measured at 277.52ms
 * unread / 217.60ms total with the plan `SCAN m | CORRELATED LIST SUBQUERY 1`
 * — over the 200ms budget for one endpoint the sidebar polls. The earlier
 * attempt to split these counted a different thing (it kept the correlated
 * test, only moving it into a subquery shell), which is why the old note beside
 * that statement concluded the split was slower; the step removed here is the
 * per-message folder lookup, not the shell around it.
 *
 * Scoping: with `accountId` the badges describe that account alone — the
 * unified inbox resolves only its inbox paths, the cross-folder views add an
 * account predicate, and `accounts` counts the accounts in scope (0 or 1).
 * Without it every badge spans the whole mailbox, which is the older behaviour.
 *
 * `now` is epoch milliseconds; active snoozes are compared as ISO-UTC strings.
 */
export function mailboxBadges(db: DatabaseHandle, now: number, accountId?: string): MailboxBadges {
  const nowIso = new Date(now).toISOString();
  const accountSuffix = accountId ? " AND account_id = ?" : "";
  const scope: unknown[] = accountId ? [accountId] : [];
  // Both halves of the legacy inbox test, read as a PATH SET instead of as a
  // per-message correlated EXISTS: a folder is an inbox when the provider said
  // so (`special_use`) or when the path itself is INBOX. `effective_mailbox` is
  // always a folder path (a pending move's destination is resolved from
  // `folders` before it is written), so testing membership of this set is
  // equivalent to the old filter — and it is the only form the partial index
  // can serve.
  const inboxes = db.prepare(`
    SELECT account_id, path FROM folders
    WHERE (special_use = '\\Inbox' OR UPPER(path) = 'INBOX')${accountSuffix}
  `).all(...scope) as Array<{ account_id: string; path: string }>;
  const inboxTotal = db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE account_id = ? AND effective_mailbox = ?
      AND (snoozed_until IS NULL OR snoozed_until <= ?)
  `);
  const inboxUnread = db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE account_id = ? AND effective_mailbox = ?
      AND (snoozed_until IS NULL OR snoozed_until <= ?)
      AND ${UNSEEN_PREDICATE_SQL}
  `);
  // No SUM arm anchors a single statement to `messages` any more, so an empty
  // mailbox is handled here rather than in SQL: the counters start at zero,
  // which is what the sidebar needs (0, never null).
  let messages = 0;
  let unread = 0;
  for (const inbox of inboxes) {
    messages += (inboxTotal.get(inbox.account_id, inbox.path, nowIso) as { count: number }).count;
    unread += (inboxUnread.get(inbox.account_id, inbox.path, nowIso) as { count: number }).count;
  }
  const count = (sql: string): number => (db.prepare(sql).get(...scope) as { count: number }).count;
  return {
    messages,
    unread,
    // Cross-folder views: every folder participates, which is what the list
    // does for them too. Each is served by an existing partial index.
    starred: count(`SELECT COUNT(*) AS count FROM messages m WHERE m.${FLAGGED_PREDICATE_SQL}${accountId ? " AND m.account_id = ?" : ""}`),
    snoozed: accountId
      ? (db.prepare("SELECT COUNT(*) AS count FROM messages m WHERE m.snoozed_until IS NOT NULL AND m.snoozed_until > ? AND m.account_id = ?").get(nowIso, accountId) as { count: number }).count
      : (db.prepare("SELECT COUNT(*) AS count FROM messages m WHERE m.snoozed_until IS NOT NULL AND m.snoozed_until > ?").get(nowIso) as { count: number }).count,
    attachments: count(`SELECT COUNT(*) AS count FROM messages m WHERE m.has_attachments = 1${accountId ? " AND m.account_id = ?" : ""}`),
    accounts: accountId
      ? (db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE id = ?").get(accountId) as { count: number }).count
      : (db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number }).count,
  };
}
