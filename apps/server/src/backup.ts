import type { DatabaseHandle } from "./db.js";
import { friendlyMailError, imapClientForAccount, mailErrorCode, type AccountAccessTokenProvider, type MailErrorCode } from "./mail.js";
import { safeLogout } from "./imap-logout.js";
import { moveActionBlockedError, type MessageStorageRow } from "./message-storage.js";
import type { AccountRecord } from "./types.js";

// Full-mailbox backup: streams every stored message's canonical RFC822
// source into a zip of .eml files. Sources are never cached locally (the
// per-message EML export fetches on demand), so the backup behaves the same
// way: one IMAP connection per (account, mailbox) group, opened once and
// reused for every message in that folder.

// UIDs are fetched in chunks: one batched FETCH command per chunk instead of
// a sequential round trip per message, while keeping a single command bounded
// for very large folders.
const BACKUP_FETCH_CHUNK_SIZE = 100;

// Rows are read a page at a time instead of one SELECT * over the whole
// table. The previous query materialised every message — encrypted payload
// included — on the JS heap at once, which on a 20k-row mailbox with realistic
// payloads cost several GB before the first entry reached the zip. A page of
// the narrow projection below is a few hundred kilobytes regardless of how
// large the mailbox is, and the page size only trades round trips against that.
export const BACKUP_PAGE_SIZE = 1000;

// Only the columns this pipeline reads. The old SELECT * dragged every row's
// encrypted payload, bodies and attachment metadata into memory for a file
// that is re-fetched from the provider anyway.
//   id, account_id, mailbox, uid  - grouping, archive name, FETCH, failure report
//   subject                       - archive name
//   sort_key                      - keyset cursor
//   pending_move_destination, pending_move_state, remote_id_lookup - exactly
//                                  the three columns moveActionBlockedError reads
const BACKUP_PAGE_COLUMNS = "id, account_id, mailbox, uid, subject, sort_key, pending_move_destination, pending_move_state, remote_id_lookup";

/**
 * The statement one page of the backup reads, in the same order the previous
 * one-shot query produced: account, then folder, then arrival time. Three
 * things are deliberate here.
 *
 * `sort_key` is the VIRTUAL generated column db.ts defines as SORT_KEY_SQL
 * ("COALESCE(sent_at, created_at)") — literally the expression the old ORDER BY
 * spelled out, so reading the column cannot drift away from it. `uid` only
 * breaks ties between messages that share a sort key, which the old query left
 * to SQLite's sorter; it is the index's last column, and it keeps the order the
 * old one happened to produce for a folder whose messages all landed at once.
 * Note the folder term is the physical `mailbox`, never `effective_mailbox`: a
 * row whose move is still in flight physically lives in the source folder, and
 * that is the folder whose lock the FETCH has to be taken on.
 *
 * The cursor is a SQLite row-value comparison rather than a hand-expanded OR
 * chain, because only the row-value form is turned into an index seek — the
 * expanded chain plans as a full index SCAN. Its null semantics were checked
 * column by column, which is also why the tiebreaker is `uid` and not the `id`
 * that a first reading suggests: account_id and mailbox are NOT NULL, sort_key
 * is COALESCE over a NOT NULL created_at so it cannot be NULL either, and uid
 * is NOT NULL — but a TEXT PRIMARY KEY is one of the columns SQLite's
 * long-standing quirk still lets be NULL, and a NULL anywhere in the compared
 * row makes the whole comparison unknown, which would silently drop the rest of
 * a tie group when a NULL-id row happened to land on a page boundary. `uid` is
 * NOT NULL and UNIQUE(account_id, mailbox, uid) already holds, so the tuple is
 * a total order with no null case at all.
 *
 * Exported so the query-plan test plans the statement the backup actually runs.
 */
export function backupPageSql(afterCursor: boolean): string {
  return `SELECT ${BACKUP_PAGE_COLUMNS} FROM messages
    ${afterCursor ? "WHERE (account_id, mailbox, sort_key, uid) > (?, ?, ?, ?)" : ""}
    ORDER BY account_id, mailbox, sort_key, uid
    LIMIT ?`;
}

