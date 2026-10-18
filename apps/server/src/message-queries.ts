/**
 * Read-only message row access for the HTTP layer.
 *
 * Every read endpoint used to inline its own `SELECT` against `messages`, so
 * the "row joined with the account email" shape was written out three times
 * and the "is this a draft?" folder join twice. These queries live here so the
 * joins have a single definition; the route keeps validation, error mapping
 * and payload decryption.
 *
 * Leaf module: only type-only imports plus `db.js` and the cursor codec.
 */
import type { DatabaseHandle } from "./db.js";
import { encodeMessageCursor, type MessageListCursor } from "./message-cursor.js";
import type { MessageListSqlSelection } from "./message-filters.js";
import type { MessageStorageRow } from "./message-storage.js";
import type { AccountRecord } from "./types.js";

/**
 * List-view reads. The WHERE/FROM fragments are produced by
 * `buildMessageListSql`, which the batch-job selection resolver also uses, so
 * "select all matching this view" cannot drift from what the list shows.
 */
export function countMessageRows(db: DatabaseHandle, selection: MessageListSqlSelection): number {
  return Number(
    (db.prepare(`SELECT COUNT(*) AS count ${selection.join} ${selection.where}`).get(...selection.params) as { count: number })
      .count,
  );
}

/**
 * The ids a list predicate matches, in list order.
 *
 * Same selection the list endpoints render, resolved when the caller asks --
 * the batch acceptance materialises its selection before its transaction so a
 * job acts on the messages the user selected, not on whatever the predicate
 * matches once the task runs.
 *
 * The resolver is called with the **local-or-confirmed** flags spelling (the
 * caller builds the selection): a message whose earlier job committed its new
 * flags locally but has not pushed them yet is still unread as far as the
 * server is concerned, so resolving on the target alone would make "select
 * every unread message, mark read, then mark unread again" come back empty;
 * resolving on the server's state alone would exclude the row the user just
 * starred and can still see. The union is a superset of the list inside that
 * pending window, so this can return ids the list no longer shows and a job's
 * `total` can exceed the visible row count -- accepted deliberately.
 */
export function resolveMessageIds(db: DatabaseHandle, selection: MessageListSqlSelection): string[] {
  return db
    .prepare(`SELECT m.id ${selection.join} ${selection.where} ORDER BY COALESCE(m.sent_at, m.created_at) DESC`)
    .pluck()
    .all(...selection.params) as string[];
}

/**
 * The list's total order, and the cursor predicate that continues it. Both are
 * written once so a page and the cursor it hands out cannot disagree about
 * which row comes next.
 *
 * `sort_key` is the VIRTUAL generated column (SORT_KEY_SQL in db-schema.ts) rather
 * than a recomputed COALESCE(sent_at, created_at): the expression is not a bare
 * column, so the only index it could use was the account_id prefix of
 * idx_messages_account_mailbox and SQLite fell back to "USE TEMP B-TREE FOR
 * ORDER BY" — which materialises whole rows, ciphertext payload included, for
 * every message of the account. sort_key carries the same value, derived by
 * SQLite from the current row, so the index answers the ordering and the LIMIT
 * without a sorter and no write point has to keep it in step.
 *
 * `id DESC` is the tiebreak the generated column cannot provide. sort_key is
 * not unique — a sync that lands several messages in the same second writes
 * several rows with the same value — and an ORDER BY over a non-total order
 * cannot be continued by a cursor: two rows with one sort_key have no defined
 * "next". It costs nothing, because both list indexes carry `id` as a suffix.
 */
const MESSAGE_LIST_ORDER = "ORDER BY m.sort_key DESC, m.id DESC";
/**
 * Row-wise "strictly after the cursor, newest first", in the same terms as the
 * ORDER BY. Written as an OR of two comparisons rather than
 * `(sort_key, id) < (?, ?)` because SQLite compares tuples element-wise only
 * via a row value, which cannot use an index range the way the expanded form
 * does. Both branches keep the account/mailbox prefix seekable.
 */
const MESSAGE_CURSOR_PREDICATE = "(m.sort_key < ? OR (m.sort_key = ? AND m.id < ?))";

/**
 * One page of a list view plus the cursor that continues it.
 *
 * `nextCursor` is null exactly when the list is exhausted, which is the signal
 * the renderer uses for "no more pages" — see message-cursor.ts for why a
 * client must not infer it from a row count, which new mail keeps changing.
 */
export type MessageListPage = {
  rows: MessageStorageRow[];
  nextCursor: string | null;
};

/**
 * One page of a list view, newest first, joined with the owning account.
 *
 * `cursor` is the position to resume from; omitting it starts at the head of
 * the list. It narrows the *same* selection the filters build, so the cursor
 * composes with every view: the account, folder, flag, kind, date and search
 * predicates stay in force and the keyset predicate is ANDed onto them, which
 * is why a cursor can never widen the set it was issued for.
 */
