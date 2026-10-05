import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

// The backup used to read the whole messages table in one SELECT and group it
// in memory, looking the account row up once per message. It now streams the
// table a page at a time through a keyset cursor. Everything a streaming
// rewrite can quietly get wrong lives in this file:
//
//   1. equivalence - the archive index, the failure list and the report must
//      match the previous implementation message for message. The old code is
//      kept below, verbatim, and run against the same fixtures as a reference;
//   2. plan        - each page has to be an index seek. A keyset without the
//      index re-scans the table per page, which is worse than the single query
//      it replaced, so both the index and the column form are pinned;
//   3. cursor      - crossing page boundaries loses and repeats nothing;
//   4. shape       - the number of rows held at once stays bounded by the page,
//      and the account rows are read once instead of once per message.

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { backupEntryName, BACKUP_PAGE_SIZE, backupPageSql, collectMailBackup } from "../src/backup.js";
import { SORT_KEY_SQL, openDatabase, type DatabaseHandle } from "../src/db.js";
import { friendlyMailError, mailErrorCode } from "../src/mail.js";
import { moveActionBlockedError, type MessageStorageRow } from "../src/message-storage.js";
import type { AccountRecord } from "../src/types.js";

const masterKey = Buffer.alloc(32, 21);
const now = "2026-08-10T00:00:00.000Z";

// ---------------------------------------------------------------- reference --

/**
 * The implementation this replaced: one unbounded SELECT, grouping in memory,
 * and one `SELECT * FROM accounts WHERE id = ?` per message. Kept as the
 * oracle the streaming version is compared against; do not "fix" it.
 */
const REFERENCE_FETCH_CHUNK_SIZE = 100;
const referenceMessageGoneReason = "Message is no longer available in this mailbox. Sync this message again.";

function referenceGroupByMailbox(db: DatabaseHandle, rows: readonly MessageStorageRow[]): Map<string, { account: AccountRecord; mailbox: string; messages: MessageStorageRow[] }> {
  const groups = new Map<string, { account: AccountRecord; mailbox: string; messages: MessageStorageRow[] }>();
  for (const row of rows) {
    const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(row.account_id) as AccountRecord | undefined;
    if (!account) continue;
    const key = `${row.account_id} ${row.mailbox}`;
    let group = groups.get(key);
    if (!group) {
      group = { account, mailbox: row.mailbox, messages: [] };
      groups.set(key, group);
    }
    group.messages.push(row);
  }
  return groups;
}

type ReferenceEntry = { path: string; source: Buffer };
type ReferenceFailure = { messageId: string; code: string; reason: string };
type ReferenceReport = { accountCount: number; messageCount: number; exported: number; failed: ReferenceFailure[] };

