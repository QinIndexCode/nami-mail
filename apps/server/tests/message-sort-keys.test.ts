import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EFFECTIVE_MAILBOX_SQL, SORT_KEY_SQL, openDatabase, type DatabaseHandle } from "../src/db.js";
import { accountById } from "../src/account-store.js";
import { buildMessageListSql } from "../src/message-filters.js";
import { countMessageRows, listMessageRows } from "../src/message-queries.js";
import { saveDraft } from "../src/drafts.js";
import { syncAccount } from "../src/sync.js";
import { moveMessage } from "../src/sync-moves.js";

// The list queries read two VIRTUAL generated columns instead of recomputing
// COALESCE(sent_at, created_at) and the pending-move CASE. SQLite derives both
// from the current row on every read, so this file has to pin three things:
//
//   1. derivation  - the columns equal the expressions they are defined as, row
//                    for row, for every shape the schema allows;
//   2. value       - the real sync / move / draft write points land on exactly
//                    the values the previous stored-column scheme bound by
//                    hand, including the paths that needed the destination
//                    bound twice because a SET expression reads the old row;
//   3. plan        - the ORDER BY is served by an index instead of the
//                    "USE TEMP B-TREE FOR ORDER BY" sorter that made a folder
//                    switch cost a second of synchronous work on a large
//                    mailbox.
//
// Every fixture below inserts rows with a bare INSERT that names neither
// column, which is what the previous version had to follow with an explicit
// backfill. That gap is the point: nothing here seeds a value, so a fixture
// cannot forget to.

const masterKey = Buffer.alloc(32, 7);

/** The expression each column is defined as, evaluated on a live row. */
const EXPRESSION_SQL = `${SORT_KEY_SQL} AS expected_sort_key,
  ${EFFECTIVE_MAILBOX_SQL} AS expected_mailbox`;

type GeneratedRow = {
  id: string;
  sent_at: string | null;
  created_at: string;
  mailbox: string;
  pending_move_destination: string | null;
  pending_move_state: string | null;
  sort_key: string;
  effective_mailbox: string;
  expected_sort_key: string;
  expected_mailbox: string;
};

/** Every row with both the generated value and the expression side by side. */
function generatedRows(db: DatabaseHandle, accountId = "account-1"): GeneratedRow[] {
  return db.prepare(`
    SELECT id, sent_at, created_at, mailbox, pending_move_destination, pending_move_state,
           sort_key, effective_mailbox, ${EXPRESSION_SQL}
    FROM messages WHERE account_id = ? ORDER BY id
  `).all(accountId) as GeneratedRow[];
}

/** Asserts the invariant the whole feature rests on: generated === expression. */
function expectColumnsMatchExpressions(rows: GeneratedRow[]): void {
  expect(rows.map((row) => [row.id, row.sort_key, row.expected_sort_key, row.effective_mailbox, row.expected_mailbox]))
    .toEqual(rows.map((row) => [row.id, row.expected_sort_key, row.expected_sort_key, row.expected_mailbox, row.expected_mailbox]));
}

function planFor(db: DatabaseHandle, selection: ReturnType<typeof buildMessageListSql>, params: unknown[]): string {
  return (db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT m.id
    ${selection.join}
    JOIN accounts a ON a.id = m.account_id
    ${selection.where}
    ORDER BY m.sort_key DESC
    LIMIT 50 OFFSET 0
  `).all(...params) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
}

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.com`, new Date().toISOString());
}

let uidSequence = 0;

/**
 * A bare insert: the column list ends at created_at, so neither generated
 * column is ever named. This is a complete write under the current schema.
 */