const messageGoneReason = "Message is no longer available in this mailbox. Sync this message again.";

/**
 * The one emit failure that is not a mailbox failure: the caller that receives
 * the entries can no longer take them, so the download client is gone.
 *
 * It is separated from the generic emit error because the two must not end the
 * same way. A folder whose emit throws is blocked and booked, which is right
 * for a transport that broke, but booking it here would write `status = error`
 * on an account that is perfectly healthy — a user who closed the download tab
 * would see their account break — and would keep fetching the rest of the
 * mailbox for a response nobody is there to read. So this error stops the run
 * and leaves the account row alone.
 */
export class BackupTransferClosedError extends Error {
  constructor(message = "The backup download was closed before the archive was written.") {
    super(message);
    this.name = "BackupTransferClosedError";
  }
}

export type BackupMessageEntry = {
  /** Archive path inside the zip, e.g. "emails/0001_quarterly-report.eml". */
  path: string;
  /** The provider's original RFC822 source. */
  source: Buffer;
};

export type BackupFailure = {
  messageId: string;
  /** Classified mail taxonomy code for the failure. */
  code: MailErrorCode;
  reason: string;
};

export type MailBackupReport = {
  generatedAt: string;
  accountCount: number;
  messageCount: number;
  exported: number;
  failed: BackupFailure[];
};

/** Mangles a subject into a safe archive entry name (no separators or control chars). */
export function backupEntryName(subject: string, index: number): string {
  const cleaned = subject
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 80)
    .trim();
  return `emails/${String(index).padStart(4, "0")}_${cleaned || "message"}.eml`;
}

type BackupPageRow = MessageStorageRow & {
  sort_key: string;
  id: string;
  account_id: string;
  mailbox: string;
  uid: number;
  subject: string;
};

/** The last row of the previous page; the next page resumes strictly after it. */
type BackupCursor = { accountId: string; mailbox: string; sortKey: string; uid: number };

type BackupImapClient = Awaited<ReturnType<typeof imapClientForAccount>>;
type BackupMailboxLock = Awaited<ReturnType<BackupImapClient["getMailboxLock"]>>;

/**
 * A folder being streamed, plus the IMAP connection opened for it. `failure`
 * is set when opening the folder did not work: every remaining row of the
 * folder is then recorded as failed with that one classified error, which is
 * what the previous per-folder catch branch did for the whole folder at once.
 */
type OpenFolder = {
  account: AccountRecord;
  mailbox: string;
  client: BackupImapClient;
  lock: BackupMailboxLock | undefined;
  connected: boolean;
  failure: { code: MailErrorCode; reason: string } | null;
};

/** Accounts are a handful of rows; this replaces the per-message lookup the old grouping ran. */
function loadAccounts(db: DatabaseHandle): Map<string, AccountRecord> {
  const accounts = new Map<string, AccountRecord>();
  for (const account of db.prepare("SELECT * FROM accounts").all() as AccountRecord[]) {
    accounts.set(account.id, account);
  }
  return accounts;
}

/**
 * Runs the backup and emits one entry per successfully fetched message.
 * Failures are collected in the report instead of aborting the whole run, so
 * a single gone-from-provider message never blocks the rest of the mailbox.
 */