async function collectMailBackupReference(db: DatabaseHandle, options: { emit?: (entry: ReferenceEntry) => void } = {}): Promise<ReferenceReport> {
  const rows = db.prepare(`
    SELECT * FROM messages
    ORDER BY account_id, mailbox, COALESCE(sent_at, created_at) ASC
  `).all() as MessageStorageRow[];

  const report: ReferenceReport = {
    accountCount: new Set(rows.map((row) => row.account_id)).size,
    messageCount: rows.length,
    exported: 0,
    failed: [],
  };

  let index = 0;
  for (const group of referenceGroupByMailbox(db, rows).values()) {
    const client = await imapClientForAccount(group.account, masterKey);
    let lock: { release: () => void } | undefined;
    let connected = false;
    try {
      await client.connect();
      connected = true;
      lock = await client.getMailboxLock(group.mailbox);
      for (let chunkStart = 0; chunkStart < group.messages.length; chunkStart += REFERENCE_FETCH_CHUNK_SIZE) {
        const chunk = group.messages.slice(chunkStart, chunkStart + REFERENCE_FETCH_CHUNK_SIZE);
        const pending: Array<{ message: MessageStorageRow; index: number }> = [];
        for (const message of chunk) {
          index += 1;
          const blocked = moveActionBlockedError(message);
          if (blocked) {
            report.failed.push({ messageId: message.id, code: "unknown", reason: blocked });
            continue;
          }
          pending.push({ message, index });
        }
        if (pending.length === 0) continue;
        const sourceByUid = new Map<number, Buffer>();
        let fetchError: unknown;
        try {
          const remoteMessages = client.fetch(pending.map((entry) => entry.message.uid), { uid: true, source: true }, { uid: true });
          for await (const remote of remoteMessages) {
            if (remote.uid !== undefined && Buffer.isBuffer(remote.source)) sourceByUid.set(remote.uid, remote.source);
          }
        } catch (error) {
          fetchError = error;
        }
        for (const entry of pending) {
          const source = sourceByUid.get(entry.message.uid);
          if (source) {
            options.emit?.({
              path: backupEntryName(typeof entry.message.subject === "string" ? entry.message.subject : "", entry.index),
              source,
            });
            report.exported += 1;
            continue;
          }
          report.failed.push({
            messageId: entry.message.id,
            code: fetchError ? String(mailErrorCode(fetchError)) : "unknown",
            reason: fetchError ? (fetchError instanceof Error ? fetchError.message : String(fetchError)) : referenceMessageGoneReason,
          });
        }
      }
    } catch (error) {
      const code = String(mailErrorCode(error));
      db.prepare("UPDATE accounts SET status = ?, last_error = ?, last_error_code = ? WHERE id = ?")
        .run("error", friendlyMailError(error), code, group.account.id);
      for (const message of group.messages) {
        index += 1;
        report.failed.push({ messageId: message.id, code, reason: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      try {
        lock?.release();
      } catch {
        // Cleanup errors must not replace the transfer outcome.
      }
      if (connected && client.usable) void client.logout().catch(() => undefined);
    }
  }

  return report;
}

// ------------------------------------------------------------------ fixture --

type MessageSpec = {
  id: string;
  accountId: string;
  mailbox: string;
  uid: number;
  /** Seconds after the base instant; keeps every (account, mailbox) sort key distinct. */
  offset: number;
  pendingMoveState?: string | null;
  pendingMoveDestination?: string | null;
  remoteIdLookup?: string | null;
  /** No provider source: the backup records it as gone from the mailbox. */
  vanished?: boolean;
};

const BASE = Date.UTC(2026, 7, 10);

function sortKeyOf(offset: number): string {
  return new Date(BASE + offset * 1000).toISOString();
}

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.com`, now);
}

function insertMessage(db: DatabaseHandle, message: MessageSpec): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      remote_id_lookup, pending_move_state, pending_move_destination,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments,
      attachment_kinds_json, size, created_at
    ) VALUES (?, ?, ?, ?, ?, 'Sender', 'sender@example.com', '[]', ?, ?, ?, ?, '', '', '', '[]', 0, '[]', 0, ?)
  `).run(
    message.id, message.accountId, message.mailbox, message.uid, `Subject ${message.id}`,
    message.remoteIdLookup ?? null,
    message.pendingMoveState ?? null,
    message.pendingMoveDestination ?? null,
    sortKeyOf(message.offset), sortKeyOf(message.offset),
  );
}

/** Builds a fresh database from a message list, including the orphan-account case. */
function buildDatabase(specs: MessageSpec[], accounts: string[] = ["account-1", "account-2"]): DatabaseHandle {
  const db = openDatabase(":memory:");
  for (const account of accounts) insertAccount(db, account);
  for (const spec of specs) {
    if (accounts.includes(spec.accountId)) {
      insertMessage(db, spec);
      continue;
    }
    // The only way a message can outlive its account row is a database edited
    // outside the app; the old grouping dropped these, so the fixture has to be
    // able to create one.
    db.pragma("foreign_keys = OFF");
    insertMessage(db, spec);
    db.pragma("foreign_keys = ON");
  }
  return db;
}

type FakeSetup = { sources: Map<string, Buffer>; brokenMailboxes: Set<string>; brokenAccounts: Set<string> };

/**
 * A stub transport that hands back the message id as the "source", so every
 * emitted entry can be traced back to the exact row that produced it.
 */
function setupTransport(specs: MessageSpec[], brokenMailboxes: string[] = [], brokenAccounts: string[] = []): FakeSetup {
  const sources = new Map<string, Buffer>();
  for (const spec of specs) {
    if (spec.vanished) continue;
    sources.set(`${spec.accountId}|${spec.mailbox}|${spec.uid}`, Buffer.from(spec.id));
  }
  return { sources, brokenMailboxes: new Set(brokenMailboxes), brokenAccounts: new Set(brokenAccounts) };
}

function installTransport(setup: FakeSetup): void {
  imapClientForAccount.mockImplementation((account: AccountRecord) => {
    let locked = "";
    const lock = { release: vi.fn() };
    return {
      usable: true,
      connect: vi.fn(async () => {
        if (setup.brokenAccounts.has(account.id)) throw new Error("connection refused");
      }),
      getMailboxLock: vi.fn(async (path: string) => {
        if (setup.brokenMailboxes.has(path)) throw new Error(`mailbox unavailable: ${path}`);
        locked = path;
        return lock;
      }),
      fetch: vi.fn(async function* fetch(uids: number[]) {
        for (const uid of uids) {
          const source = setup.sources.get(`${account.id}|${locked}|${uid}`);
          if (source) yield { uid, source };
        }
      }),
      logout: vi.fn(async () => undefined),
    };
  });
}

type Emitted = { index: number; path: string; source: Buffer };

/** The archive index is the number embedded in the zip entry path. */
function indexOf(path: string): number {
  return Number(/^emails\/(\d+)_/.exec(path)?.[1]);
}

async function runStreaming(db: DatabaseHandle): Promise<{ report: Awaited<ReturnType<typeof collectMailBackup>>; emitted: Emitted[] }> {
  const emitted: Emitted[] = [];
  const report = await collectMailBackup(db, masterKey, {
    emit: (entry) => emitted.push({ index: indexOf(entry.path), path: entry.path, source: entry.source }),
  });
  return { report, emitted };
}

async function runReference(db: DatabaseHandle): Promise<{ report: ReferenceReport; emitted: Emitted[] }> {
  const emitted: Emitted[] = [];
  const report = await collectMailBackupReference(db, {
    emit: (entry) => emitted.push({ index: indexOf(entry.path), path: entry.path, source: entry.source }),
  });
  return { report, emitted };
}

function identity(entries: Emitted[]): Array<[number, string]> {
  return entries.map((entry) => [entry.index, entry.source.toString("utf8")]);
}

// ------------------------------------------------------------- 1 equivalence --

/**
 * One fixture that exercises every branch the report can take: two accounts,
 * five folders, a move still in flight, a confirmed move with no provider id, a
 * folder that cannot be locked, a message the provider no longer has, and a row
 * whose account was deleted. Every (account, mailbox) pair has distinct sort
 * keys, so the old query's order is fully determined and the two runs can be
 * compared position by position.
 */
const EQUIVALENCE_SPECS: MessageSpec[] = [
  { id: "m-01", accountId: "account-1", mailbox: "Archive", uid: 11, offset: 1 },
  { id: "m-02", accountId: "account-1", mailbox: "Archive", uid: 12, offset: 2, pendingMoveState: "intent", pendingMoveDestination: "INBOX" },
  { id: "m-03", accountId: "account-1", mailbox: "INBOX", uid: 13, offset: 3 },
  { id: "m-04", accountId: "account-1", mailbox: "INBOX", uid: 14, offset: 4 },
  { id: "m-05", accountId: "account-1", mailbox: "INBOX", uid: 15, offset: 5 },
  { id: "m-06", accountId: "account-1", mailbox: "INBOX", uid: 16, offset: 6, pendingMoveState: "confirmed", pendingMoveDestination: "Archive" },
  { id: "m-07", accountId: "account-1", mailbox: "Mid-broken", uid: 17, offset: 7 },
  { id: "m-08", accountId: "account-1", mailbox: "Mid-broken", uid: 18, offset: 8 },
  { id: "m-09", accountId: "account-1", mailbox: "Mid-broken", uid: 19, offset: 9 },
  { id: "m-10", accountId: "account-2", mailbox: "INBOX", uid: 20, offset: 10 },
  { id: "m-11", accountId: "account-2", mailbox: "INBOX", uid: 21, offset: 11 },
  { id: "m-12", accountId: "account-2", mailbox: "Sent", uid: 22, offset: 12 },
  { id: "m-13", accountId: "account-2", mailbox: "Vanished", uid: 23, offset: 13, vanished: true },
  { id: "m-14", accountId: "account-gone", mailbox: "INBOX", uid: 24, offset: 14 },
];

describe("backup streaming is equivalent to the previous implementation", () => {
  let db: DatabaseHandle;
  let referenceDb: DatabaseHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    installTransport(setupTransport(EQUIVALENCE_SPECS, ["Mid-broken"]));
    db = buildDatabase(EQUIVALENCE_SPECS);
    referenceDb = buildDatabase(EQUIVALENCE_SPECS);
  });

  afterEach(() => {
    db?.close();
    referenceDb?.close();
  });

  it("emits the same entries, in the same order, under the same archive index", async () => {
    const before = await runReference(referenceDb);
    const after = await runStreaming(db);

    // The stub returns the row id as the source, so this maps archive index ->
    // exact message, not just "some message with a similar subject".
    expect(identity(after.emitted)).toEqual(identity(before.emitted));
    expect(after.emitted.map((entry) => entry.path)).toEqual(before.emitted.map((entry) => entry.path));
    expect(after.emitted.map((entry) => entry.index)).toEqual([1, 3, 4, 5, 10, 11, 12]);
  });

  it("reports the same counts, including rows whose account is gone", async () => {
    const before = await runReference(referenceDb);
    const after = await runStreaming(db);

    expect(after.report).toMatchObject({
      accountCount: before.report.accountCount,
      messageCount: before.report.messageCount,
      exported: before.report.exported,
    });
    expect(after.report).toMatchObject({ accountCount: 3, messageCount: 14, exported: 7 });
  });

  it("records the same failures, with the same codes and reasons", async () => {
    const before = await runReference(referenceDb);
    const after = await runStreaming(db);

    expect(after.report.failed).toEqual(before.report.failed);
    expect(after.report.failed.map((failure) => failure.messageId)).toEqual([
      "m-02", "m-06", "m-07", "m-08", "m-09", "m-13",
    ]);
    // A move in flight keeps the move-specific reason, not a transport one.
    const rowFor = (id: string) => db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageStorageRow;
    expect(after.report.failed[0]?.reason).toBe(moveActionBlockedError(rowFor("m-02")));
    expect(after.report.failed[1]?.reason).toBe(moveActionBlockedError(rowFor("m-06")));
    // A folder that cannot be locked fails all of its messages with that one error.
    expect(after.report.failed[2]).toMatchObject({ code: "unknown", reason: "mailbox unavailable: Mid-broken" });
    expect(after.report.failed[4]).toMatchObject({ code: "unknown", reason: "mailbox unavailable: Mid-broken" });
    // A message the provider no longer has keeps the gone-from-mailbox reason.
    expect(after.report.failed[5]).toMatchObject({ code: "unknown", reason: "Message is no longer available in this mailbox. Sync this message again." });
  });

  it("leaves the account row in the same state after a folder fails to open", async () => {
    await runStreaming(db);
    expect(db.prepare("SELECT status, last_error, last_error_code FROM accounts WHERE id = ?").get("account-1")).toMatchObject({
      status: "error",
      last_error_code: "unknown",
    });
    expect(db.prepare("SELECT status FROM accounts WHERE id = ?").get("account-2")).toMatchObject({ status: "connected" });
  });

  it("numbers every folder of an unreachable account exactly like the reference", async () => {
    // The other failure entry point: connect() rather than the mailbox lock.
    installTransport(setupTransport(EQUIVALENCE_SPECS, [], ["account-2"]));
    const brokenDb = buildDatabase(EQUIVALENCE_SPECS);
    const brokenReferenceDb = buildDatabase(EQUIVALENCE_SPECS);
    const before = await runReference(brokenReferenceDb);
    const after = await runStreaming(brokenDb);

    expect(identity(after.emitted)).toEqual(identity(before.emitted));
    expect(after.report.failed).toEqual(before.report.failed);
    // Every folder of the unreachable account fails with the classified code,
    // and the archive index carries on through them in the same order.
    const accountTwo = after.report.failed.filter((failure) => ["m-10", "m-11", "m-12", "m-13"].includes(failure.messageId));
    expect(accountTwo.map((failure) => failure.messageId)).toEqual(["m-10", "m-11", "m-12", "m-13"]);
    expect(accountTwo.map((failure) => failure.code)).toEqual(["connection_refused", "connection_refused", "connection_refused", "connection_refused"]);
    brokenDb.close();
    brokenReferenceDb.close();
  });

  it("keeps the move filter working on the narrowed page projection", () => {
    // backupPageSql selects only the columns the pipeline reads. If a column
    // moveActionBlockedError depends on were left out, an in-flight move would
    // silently start being exported, so the verdicts have to stay identical when
    // the row is rebuilt from exactly the projected columns.
    const columns = backupPageSql(false).match(/^SELECT (.+?) FROM messages/s)?.[1]?.split(",").map((column) => column.trim()) ?? [];
    const rows = db.prepare(backupPageSql(false)).all(BACKUP_PAGE_SIZE) as MessageStorageRow[];
    const projected = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));

    // m-02 (an intent) and m-06 (a confirmed move with no provider id) cover
    // both branches moveActionBlockedError has, so the projection has to carry
    // the destination, the state and the provider id for the verdicts to match.
    expect(projected.map(moveActionBlockedError).filter(Boolean)).toHaveLength(2);
    expect(projected.map(moveActionBlockedError)).toEqual(rows.map(moveActionBlockedError));
    // A row with no move recorded at all is exportable.
    expect(moveActionBlockedError({ pending_move_destination: null, pending_move_state: null, remote_id_lookup: "opaque" })).toBeNull();
  });
});