function insertMessage(
  db: DatabaseHandle,
  message: {
    id: string; mailbox: string; sentAt?: string | null; createdAt: string;
    pendingMoveDestination?: string | null; pendingMoveState?: string | null;
  },
): void {
  uidSequence += 1;
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at,
      pending_move_destination, pending_move_state
    ) VALUES (?, 'account-1', ?, ?, '', 'Sender', 'sender@example.com', '[]',
      ?, '', '', '', '[]', 0, 0, ?, ?, ?)
  `).run(
    message.id,
    message.mailbox,
    uidSequence,
    message.sentAt ?? null,
    message.createdAt,
    message.pendingMoveDestination ?? null,
    message.pendingMoveState ?? null,
  );
}

describe("generated list order and folder membership", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount(db);
  });

  afterEach(() => {
    db?.close();
  });

  describe("sort order equivalence", () => {
    // sent_at present / absent / duplicated, and created_at deliberately
    // shared between rows so the COALESCE fallback and the id tiebreak are
    // both exercised instead of a single unambiguous ordering.
    const dataset = [
      { id: "a-sent-only", sentAt: "2026-03-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b-no-sent", sentAt: null, createdAt: "2026-02-01T00:00:00.000Z" },
      { id: "c-tie-early", sentAt: "2026-03-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "d-tie-late", sentAt: "2026-03-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "e-no-sent-tie", sentAt: null, createdAt: "2026-02-01T00:00:00.000Z" },
      { id: "f-no-sent-newest", sentAt: null, createdAt: "2026-04-01T00:00:00.000Z" },
      { id: "g-sent-oldest", sentAt: "2025-12-24T23:59:59.999Z", createdAt: "2026-06-01T00:00:00.000Z" },
    ];

    beforeEach(() => {
      for (const row of dataset) insertMessage(db, { ...row, mailbox: "INBOX" });
    });

    it("orders by the generated key exactly like COALESCE(sent_at, created_at), ties included", () => {
      expectColumnsMatchExpressions(generatedRows(db));
      const byColumn = db.prepare("SELECT id FROM messages ORDER BY sort_key DESC, id DESC").all() as Array<{ id: string }>;
      const byExpression = db.prepare("SELECT id FROM messages ORDER BY COALESCE(sent_at, created_at) DESC, id DESC").all() as Array<{ id: string }>;
      expect(byColumn).toEqual(byExpression);
      // Guards the fixture itself: without real ties and NULL sent_at the two
      // orderings could agree by accident.
      expect(byColumn.map((row) => row.id)).toEqual([
        "f-no-sent-newest", "d-tie-late", "c-tie-early", "a-sent-only", "e-no-sent-tie", "b-no-sent", "g-sent-oldest",
      ]);
    });

    it("listMessageRows returns the same page as the expression it replaced", () => {
      const selection = buildMessageListSql({ accountId: "account-1" });
      // The reference is the expression, not the generated column — that is the
      // whole claim. It carries the same `id DESC` tiebreak the list orders by,
      // so both sides have one defined answer; without it the three rows that
      // share 2026-03-01 could come back in either order and the comparison
      // would be a coin flip rather than an equivalence.
      const byExpression = db.prepare(`
        SELECT m.id ${selection.join} ${selection.where}
        ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC LIMIT 3 OFFSET 0
      `).all(...selection.params) as Array<{ id: string }>;
      expect(listMessageRows(db, selection, { limit: 3 }).map((row) => row.id)).toEqual(byExpression.map((row) => row.id));
    });
  });

  describe("folder filter equivalence", () => {
    // Every pending-move shape the CASE distinguishes, crossed with folders:
    // no move, intent with an empty destination, intent with a destination,
    // a confirmed move and a non-intent state carrying a destination.
    const rows = [
      { id: "plain-inbox", mailbox: "INBOX", destination: null, state: null },
      { id: "plain-archive", mailbox: "Archive", destination: null, state: null },
      { id: "intent-empty", mailbox: "INBOX", destination: "", state: "intent" },
      { id: "intent-target", mailbox: "INBOX", destination: "Archive", state: "intent" },
      { id: "confirmed-target", mailbox: "INBOX", destination: "Archive", state: "confirmed" },
      { id: "confirmed-empty", mailbox: "Archive", destination: "", state: "confirmed" },
      { id: "no-state-target", mailbox: "INBOX", destination: "Archive", state: null },
      { id: "null-destination", mailbox: "Archive", destination: null, state: "confirmed" },
    ] as const;

    beforeEach(() => {
      for (const row of rows) {
        insertMessage(db, {
          id: row.id,
          mailbox: row.mailbox,
          sentAt: "2026-03-01T00:00:00.000Z",
          createdAt: "2026-03-01T00:00:00.000Z",
          pendingMoveDestination: row.destination,
          pendingMoveState: row.state,
        });
      }
    });

    it.each(["INBOX", "Archive", "Nowhere"])("folder %s selects the same rows through the column and the CASE", (folder) => {
      expectColumnsMatchExpressions(generatedRows(db));
      const byColumn = db.prepare("SELECT id FROM messages WHERE effective_mailbox = ? ORDER BY id").all(folder) as Array<{ id: string }>;
      const byExpression = db.prepare(`
        SELECT id FROM messages
        WHERE ${EFFECTIVE_MAILBOX_SQL} = ? ORDER BY id
      `).all(folder) as Array<{ id: string }>;
      expect(byColumn).toEqual(byExpression);
    });

    it("an in-flight intent stays in the source folder until the move is proven", () => {
      expectColumnsMatchExpressions(generatedRows(db));
      const inbox = buildMessageListSql({ accountId: "account-1", folder: "INBOX" });
      const archive = buildMessageListSql({ accountId: "account-1", folder: "Archive" });
      const ids = (selection: typeof inbox) => db.prepare(`SELECT m.id ${selection.join} ${selection.where} ORDER BY m.id`)
        .all(...selection.params).map((row) => (row as { id: string }).id);
      // "intent-target" is moving to Archive but is still filed under INBOX;
      // "confirmed-target" has left INBOX without its mailbox changing yet.
      expect(ids(inbox)).toEqual(["intent-empty", "intent-target", "plain-inbox"]);
      expect(ids(archive)).toEqual(["confirmed-empty", "confirmed-target", "no-state-target", "null-destination", "plain-archive"]);
    });

    it("countMessageRows counts the same rows as the expression it replaced", () => {
      for (const folder of ["INBOX", "Archive", "Nowhere"]) {
        const selection = buildMessageListSql({ accountId: "account-1", folder });
        const byExpression = Number((db.prepare(`
          SELECT COUNT(*) AS count FROM messages m
          WHERE m.account_id = ? AND ${EFFECTIVE_MAILBOX_SQL} = ?
        `).get("account-1", folder) as { count: number }).count);
        expect(countMessageRows(db, selection)).toBe(byExpression);
      }
    });
  });

  describe("a bare insert is a complete write", () => {
    // The failure mode the stored-column scheme could not rule out: a write
    // that forgets the two columns leaves a row that is in no folder and sorts
    // last. Here nothing can forget, because nothing writes them.
    beforeEach(() => {
      insertMessage(db, { id: "bare-newest", mailbox: "INBOX", sentAt: null, createdAt: "2026-03-01T00:00:00.000Z" });
      insertMessage(db, { id: "bare-older", mailbox: "INBOX", sentAt: "2026-01-05T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
      insertMessage(db, { id: "bare-archive", mailbox: "Archive", sentAt: "2026-02-01T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z" });
    });

    it("a row inserted without naming either column is listed and filtered correctly", () => {
      expectColumnsMatchExpressions(generatedRows(db));
      // The account view is the unified inbox, and it orders the bare rows
      // newest-first off the generated key: the COALESCE fallback row sorts
      // above the one carrying a real sent_at.
      const inbox = buildMessageListSql({ accountId: "account-1" });
      expect(listMessageRows(db, inbox, { limit: 10 }).map((row) => row.id)).toEqual(["bare-newest", "bare-older"]);
      expect(countMessageRows(db, inbox)).toBe(2);
      const archive = buildMessageListSql({ accountId: "account-1", folder: "Archive" });
      expect(listMessageRows(db, archive, { limit: 10 }).map((row) => row.id)).toEqual(["bare-archive"]);
      expect(countMessageRows(db, archive)).toBe(1);
    });

    it("the columns cannot be written at all, so no write point can go stale", () => {
      expect(() => db.prepare("INSERT INTO messages (id, account_id, mailbox, uid, created_at, sort_key) VALUES ('x', 'account-1', 'INBOX', 900, '2026-01-01T00:00:00.000Z', 'lie')").run())
        .toThrow(/cannot INSERT into generated column "sort_key"/);
      expect(() => db.prepare("UPDATE messages SET effective_mailbox = 'lie' WHERE id = 'bare-newest'").run())
        .toThrow(/cannot UPDATE generated column "effective_mailbox"/);
    });

    it("a later write re-derives both columns from the row as it now stands", () => {
      // The stored-column scheme had to repeat the new value in the same SET
      // because a SET expression reads the pre-UPDATE row. Derivation has no
      // such ordering to get wrong.
      db.prepare("UPDATE messages SET sent_at = ? WHERE id = 'bare-archive'").run("2026-09-01T00:00:00.000Z");
      db.prepare("UPDATE messages SET mailbox = ? WHERE id = 'bare-archive'").run("Trash");
      const row = generatedRows(db).find((candidate) => candidate.id === "bare-archive")!;
      expectColumnsMatchExpressions([row]);
      expect(row.sort_key).toBe("2026-09-01T00:00:00.000Z");
      expect(row.effective_mailbox).toBe("Trash");
    });
  });

  describe("query plan", () => {
    beforeEach(() => {
      const insert = db.prepare(`
        INSERT INTO messages (
          id, account_id, mailbox, uid, sent_at, created_at, snippet, text_body, html_body,
          flags_json, has_attachments, size
        ) VALUES (?, 'account-1', ?, ?, ?, ?, '', '', '', '[]', 0, 0)
      `);
      for (let index = 0; index < 400; index += 1) {
        const mailbox = index % 2 === 0 ? "INBOX" : "Archive";
        const sentAt = index % 3 === 0 ? null : new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
        const createdAt = new Date(Date.UTC(2026, 0, 1) + index * 30_000).toISOString();
        insert.run(`m-${index}`, mailbox, index + 1, sentAt, createdAt);
      }
    });

    it("serves the folder view from an index instead of sorting every row", () => {
      const selection = buildMessageListSql({ accountId: "account-1", folder: "INBOX" });
      const plan = planFor(db, selection, selection.params);
      expect(plan).toContain("idx_messages_account_effective_mailbox");
      expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
      expect(plan).not.toContain("SCAN m");
    });

    it("serves the whole-account view from the sort-key index", () => {
      const selection = buildMessageListSql({ accountId: "account-1", folder: undefined });
      const plan = planFor(db, selection, selection.params);
      expect(plan).toContain("idx_messages_account_sort_key");
      expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    });

    it("the expression it replaced is exactly the plan this feature exists to remove", () => {
      // If a future change puts the expression back into the ORDER BY, the two
      // assertions above fail; this one documents why they are written that way.
      const plan = (db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT m.id FROM messages m JOIN accounts a ON a.id = m.account_id
        WHERE m.account_id = ? AND ${EFFECTIVE_MAILBOX_SQL.replaceAll("pending_move_", "m.pending_move_").replaceAll("mailbox", "m.mailbox")} = ?
        ORDER BY COALESCE(m.sent_at, m.created_at) DESC LIMIT 50 OFFSET 0
      `).all("account-1", "INBOX") as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
      expect(plan).toContain("USE TEMP B-TREE FOR ORDER BY");
    });
  });
});