export async function collectMailBackup(
  db: DatabaseHandle,
  masterKey: Buffer,
  options: {
    accessTokenProvider?: AccountAccessTokenProvider;
    /**
     * Called once per exported message. Awaited, so an implementation that has
     * to apply back-pressure (the zip writer suspends the backup while the
     * client is not reading) can hold the pipeline. A synchronous emit still
     * behaves exactly as before: awaiting a non-promise only costs one
     * microtask, and the FETCH that produced the chunk has already completed,
     * so the batching cadence of BACKUP_FETCH_CHUNK_SIZE is unchanged.
     *
     * The two signatures are a union rather than `void | Promise<void>` on
     * purpose: a plain union drops TypeScript's void-return rule and turns
     * every existing `emit: (entry) => entries.push(entry)` call site into a
     * type error, which the async half has no business doing.
     */
    emit?: ((entry: BackupMessageEntry) => void) | ((entry: BackupMessageEntry) => Promise<void>);
  } = {},
): Promise<MailBackupReport> {
  const accounts = loadAccounts(db);

  const report: MailBackupReport = {
    generatedAt: new Date().toISOString(),
    // Both counts used to come off the array the single query produced. Reading
    // them off the stream keeps the same definition: every row is counted, and
    // accountCount is the distinct account_id over all of them — including rows
    // whose account was deleted, which are only dropped further down, exactly
    // where the old grouping dropped them.
    accountCount: 0,
    messageCount: 0,
    exported: 0,
    failed: [],
  };
  const seenAccountIds = new Set<string>();

  // The archive index the entry paths are numbered by. One number per message
  // that reaches a folder, in the single global order the pages arrive in,
  // successful or failed — the failed-run counter of the previous version,
  // which also advanced past messages it could not export.
  let index = 0;
  let folder: OpenFolder | null = null;
  // Set once the caller has told us it can no longer receive entries. The walk
  // stops there: there is no response left to fill, and the report it returns
  // covers only the messages that were actually attempted.
  let transferClosed = false;
  const markTransferClosed = (): void => { transferClosed = true; };
  // Rows of the open folder that passed the move filter, waiting to be FETCHed
  // as one command. Bounded by BACKUP_FETCH_CHUNK_SIZE, never by folder size.
  let pending: Array<{ message: BackupPageRow; index: number }> = [];

  const failFolder = (target: OpenFolder, error: unknown): { code: MailErrorCode; reason: string } => {
    // A folder that cannot be reached blocks every message in it, but the
    // remaining folders still get their chance. The account row records the
    // classified error code so the UI distinguishes transport and protocol
    // causes instead of only a generic backup failure.
    const code = mailErrorCode(error);
    db.prepare("UPDATE accounts SET status = ?, last_error = ?, last_error_code = ? WHERE id = ?")
      .run("error", friendlyMailError(error), code, target.account.id);
    const failure = { code, reason: error instanceof Error ? error.message : String(error) };
    target.failure = failure;
    return failure;
  };

  const flushPending = async (target: OpenFolder): Promise<void> => {
    if (pending.length === 0) return;
    const chunk = pending;
    pending = [];
    const sourceByUid = new Map<number, Buffer>();
    let fetchError: unknown;
    try {
      const remoteMessages = target.client.fetch(chunk.map((entry) => entry.message.uid), { uid: true, source: true }, { uid: true });
      for await (const remote of remoteMessages) {
        if (remote.uid !== undefined && Buffer.isBuffer(remote.source)) sourceByUid.set(remote.uid, remote.source);
      }
    } catch (error) {
      // A failed batch does not abort the folder: messages already
      // streamed in this chunk are still exported, the rest fail with the
      // same error instead of aborting the whole backup run.
      fetchError = error;
    }
    for (let position = 0; position < chunk.length; position += 1) {
      const entry = chunk[position] as { message: BackupPageRow; index: number };
      const source = sourceByUid.get(entry.message.uid);
      if (source) {
        try {
          await options.emit?.({
            path: backupEntryName(typeof entry.message.subject === "string" ? entry.message.subject : "", entry.index),
            source,
          });
        } catch (error) {
          // The client that was receiving the archive is gone: there is nobody
          // left to report these messages to, so the run stops rather than
          // booking a whole folder as failed. The tail of the chunk is not
          // counted either - it was never attempted.
          if (error instanceof BackupTransferClosedError) throw error;
          // The caller's emit callback threw. Account for this row and for
          // every one left in the chunk, then rethrow so the caller blocks the
          // rest of the folder: the run still ends with each message counted
          // exactly once instead of losing the tail of the chunk.
          const code = mailErrorCode(error);
          const reason = error instanceof Error ? error.message : String(error);
          for (const rest of chunk.slice(position)) {
            report.failed.push({ messageId: rest.message.id, code, reason });
          }
          throw error;
        }
        report.exported += 1;
        continue;
      }
      report.failed.push({
        messageId: entry.message.id,
        code: fetchError ? mailErrorCode(fetchError) : "unknown",
        reason: fetchError ? (fetchError instanceof Error ? fetchError.message : String(fetchError)) : messageGoneReason,
      });
    }
  };

  const openFolder = async (account: AccountRecord, mailbox: string): Promise<OpenFolder> => {
    // Deliberately outside the try: a client that cannot even be constructed
    // (unreadable credentials) aborts the whole run, which is what the previous
    // version did and what the route turns into an export-error.json.
    const client = await imapClientForAccount(account, masterKey, options.accessTokenProvider);
    const opened: OpenFolder = { account, mailbox, client, lock: undefined, connected: false, failure: null };
    try {
      await client.connect();
      opened.connected = true;
      opened.lock = await client.getMailboxLock(mailbox);
    } catch (error) {
      failFolder(opened, error);
    }
    return opened;
  };

  const closeFolder = async (closing: OpenFolder | null): Promise<void> => {
    if (!closing) return;
    try {
      if (closing.failure === null) await flushPending(closing);
    } catch (error) {
      // A download that is already closed is not a folder failure: leave the
      // account row alone and just release the folder.
      if (error instanceof BackupTransferClosedError) markTransferClosed();
      // The folder's last partial chunk blew up in emit. Block it like any
      // other unreachable folder rather than letting the throw escape the run.
      else failFolder(closing, error);
    } finally {
      pending = [];
      try {
        closing.lock?.release();
      } catch {
        // Cleanup errors must not replace the transfer outcome.
      }
      if (closing.connected) void safeLogout(closing.client);
    }
  };

  const firstPage = db.prepare(backupPageSql(false));
  const nextPage = db.prepare(backupPageSql(true));
  let cursor: BackupCursor | null = null;

  for (;;) {
    const page = (cursor === null
      ? firstPage.all(BACKUP_PAGE_SIZE)
      : nextPage.all(cursor.accountId, cursor.mailbox, cursor.sortKey, cursor.uid, BACKUP_PAGE_SIZE)) as BackupPageRow[];
    if (page.length === 0) break;

    for (const message of page) {
      report.messageCount += 1;
      seenAccountIds.add(message.account_id);
      const account = accounts.get(message.account_id);
      // Same skip the old grouping had: a row whose account row is gone is
      // neither exported, nor failed, nor given an archive index.
      if (!account) continue;

      let active: OpenFolder | null = folder;
      if (active === null || active.account.id !== account.id || active.mailbox !== message.mailbox) {
        await closeFolder(active);
        // Closing the previous folder flushed its last chunk, which is where a
        // download that has already gone is discovered. Opening a connection
        // for the next folder to fill a response nobody is reading is waste.
        if (transferClosed) break;
        active = await openFolder(account, message.mailbox);
        folder = active;
      }
      if (active.failure) {
        // The folder could not be opened, so there is no lock to FETCH under:
        // every row it still has takes an index and the one classified error,
        // which is what the previous per-folder catch branch recorded.
        index += 1;
        report.failed.push({ messageId: message.id, code: active.failure.code, reason: active.failure.reason });
        continue;
      }
      index += 1;
      const blocked = moveActionBlockedError(message);
      if (blocked) {
        report.failed.push({ messageId: message.id, code: "unknown", reason: blocked });
        continue;
      }
      pending.push({ message, index });
      if (pending.length < BACKUP_FETCH_CHUNK_SIZE) continue;
      try {
        await flushPending(active);
      } catch (error) {
        // The download client left: stop the walk instead of burning the rest
        // of the mailbox on a response nobody is reading. The report is partial
        // by then, which is what the route wants — it cannot be delivered.
        if (error instanceof BackupTransferClosedError) { markTransferClosed(); break; }
        // emit threw part way through the chunk; the chunk's remaining rows are
        // already recorded, and the rest of the folder is now blocked too.
        failFolder(active, error);
      }
    }

    if (transferClosed) break;

    // Resume after the last row read, whether or not it belonged to the folder
    // that is currently open.
    const last: BackupPageRow | undefined = page[page.length - 1];
    if (!last) break;
    cursor = {
      accountId: last.account_id,
      mailbox: last.mailbox,
      sortKey: last.sort_key,
      uid: last.uid,
    };
  }

  await closeFolder(folder);
  report.accountCount = seenAccountIds.size;
  return report;
}