// -------------------------------------------------------------------- 2 plan --

function planFor(db: DatabaseHandle, sql: string, params: unknown[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
}

describe("backup paging runs on an index", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
    const insert = db.prepare(`
      INSERT INTO messages (id, account_id, mailbox, uid, sent_at, created_at, subject, snippet, text_body, html_body, flags_json, has_attachments, size)
      VALUES (?, 'account-1', ?, ?, ?, ?, 'subject', '', '', '', '[]', 0, 0)
    `);
    for (let index = 0; index < 400; index += 1) {
      insert.run(`p-${index}`, index % 2 === 0 ? "INBOX" : "Archive", index + 1, new Date(BASE + index * 1000).toISOString(), new Date(BASE).toISOString());
    }
  });

  afterEach(() => {
    db?.close();
  });

  it("seeks the keyset index on every page after the first", () => {
    const plan = planFor(db, backupPageSql(true), ["account-1", "INBOX", "2026-08-10T00:00:00.000Z", 1, 1000]);
    // Matched with a word boundary on purpose: a same-shaped index under another
    // name must not satisfy this, the migration has to have created this one.
    expect(plan).toMatch(/USING INDEX idx_messages_account_mailbox_sort_key\b/);
    expect(plan).toContain("SEARCH");
    expect(plan).not.toContain("SCAN messages");
    expect(plan).not.toContain("USE TEMP B-TREE");
  });

  it("reads the first page straight off the same index", () => {
    const plan = planFor(db, backupPageSql(false), [1000]);
    expect(plan).toMatch(/USING INDEX idx_messages_account_mailbox_sort_key\b/);
    expect(plan).not.toContain("USE TEMP B-TREE");
  });

  it("sorts every page in a temp b-tree if the supporting index is missing", () => {
    // This is the failure mode the index exists to prevent, so the assertion
    // above is worthless unless dropping the index really does degrade it.
    // Without it SQLite falls back to the UNIQUE(account_id, mailbox, uid)
    // autoindex and has to sort the two trailing terms on every page.
    db.exec("DROP INDEX idx_messages_account_mailbox_sort_key");
    const plan = planFor(db, backupPageSql(true), ["account-1", "INBOX", "2026-08-10T00:00:00.000Z", 1, 1000]);
    expect(plan).not.toContain("idx_messages_account_mailbox_sort_key");
    expect(plan).toContain("USE TEMP B-TREE");
  });

  it("sorts in a temp b-tree again if the expression is spelled out", () => {
    // The other way to lose the index: keeping the column but ordering by the
    // COALESCE expression the old query used, which no index can serve.
    const plan = planFor(
      db,
      `SELECT id FROM messages WHERE (account_id, mailbox, sort_key, uid) > (?, ?, ?, ?)
       ORDER BY account_id, mailbox, COALESCE(sent_at, created_at) ASC LIMIT ?`,
      ["account-1", "INBOX", "2026-08-10T00:00:00.000Z", 1, 1000],
    );
    expect(plan).toContain("USE TEMP B-TREE");
  });

  it("orders on the generated sort key, not a second copy of its expression", () => {
    const mismatched = (db.prepare(`
      SELECT id FROM messages WHERE sort_key <> COALESCE(sent_at, created_at) LIMIT 1
    `).all() as unknown[]).length;
    expect(mismatched).toBe(0);
    expect(SORT_KEY_SQL).toBe("COALESCE(sent_at, created_at)");
    expect(backupPageSql(true)).toContain("ORDER BY account_id, mailbox, sort_key, uid");
  });
});