describe("write-point value equivalence", () => {
  // The stored-column scheme bound these two values by hand at every write
  // point, and in four of them had to bind the destination twice: a SET
  // expression reads the pre-UPDATE row, so `effective_mailbox = mailbox` in
  // the same statement as `mailbox = ?` would have kept the source folder.
  // These cases run the real code and assert the generated value equals both
  // the expression and the folder the old scheme bound.
  let db: DatabaseHandle;
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => lock),
    messageMove: vi.fn(),
    append: vi.fn(async () => ({ destination: "Drafts", uid: 1 })),
    logout: vi.fn(async () => undefined),
  };
  const inbox = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };
  const archive = { path: "Archive", name: "Archive", listed: true, flags: new Set<string>(), specialUse: "\\Archive" };

  function setFolders(extra: Array<{ path: string; specialUse: string }> = []): void {
    const insert = db.prepare("INSERT OR REPLACE INTO folders (account_id, path, name, special_use, total, unseen, uid_validity) VALUES (?, ?, ?, ?, 0, 0, '1')");
    insert.run("account-1", "INBOX", "Inbox", "\\Inbox");
    for (const folder of extra) insert.run("account-1", folder.path, folder.path, folder.specialUse);
  }

  /** Metadata-only source for one message; pass `source` to also return the body. */
  function fakeFetch(uid: number, sentAt: string | null, source: Buffer | null, emailId = `id-${uid}`) {
    return vi.fn(async function* (range: unknown, query: { source?: unknown }) {
      if (query.source) {
        if (!source) return;
        yield { uid, emailId, flags: new Set<string>(), internalDate: new Date(sentAt ?? "2026-05-05T00:00:00.000Z"), size: source.length, source };
        return;
      }
      if (Array.isArray(range) && !range.includes(uid)) return;
      yield { uid, emailId, flags: new Set<string>(), internalDate: new Date(sentAt ?? "2026-05-05T00:00:00.000Z") };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db = openDatabase(":memory:");
    insertAccount(db);
    imapClientForAccount.mockReturnValue(client);
  });

  afterEach(() => {
    db.close();
  });

  it("stores a new message with both columns already derived", async () => {
    setFolders();
    Object.assign(client, {
      mailbox: { exists: 1, uidValidity: 1n },
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch: fakeFetch(7, "2026-05-01T10:00:00.000Z", Buffer.from("Subject: New\r\n\r\nBody")),
    });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ synced: 1 });

    const rows = generatedRows(db);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expectColumnsMatchExpressions([row]);
    expect(row.sort_key).toBe("2026-05-01T10:00:00.000Z");
    expect(row.effective_mailbox).toBe("INBOX");
  });

  it("keeps the columns correct when an existing row gains its sent_at", async () => {
    // A row cached without a Date header: sort_key falls back to created_at
    // until a later pass supplies the real sent_at, which must re-sort it. The
    // upsert's DO UPDATE sets sent_at alone; the old scheme had to repeat the
    // derived sort_key in the same statement.
    insertMessage(db, { id: "existing", mailbox: "INBOX", sentAt: null, createdAt: "2026-01-01T00:00:00.000Z" });
    expect(generatedRows(db)[0]!.sort_key).toBe("2026-01-01T00:00:00.000Z");

    setFolders();
    Object.assign(client, {
      mailbox: { exists: uidSequence, uidValidity: 1n },
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch: fakeFetch(uidSequence, "2026-07-04T08:30:00.000Z", Buffer.from("Subject: Filled\r\n\r\nBody")),
    });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 1 });

    const rows = generatedRows(db);
    expectColumnsMatchExpressions(rows);
    expect(rows[0]!.sort_key).toBe("2026-07-04T08:30:00.000Z");
  });

  it("keeps a move intent in the source folder, and files the row once confirmed", async () => {
    // applyMovePendingReconciliation: the row keeps its source mailbox and
    // gains pending_move_state='confirmed'. The old scheme bound
    // effective_mailbox = COALESCE(NULLIF(destination, ''), mailbox) here.
    setFolders([{ path: "Archive", specialUse: "\\Archive" }]);
    insertMessage(db, { id: "moved", mailbox: "INBOX", sentAt: "2026-05-01T10:00:00.000Z", createdAt: "2026-05-01T10:00:00.000Z" });
    client.messageMove.mockResolvedValue({ path: "INBOX", destination: "Archive" });

    await expect(moveMessage(db, masterKey, "moved", "archive")).resolves.toMatchObject({ destination: "Archive" });

    const afterMove = generatedRows(db)[0]!;
    expectColumnsMatchExpressions([afterMove]);
    expect(afterMove.pending_move_state).toBe("confirmed");
    // The row is still physically in INBOX but already belongs to Archive.
    expect(afterMove.mailbox).toBe("INBOX");
    expect(afterMove.effective_mailbox).toBe("Archive");
  });

  it("files the row in the destination on a UIDPLUS-confirmed move", async () => {
    // applyMoveConfirmedUidPlus: `mailbox = ?` and the old scheme's
    // `effective_mailbox = ?` were the same bound path repeated, precisely
    // because a SET expression cannot see the new mailbox.
    setFolders([{ path: "Archive", specialUse: "\\Archive" }]);
    insertMessage(db, { id: "moved", mailbox: "INBOX", sentAt: "2026-05-01T10:00:00.000Z", createdAt: "2026-05-01T10:00:00.000Z" });
    client.messageMove.mockResolvedValue({ path: "INBOX", destination: "Archive", uidMap: new Map([[uidSequence, 77]]) });

    await expect(moveMessage(db, masterKey, "moved", "archive")).resolves.toMatchObject({ destination: "Archive" });

    const row = generatedRows(db)[0]!;
    expectColumnsMatchExpressions([row]);
    expect(row.mailbox).toBe("Archive");
    expect(row.effective_mailbox).toBe("Archive");
  });

  it("falls back to the source folder when a refused move drops the intent", async () => {
    // The clearIntent statements bound effective_mailbox = mailbox. With the
    // pending-move columns all NULL the expression returns that same mailbox.
    setFolders([{ path: "Archive", specialUse: "\\Archive" }]);
    insertMessage(db, { id: "stuck", mailbox: "INBOX", sentAt: "2026-05-01T10:00:00.000Z", createdAt: "2026-05-01T10:00:00.000Z" });
    client.messageMove.mockResolvedValue(false);

    await expect(moveMessage(db, masterKey, "stuck", "archive")).rejects.toThrow();

    const row = generatedRows(db)[0]!;
    expectColumnsMatchExpressions([row]);
    expect(row.pending_move_state).toBeNull();
    expect(row.pending_move_destination).toBeNull();
    expect(row.effective_mailbox).toBe("INBOX");
  });

  it("falls back to the source folder when a stale intent is proven never to have moved", async () => {
    // recoverStaleMoveIntent: the source UID is still present, so the MOVE
    // never executed and the intent is discarded before a fresh attempt. The
    // retry then fails, so the row is observed in the cleared state the old
    // scheme bound `effective_mailbox = mailbox` for.
    setFolders([{ path: "Archive", specialUse: "\\Archive" }]);
    insertMessage(db, {
      id: "stale", mailbox: "INBOX", sentAt: "2026-05-01T10:00:00.000Z", createdAt: "2026-05-01T10:00:00.000Z",
      pendingMoveDestination: "Archive", pendingMoveState: "intent",
    });
    const staleUid = uidSequence;
    // fetch proves the source UID live, so recovery clears the intent; the
    // retried MOVE is then refused by the provider.
    client.messageMove.mockResolvedValue(false);
    Object.assign(client, { fetch: fakeFetch(staleUid, "2026-05-01T10:00:00.000Z", null) });

    await expect(moveMessage(db, masterKey, "stale", "archive")).rejects.toThrow();
    // Reaching the provider at all proves recovery ran: without it the fresh
    // intent claim would fail on the still-set pending_move_destination.
    expect(client.messageMove).toHaveBeenCalled();

    const row = generatedRows(db)[0]!;
    expectColumnsMatchExpressions([row]);
    expect(row.pending_move_state).toBeNull();
    expect(row.pending_move_destination).toBeNull();
    expect(row.effective_mailbox).toBe("INBOX");
  });

  it("sync reconciliation moves a confirmed row's mailbox and key together", async () => {
    // End to end: sync the message in, move it without UIDPLUS (row stays in
    // INBOX but already reads as Archive), then let the destination sync find
    // it and reconcile the row into Archive for real. reconcilePendingMove is
    // the write point whose old form bound the destination twice.
    setFolders([{ path: "Archive", specialUse: "\\Archive" }]);
    Object.assign(client, {
      mailbox: { exists: 3, uidValidity: 1n },
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch: fakeFetch(3, "2026-05-01T10:00:00.000Z", Buffer.from("Subject: Re\r\n\r\nBody"), "reconcile-me"),
    });
    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ synced: 1 });
    const synced = generatedRows(db)[0]!;
    // The first pass listed INBOX only, and the folder-removal pass drops any
    // cached folder the provider did not list, so restore Archive before moving.
    setFolders([{ path: "Archive", specialUse: "\\Archive" }]);
    client.messageMove.mockResolvedValue({ path: "INBOX", destination: "Archive" });
    await expect(moveMessage(db, masterKey, synced.id, "archive")).resolves.toMatchObject({ destination: "Archive" });

    Object.assign(client, {
      mailbox: { exists: 55, uidValidity: 1n },
      list: vi.fn(async () => [archive]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch: fakeFetch(55, "2026-05-01T10:00:00.000Z", null, "reconcile-me"),
    });
    await syncAccount(db, masterKey, "account-1", 20);

    const row = generatedRows(db)[0]!;
    expect(row).toBeTruthy();
    expectColumnsMatchExpressions([row]);
    expect(row.mailbox).toBe("Archive");
    expect(row.effective_mailbox).toBe("Archive");
    expect(row.pending_move_destination).toBeNull();
  });

  it("gives an appended draft its own sort key and folder", async () => {
    setFolders([{ path: "Drafts", specialUse: "\\Drafts" }]);
    client.append = vi.fn(async () => ({ destination: "Drafts", uid: 4242 }));
    const account = accountById(db, "account-1")!;

    const saved = await saveDraft(db, masterKey, account, {
      to: ["someone@example.com"],
      subject: "A saved draft",
      text: "Draft body",
    });

    const row = generatedRows(db).find((candidate) => candidate.id === saved.id)!;
    expect(row).toBeTruthy();
    expectColumnsMatchExpressions([row]);
    expect(row.effective_mailbox).toBe("Drafts");
    expect(row.sort_key).toBe(row.sent_at);
  });
});