export function listMessagePage(
  db: DatabaseHandle,
  selection: MessageListSqlSelection,
  { limit, cursor }: { limit: number; cursor?: MessageListCursor },
): MessageListPage {
  const params = [...selection.params];
  let where = selection.where;
  if (cursor) {
    where = where === "" ? `WHERE ${MESSAGE_CURSOR_PREDICATE}` : `${where} AND ${MESSAGE_CURSOR_PREDICATE}`;
    params.push(cursor.sortKey, cursor.sortKey, cursor.id);
  }
  // One row past the page is the has-more probe. It is never returned; it only
  // decides whether this page ends the list, and counting the rows it did get
  // would answer "is this page short" — which is false whenever the user's own
  // read or a delete took rows out between two requests.
  const probed = db
    .prepare(
      `
          SELECT m.*, m.sort_key AS list_sort_key, a.email AS account_email, a.provider_name
          ${selection.join}
          JOIN accounts a ON a.id = m.account_id
          ${where}
          ${MESSAGE_LIST_ORDER}
          LIMIT ?
        `,
    )
    .all(...params, limit + 1) as Array<MessageStorageRow & { list_sort_key: string }>;
  const hasMore = probed.length > limit;
  const rows = hasMore ? probed.slice(0, limit) : probed;
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor: hasMore && last
      ? encodeMessageCursor({ sortKey: last.list_sort_key, id: last.id })
      : null,
  };
}

/** The rows of one page, without the cursor bookkeeping. */
export function listMessageRows(
  db: DatabaseHandle,
  selection: MessageListSqlSelection,
  options: { limit: number; cursor?: MessageListCursor },
): MessageStorageRow[] {
  return listMessagePage(db, selection, options).rows;
}

/**
 * The columns a flag/move operation needs to talk to IMAP and to record a
 * pending change. Read identically by `sync-moves.ts` (three call sites) and
 * `sync-flags.ts`, which used to spell the same SELECT out four times.
 */
export type PendingPushRow = {
  account_id: string;
  mailbox: string;
  uid: number;
  flags_json: string;
  remote_id_lookup: string | null;
  pending_move_destination: string | null;
  pending_move_state: string | null;
};

export function pendingPushRowById(db: DatabaseHandle, id: string): PendingPushRow | undefined {
  return db
    .prepare("SELECT account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id = ?")
    .get(id) as PendingPushRow | undefined;
}

/** A message row joined with its account, as returned by the read endpoints. */
export function messageRowById(db: DatabaseHandle, id: string): MessageStorageRow | undefined {
  return db
    .prepare(
      `
        SELECT m.*, a.email AS account_email, a.provider_name
        FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?
      `,
    )
    .get(id) as MessageStorageRow | undefined;
}

/**
 * Every non-draft message of one account, oldest first. Thread membership is
 * resolved from encrypted headers, so the caller needs a decrypting pass over
 * the whole account rather than a targeted lookup.
 *
 * The chronological order is applied in JS, not in SQL. `ORDER BY
 * COALESCE(sent_at, created_at)` cannot be served by an index (the expression
 * is computed), so SQLite sorts through a temp B-tree that materialises whole
 * rows — including the ~48KB ciphertext the caller does not need to order
 * them. Measured on a 20 000-message account: 6299ms with the SQL sort vs
 * 887ms for the unsorted scan plus a 29ms JS sort (7.1x), and byte-identical
 * ordering at 2 000/5 000/20 000 rows. Both keys are ISO-8601 UTC text, which
 * SQLite compares with BINARY collation — the same byte order `<` gives here.
 */
export function threadRowsForAccount(db: DatabaseHandle, accountId: string): MessageStorageRow[] {
  const rows = db
    .prepare(
      `
        SELECT m.*, a.email AS account_email, a.provider_name
        FROM messages m
        JOIN accounts a ON a.id = m.account_id
        LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.mailbox
        WHERE m.account_id = ? AND (f.special_use IS NULL OR f.special_use != '\\Drafts')
      `,
    )
    .all(accountId) as MessageStorageRow[];
  return rows.sort((left, right) => {
    const leftKey = String(left.sent_at ?? left.created_at);
    const rightKey = String(right.sent_at ?? right.created_at);
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** Special-use flag of the folder holding a message; undefined when the row is gone. */
export function messageFolderSpecialUse(db: DatabaseHandle, id: string): { special_use: string | null } | undefined {
  return db
    .prepare(
      `
      SELECT f.special_use
      FROM messages m
      LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.mailbox
      WHERE m.id = ?
    `,
    )
    .get(id) as { special_use: string | null } | undefined;
}

export function messageAccountAndFolder(
  db: DatabaseHandle,
  id: string,
): { account_id: string; special_use: string | null } | undefined {
  return db
    .prepare(
      `
      SELECT m.account_id, f.special_use
      FROM messages m
      LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.mailbox
      WHERE m.id = ?
    `,
    )
    .get(id) as { account_id: string; special_use: string | null } | undefined;
}

/** The account row that owns a message, used by operations that act on the mailbox. */
export function accountRowForMessage(db: DatabaseHandle, messageId: string): AccountRecord | undefined {
  return db
    .prepare(
      `
      SELECT a.*
      FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE m.id = ?
    `,
    )
    .get(messageId) as AccountRecord | undefined;
}

/** Accounts owning each of the given message ids, so a batch can be grouped per account. */
export function messageAccountIds(
  db: DatabaseHandle,
  ids: readonly string[],
): Array<{ id: string; account_id: string }> {
  return db
    .prepare(`SELECT id, account_id FROM messages WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids) as Array<{ id: string; account_id: string }>;
}

export function messageAccountId(db: DatabaseHandle, id: string): string | undefined {
  const row = db.prepare("SELECT account_id FROM messages WHERE id = ?").get(id) as
    | { account_id: string }
    | undefined;
  return row?.account_id;
}

export function messageExists(db: DatabaseHandle, id: string): boolean {
  return db.prepare("SELECT 1 FROM messages WHERE id = ?").get(id) !== undefined;
}