// ------------------------------------------------------------------ 3 cursor --

const LARGE_ACCOUNTS = ["account-1", "account-2", "account-3"];
const LARGE_MAILBOXES = ["Archive", "INBOX", "Sent"];

/** Spans several pages, several folders and several accounts, with shared sort keys. */
function largeFixture(total: number): MessageSpec[] {
  const specs: MessageSpec[] = [];
  for (let index = 0; index < total; index += 1) {
    const accountId = LARGE_ACCOUNTS[index % LARGE_ACCOUNTS.length] as string;
    const mailbox = LARGE_MAILBOXES[Math.floor(index / LARGE_ACCOUNTS.length) % LARGE_MAILBOXES.length] as string;
    // uid only has to be unique inside a folder, so count within the folder.
    const uid = specs.filter((spec) => spec.accountId === accountId && spec.mailbox === mailbox).length + 1;
    specs.push({
      id: `big-${String(index).padStart(5, "0")}`,
      accountId,
      mailbox,
      uid,
      // Three consecutive rows share every sort key, so the tie breaker that
      // makes the keyset a total order is exercised too.
      offset: Math.floor(index / 3),
    });
  }
  return specs;
}

/** The order the backup is expected to walk, derived from the fixture itself. */
function expectedOrder(specs: MessageSpec[]): string[] {
  return [...specs]
    .sort((left, right) => (
      left.accountId.localeCompare(right.accountId, "en")
      || left.mailbox.localeCompare(right.mailbox, "en")
      || left.offset - right.offset
      || left.uid - right.uid
    ))
    .map((spec) => spec.id);
}