describe("migration", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function databasePath(label: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nami-mail-sort-keys-${label}-`));
    temporaryDirectories.push(directory);
    return path.join(directory, "mail.db");
  }

  const SEED_ROWS = [
    ["plain", "INBOX", 1, "2026-02-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null, null],
    ["no-sent-at", "INBOX", 2, null, "2026-01-02T00:00:00.000Z", null, null],
    ["intent", "INBOX", 3, "2026-02-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z", "Archive", "intent"],
    ["confirmed", "INBOX", 4, "2026-02-04T00:00:00.000Z", "2026-01-04T00:00:00.000Z", "Archive", "confirmed"],
    ["empty-destination", "Archive", 5, "2026-02-05T00:00:00.000Z", "2026-01-05T00:00:00.000Z", "", "confirmed"],
    ["other-state", "Archive", 6, "2026-02-06T00:00:00.000Z", "2026-01-06T00:00:00.000Z", "Sent", null],
  ] as const;

  function seedMessages(db: DatabaseHandle): void {
    db.exec(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES ('account-1', 'account-1@example.com', 'custom', 'Demo', 'encrypted',
        'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', '2026-01-01T00:00:00.000Z');
    `);
    const insert = db.prepare(`
      INSERT INTO messages (id, account_id, mailbox, uid, sent_at, created_at, pending_move_destination, pending_move_state)
      VALUES (?, 'account-1', ?, ?, ?, ?, ?, ?)
    `);
    for (const row of SEED_ROWS) insert.run(...row);
  }

  /**
   * A database from an older build. `dropPendingMove` also removes the
   * pending_move_* columns, which is the shape that pins the generated columns
   * to being added last: SQLite resolves a generated expression against the
   * table as it stands, so effective_mailbox cannot be added while
   * pending_move_state is missing.
   */
  function seedPreColumnDatabase(file: string, dropPendingMove = false): void {
    const db = openDatabase(file);
    seedMessages(db);
    db.exec(`
      DROP INDEX IF EXISTS idx_messages_account_sort_key;
      DROP INDEX IF EXISTS idx_messages_account_effective_mailbox;
      DROP INDEX IF EXISTS idx_messages_account_mailbox_sort_key;
      DROP INDEX IF EXISTS idx_messages_sort_key_id;
      ALTER TABLE messages DROP COLUMN sort_key;
      ALTER TABLE messages DROP COLUMN effective_mailbox;
      ${dropPendingMove ? `
        DROP INDEX IF EXISTS idx_messages_pending_move_remote_id;
        DROP INDEX IF EXISTS idx_messages_pending_move_candidate;
        ALTER TABLE messages DROP COLUMN pending_move_destination;
        ALTER TABLE messages DROP COLUMN pending_move_state;
        ALTER TABLE messages DROP COLUMN pending_move_candidate_uid;
        ALTER TABLE messages DROP COLUMN pending_move_special_use;
      ` : ""}
    `);
    db.close();
  }

  /** A database from the unreleased build that stored both columns by hand. */
  function seedStoredColumnDatabase(file: string): void {
    const db = openDatabase(file);
    seedMessages(db);
    db.exec(`
      DROP INDEX IF EXISTS idx_messages_account_sort_key;
      DROP INDEX IF EXISTS idx_messages_account_effective_mailbox;
      DROP INDEX IF EXISTS idx_messages_account_mailbox_sort_key;
      DROP INDEX IF EXISTS idx_messages_sort_key_id;
      ALTER TABLE messages DROP COLUMN sort_key;
      ALTER TABLE messages DROP COLUMN effective_mailbox;
      ALTER TABLE messages ADD COLUMN sort_key TEXT;
      ALTER TABLE messages ADD COLUMN effective_mailbox TEXT;
      UPDATE messages SET sort_key = ${SORT_KEY_SQL}, effective_mailbox = ${EFFECTIVE_MAILBOX_SQL};
    `);
    db.close();
  }

  it("gives a fresh database both generated columns and their indexes, and no marker", () => {
    const db = openDatabase(databasePath("fresh"));
    try {
      // PRAGMA table_info hides generated columns, so the assertion that matters
      // reads table_xinfo and checks the hidden flag: 2 = VIRTUAL generated.
      const columns = db.prepare("PRAGMA table_xinfo(messages)").all() as Array<{ name: string; hidden: number }>;
      expect(columns.find((column) => column.name === "sort_key")?.hidden).toBe(2);
      expect(columns.find((column) => column.name === "effective_mailbox")?.hidden).toBe(2);
      const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all() as Array<{ name: string }>).map((row) => row.name);
      expect(indexes).toContain("idx_messages_account_sort_key");
      expect(indexes).toContain("idx_messages_account_effective_mailbox");
      // The backup's keyset cursor walks the whole table in this order, so the
      // supporting index is part of the same migration.
      expect(indexes).toContain("idx_messages_account_mailbox_sort_key");
      // The stored-column scheme needed a startup backfill and a marker row to
      // keep it from repeating. Neither exists for a generated column.
      expect(db.prepare("SELECT 1 FROM data_migrations WHERE id = 'messages_sort_columns_v1'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("adds the columns to a pre-column database and needs no backfill to be correct", () => {
    const file = databasePath("pre-column");
    seedPreColumnDatabase(file);

    const migrated = openDatabase(file);
    try {
      // Read straight after opening: a stored-column migration would still be
      // mid-backfill here, or would need the UPDATE this build does not run.
      const rows = generatedRows(migrated);
      expect(rows).toHaveLength(6);
      expectColumnsMatchExpressions(rows);
      expect(rows.find((row) => row.id === "no-sent-at")!.sort_key).toBe("2026-01-02T00:00:00.000Z");
      expect(rows.find((row) => row.id === "intent")!.effective_mailbox).toBe("INBOX");
      expect(rows.find((row) => row.id === "confirmed")!.effective_mailbox).toBe("Archive");
      expect(rows.find((row) => row.id === "empty-destination")!.effective_mailbox).toBe("Archive");
    } finally {
      migrated.close();
    }
  });

  it("adds the columns to a database that predates the pending_move_* columns", () => {
    // Adding effective_mailbox here fails with "no such column:
    // pending_move_state" unless the generated columns are added after the
    // columns their expression reads. The seeded rows carry no pending-move
    // data on this shape, so every row simply reads as its own folder.
    const file = databasePath("oldest");
    seedPreColumnDatabase(file, true);

    const migrated = openDatabase(file);
    try {
      const rows = generatedRows(migrated);
      expect(rows).toHaveLength(6);
      expectColumnsMatchExpressions(rows);
      expect(rows.every((row) => row.effective_mailbox === row.mailbox)).toBe(true);
      expect(rows.find((row) => row.id === "no-sent-at")!.sort_key).toBe("2026-01-02T00:00:00.000Z");
    } finally {
      migrated.close();
    }
  });

  it("is idempotent: a second open changes nothing and adds no marker", () => {
    const file = databasePath("idempotent");
    seedPreColumnDatabase(file);
    const first = openDatabase(file);
    const before = generatedRows(first);
    first.prepare("UPDATE messages SET snippet = 'touched' WHERE id = 'plain'").run();
    first.close();

    const second = openDatabase(file);
    try {
      const after = generatedRows(second);
      expectColumnsMatchExpressions(after);
      expect(after).toEqual(before.map((row) => ({ ...row })));
      expect(second.prepare("SELECT snippet FROM messages WHERE id = 'plain'").pluck().get()).toBe("touched");
      expect(second.prepare("SELECT 1 FROM data_migrations WHERE id = 'messages_sort_columns_v1'").get()).toBeUndefined();
    } finally {
      second.close();
    }
  });

  it("refuses a database left by the unreleased stored-column build", () => {
    // Nothing converts a stored column into a generated one in place: SQLite
    // rejects the duplicate name, and a rebuild costs a full table rewrite.
    // That build never shipped, so the file is unrecoverable by design and the
    // error says so instead of silently reading stale values.
    const file = databasePath("stored-column");
    seedStoredColumnDatabase(file);

    expect(() => openDatabase(file)).toThrow(/is a stored column left by an unreleased build/);
  });
});