describe("backup keyset cursor", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    db?.close();
  });

  it("crosses page boundaries without repeating or dropping a message", async () => {
    const specs = largeFixture(BACKUP_PAGE_SIZE * 2 + 345);
    db = buildDatabase(specs, LARGE_ACCOUNTS);
    installTransport(setupTransport(specs));

    const { report, emitted } = await runStreaming(db);

    expect(report.messageCount).toBe(specs.length);
    expect(report.exported).toBe(specs.length);
    expect(report.failed).toEqual([]);
    // Every row is emitted exactly once, in the order the cursor is supposed
    // to produce, under a dense 1..N archive index.
    expect(emitted.map((entry) => entry.source.toString("utf8"))).toEqual(expectedOrder(specs));
    expect(emitted.map((entry) => entry.index)).toEqual(specs.map((_, position) => position + 1));
  });

  it("keeps one folder, one connection and one index across several pages", async () => {
    // Every row in a single folder: the whole archive index is decided inside
    // one connection, which only closes after the last page.
    const specs: MessageSpec[] = Array.from({ length: BACKUP_PAGE_SIZE + 25 }, (_, index) => ({
      id: `one-${String(index).padStart(5, "0")}`,
      accountId: "account-1",
      mailbox: "INBOX",
      uid: index + 1,
      offset: index,
    }));
    db = buildDatabase(specs, ["account-1"]);

    const fetchSizes: number[] = [];
    imapClientForAccount.mockImplementation(() => ({
      usable: true,
      connect: vi.fn(async () => undefined),
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      fetch: vi.fn(async function* fetch(uids: number[]) {
        fetchSizes.push(uids.length);
        for (const uid of uids) yield { uid, source: Buffer.from(`one-${String(uid - 1).padStart(5, "0")}`) };
      }),
      logout: vi.fn(async () => undefined),
    }));

    const { report, emitted } = await runStreaming(db);

    expect(report).toMatchObject({ accountCount: 1, messageCount: specs.length, exported: specs.length, failed: [] });
    expect(emitted.map((entry) => entry.source.toString("utf8"))).toEqual(specs.map((spec) => spec.id));
    // One connection for the whole folder, and FETCH still batched by 100.
    expect(imapClientForAccount).toHaveBeenCalledTimes(1);
    expect(fetchSizes.slice(0, -1)).toEqual(new Array(10).fill(100));
    expect(fetchSizes.at(-1)).toBe(25);
  });
});

// -------------------------------------------------------------------- 4 shape --

/** Records every statement the backup runs and how many rows each one returned. */
type Query = { sql: string; rows: number };

function instrument(db: DatabaseHandle): { db: DatabaseHandle; queries: Query[] } {
  const queries: Query[] = [];
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(inner, innerProperty) {
              if (innerProperty === "all") {
                return (...args: unknown[]) => {
                  const rows = inner.all(...args);
                  queries.push({ sql, rows: rows.length });
                  return rows;
                };
              }
              const value = Reflect.get(inner, innerProperty, inner);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseHandle;
  return { db: proxy, queries };
}

describe("backup holds a bounded number of rows", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    db?.close();
  });

  it("never asks the database for more than a page of messages at a time", async () => {
    const specs = largeFixture(BACKUP_PAGE_SIZE * 2 + 7);
    db = buildDatabase(specs, LARGE_ACCOUNTS);
    installTransport(setupTransport(specs));
    const spy = instrument(db);

    await runStreaming(spy.db);

    // No statement reads the table unbounded: the two page statements are
    // prepared once each and run once per page.
    const pageStatements = [...new Set(spy.queries.filter((query) => /FROM messages/.test(query.sql)).map((query) => query.sql.replace(/\s+/g, " ").trim()))];
    expect(pageStatements).toHaveLength(2);
    expect(pageStatements.every((sql) => sql.endsWith("ORDER BY account_id, mailbox, sort_key, uid LIMIT ?"))).toBe(true);
    // A real page count, and no single read wider than one page. The walk ends
    // on an empty read rather than trusting a short page to be the last one.
    const messageQueries = spy.queries.filter((query) => /FROM messages/.test(query.sql));
    expect(messageQueries.map((query) => query.rows)).toEqual([BACKUP_PAGE_SIZE, BACKUP_PAGE_SIZE, 7, 0]);
    expect(messageQueries.every((query) => query.rows <= BACKUP_PAGE_SIZE)).toBe(true);
  });

  it("reads the account rows once instead of once per message", async () => {
    const specs = largeFixture(240);
    db = buildDatabase(specs, LARGE_ACCOUNTS);
    installTransport(setupTransport(specs));
    const spy = instrument(db);

    await runStreaming(spy.db);

    // The old grouping prepared and ran `SELECT * FROM accounts WHERE id = ?`
    // once per message; one bulk read replaces all of them.
    const accountQueries = spy.queries.filter((query) => /FROM accounts/.test(query.sql));
    expect(accountQueries).toHaveLength(1);
    expect(accountQueries[0]?.rows).toBe(LARGE_ACCOUNTS.length);
  });
});

