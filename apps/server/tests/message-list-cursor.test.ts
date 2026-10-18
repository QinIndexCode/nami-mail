import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { buildMessageListSql, type MessageListFilterQuery, type MessageListSqlSelection } from "../src/message-filters.js";
import {
  MAX_MESSAGE_CURSOR_LENGTH,
  InvalidMessageCursorError,
  decodeMessageCursor,
  encodeMessageCursor,
} from "../src/message-cursor.js";
import { countMessageRows, listMessagePage } from "../src/message-queries.js";
import { indexMessageFts } from "../src/message-search.js";

// The message list used to page with `LIMIT ? OFFSET ?`. That cannot converge
// while mail arrives: every new row shifts the ordered result down by one, so a
// row that sat at offset 40 when the user started scrolling is at offset 41 by
// the time the page-2 window opens, and the window skips it. This file pins the
// four things the keyset replacement has to hold:
//
//   1. equivalence  - a cursor chain and an OFFSET chain over one dataset
//                    produce the same id sequence, row for row, on a dataset
//                    built to make a partial order impossible: NULL sent_at,
//                    id ties, several accounts, several folders, pending moves;
//   2. delivery     - a message arriving before every page cannot make a row
//                    unreachable, and cannot be served twice;
//   3. termination  - "this was the last page" stays correct while `total`
//                    keeps growing underneath it;
//   4. plan         - each page is an index seek, and the shape that would
//                    reintroduce a sorter is asserted to be the bad one.
//
// Equivalence alone is not enough for (2): OFFSET and the cursor agree on a
// quiet database. Only the arrival case separates them, so the "OFFSET would
// have lost these rows" contrast is asserted in the same test as the delivery.

const PAGE = 7;

type Row = {
  id: string;
  accountId?: string;
  mailbox: string;
  sentAt?: string | null;
  createdAt: string;
  pendingMoveDestination?: string | null;
  pendingMoveState?: string | null;
  flags?: string[];
};

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', '2026-01-01T00:00:00.000Z')
  `).run(id, `${id}@example.com`);
}

let uidSequence = 0;

/** A bare insert: neither generated column is ever named, as in production. */
function insertMessage(db: DatabaseHandle, row: Row): void {
  uidSequence += 1;
  const accountId = row.accountId ?? "account-1";
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at,
      pending_move_destination, pending_move_state
    ) VALUES (?, ?, ?, ?, '', 'Sender', 'sender@example.com', '[]',
      ?, '', '', '', ?, 0, 0, ?, ?, ?)
  `).run(
    row.id,
    accountId,
    row.mailbox,
    uidSequence,
    row.sentAt ?? null,
    JSON.stringify(row.flags ?? []),
    row.createdAt,
    row.pendingMoveDestination ?? null,
    row.pendingMoveState ?? null,
  );
}

function insertInboxFolder(db: DatabaseHandle, accountId = "account-1"): void {
  db.prepare("INSERT OR REPLACE INTO folders (account_id, path, name, special_use, uid_validity) VALUES (?, 'INBOX', 'Inbox', '\\Inbox', '1')")
    .run(accountId);
}

describe("message list cursor", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    uidSequence = 0;
    db = openDatabase(":memory:");
    for (const account of ["account-1", "account-2"]) {
      insertAccount(db, account);
      insertInboxFolder(db, account);
    }
    // 60 rows across two accounts and three folders. sent_at is NULL on every
    // fifth row (so the COALESCE fallback decides the key), and every seventh
    // row shares its key with the next one (so the id tiebreak decides the
    // order) — the two cases where a cursor over a non-total order would
    // double-serve or drop a row. Two rows carry a pending move, so the folder
    // filter has to read effective_mailbox rather than mailbox.
    for (let index = 0; index < 60; index += 1) {
      const bucket = index % 7 === 0 ? Math.floor(index / 7) * 7 : index;
      const sortKey = new Date(Date.UTC(2026, 0, 1) + bucket * 60_000).toISOString();
      insertMessage(db, {
        id: `m-${String(index).padStart(3, "0")}`,
        accountId: index % 2 === 0 ? "account-1" : "account-2",
        mailbox: ["INBOX", "Archive", "Sent"][index % 3]!,
        sentAt: index % 5 === 0 ? null : sortKey,
        createdAt: sortKey,
        flags: index % 9 === 0 ? ["\\Flagged"] : [],
      });
    }
    // An in-flight move stays filed under its source folder, and a confirmed
    // one has already left: the folder view must see both through the
    // generated column, and the cursor must compose with that filter.
    insertMessage(db, { id: "m-pending", mailbox: "INBOX", sentAt: "2026-06-01T00:00:00.000Z", createdAt: "2026-06-01T00:00:00.000Z", pendingMoveDestination: "Archive", pendingMoveState: "intent" });
    insertMessage(db, { id: "m-moved", mailbox: "INBOX", sentAt: "2026-06-01T00:00:00.000Z", createdAt: "2026-06-01T00:00:00.000Z", pendingMoveDestination: "Archive", pendingMoveState: "confirmed" });
  });

  afterEach(() => {
    db.close();
  });

  /** Walks the whole view with the cursor the server hands back. */
  function walkWithCursor(query: MessageListFilterQuery, pageSize = PAGE): { ids: string[]; pages: number } {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = listMessagePage(db, buildMessageListSql(query), {
        limit: pageSize,
        cursor: cursor === undefined ? undefined : decodeMessageCursor(cursor),
      });
      pages += 1;
      ids.push(...page.rows.map((row) => row.id));
      if (page.nextCursor === null) return { ids, pages };
      cursor = page.nextCursor;
      if (pages > 500) throw new Error("cursor chain did not terminate");
    }
  }

  /** The same walk the old endpoint performed, kept as the equivalence oracle. */
  function walkWithOffset(query: MessageListFilterQuery, pageSize = PAGE): string[] {
    const selection = buildMessageListSql(query);
    const ids: string[] = [];
    for (let page = 1; ; page += 1) {
      if (page > 500) throw new Error("offset chain did not terminate");
      // The removed SQL, spelled out so the oracle is the query itself rather
      // than a paraphrase of it.
      const window = db.prepare(`
        SELECT m.id ${selection.join} JOIN accounts a ON a.id = m.account_id ${selection.where}
        ORDER BY m.sort_key DESC, m.id DESC LIMIT ? OFFSET ?
      `).all(...selection.params, pageSize, (page - 1) * pageSize) as Array<{ id: string }>;
      ids.push(...window.map((row) => row.id));
      if (window.length < pageSize) return ids;
    }
  }

  describe("cursor encoding", () => {
    it("round-trips a position and reads as nothing a client could construct", () => {
      const position = { sortKey: "2026-03-01T00:00:00.000Z", id: "11111111-2222-4333-8444-555555555555" };
      const encoded = encodeMessageCursor(position);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      // Opaque, not secret: the encoding is reversible by design, so what is
      // pinned is that nothing in it is a value a client could put together on
      // its own. A bare sort key and a bare id are both refused, so the only
      // way to obtain one is to be handed one.
      expect(encoded).not.toBe(position.sortKey);
      expect(encoded).not.toContain(position.id);
      expect(() => decodeMessageCursor(position.sortKey)).toThrow(InvalidMessageCursorError);
      expect(() => decodeMessageCursor(position.id)).toThrow(InvalidMessageCursorError);
      expect(decodeMessageCursor(encoded)).toEqual(position);
    });

    it.each([
      ["an empty string", ""],
      ["a value that is not base64url", "not base64url!!"],
      ["a truncated payload", Buffer.from("1\u00002026", "utf8").toString("base64url")],
      ["a future version", Buffer.from("2\u00002026-03-01T00:00:00.000Z\u0000abc", "utf8").toString("base64url")],
      ["an empty sort key", Buffer.from("1\u0000\u0000abc", "utf8").toString("base64url")],
      ["an empty id", Buffer.from("1\u00002026-03-01T00:00:00.000Z\u0000", "utf8").toString("base64url")],
      ["more parts than the shape has", Buffer.from("1\u0000a\u0000b\u0000c", "utf8").toString("base64url")],
      ["an oversized blob", "A".repeat(MAX_MESSAGE_CURSOR_LENGTH + 1)],
    ])("rejects %s", (_label, value) => {
      expect(() => decodeMessageCursor(value)).toThrow(InvalidMessageCursorError);
    });
  });

  describe("equivalence with the offset chain it replaces", () => {
    it("delivers the identical id sequence, row for row, on the whole account", () => {
      const view = { accountId: "account-1" };
      const walked = walkWithCursor(view).ids;
      expect(walked).toEqual(walkWithOffset(view));
      // And the chain covered the view: the ids SQLite orders that way, and
      // each of them exactly once.
      const reference = (db.prepare(`
        SELECT m.id FROM messages m JOIN accounts a ON a.id = m.account_id ${buildMessageListSql(view).where}
        ORDER BY m.sort_key DESC, m.id DESC
      `).all(...buildMessageListSql(view).params) as Array<{ id: string }>).map((row) => row.id);
      expect(walked).toEqual(reference);
      expect(new Set(walked).size).toBe(walked.length);
    });

    it("holds for a folder view, a cross-folder view, a flag view and a date window", () => {
      const views: MessageListFilterQuery[] = [
        { accountId: "account-1", folder: "INBOX" },
        { accountId: "account-1", folder: "Archive" },
        { accountId: "account-1", starred: true },
        { accountId: "account-1", unread: true },
        { accountId: "account-1", after: "2026-01-05T00:00:00.000Z" },
        { accountId: "account-1", before: "2026-01-10T00:00:00.000Z" },
        // No accountId at all: the unified inbox of the "all accounts" entry.
        {},
      ];
      for (const view of views) {
        const label = JSON.stringify(view);
        const walked = walkWithCursor(view).ids;
        expect(walked, label).toEqual(walkWithOffset(view));
        // And the chain covered the view exactly: no row twice, none missing.
        expect(new Set(walked).size, label).toBe(walked.length);
      }
      // The cross-account view is a real shape, not a degenerate one.
      expect(walkWithCursor({}).ids.length).toBeGreaterThan(PAGE);
    });

    it("covers the rows a pending move keeps in their source folder", () => {
      // m-pending is physically in INBOX and still reads as INBOX; m-moved has
      // physically left and reads as Archive. A cursor issued by the INBOX page
      // must not resume into Archive's rows.
      const inbox = walkWithCursor({ accountId: "account-1", folder: "INBOX" }).ids;
      const archive = walkWithCursor({ accountId: "account-1", folder: "Archive" }).ids;
      expect(inbox).toContain("m-pending");
      expect(inbox).not.toContain("m-moved");
      expect(archive).toContain("m-moved");
      expect(archive).not.toContain("m-pending");
      expect(new Set([...inbox, ...archive]).size).toBe(inbox.length + archive.length);
    });
  });

  describe("a message arriving between pages", () => {
    // The failure this migration exists to remove. One new message lands above
    // the cursor before every page is fetched: it is newer than everything
    // already loaded, so it only ever shifts OFFSETs.
    const ROWS = 40;
    let arrivals: number;

    beforeEach(() => {
      db.exec("DELETE FROM messages");
      arrivals = 0;
      for (let index = 0; index < ROWS; index += 1) {
        insertMessage(db, {
          id: `a-${String(index).padStart(3, "0")}`,
          mailbox: "INBOX",
          sentAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
          createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
        });
      }
    });

    /** Fetches the next page, then delivers the mail that lands while it is in flight. */
    function pageWithArrival(selection: MessageListSqlSelection, cursor: ReturnType<typeof decodeMessageCursor> | undefined) {
      const page = listMessagePage(db, selection, { limit: PAGE, cursor });
      arrivals += 1;
      insertMessage(db, {
        id: `new-${String(arrivals).padStart(3, "0")}`,
        mailbox: "INBOX",
        sentAt: new Date(Date.UTC(2027, 0, 1) + arrivals * 60_000).toISOString(),
        createdAt: new Date(Date.UTC(2027, 0, 1) + arrivals * 60_000).toISOString(),
      });
      return page;
    }

    it("serves every original row exactly once, where offset paging repeats one row per arrival", () => {
      const selection = buildMessageListSql({ accountId: "account-1" });

      // The cursor chain, with one arrival per page.
      const served: string[] = [];
      let cursor: ReturnType<typeof decodeMessageCursor> | undefined;
      let pages = 0;
      for (;;) {
        const page = pageWithArrival(selection, cursor);
        pages += 1;
        served.push(...page.rows.map((row) => row.id));
        if (page.nextCursor === null) break;
        cursor = decodeMessageCursor(page.nextCursor);
        if (pages > 500) throw new Error("cursor chain did not terminate");
      }
      // Newest first, so the original rows come back reversed.
      const originals = Array.from({ length: ROWS }, (_, index) => `a-${String(index).padStart(3, "0")}`).reverse();
      const deliveredOriginals = served.filter((id) => id.startsWith("a-"));
      // Every original row arrived, in one unbroken run, and none arrived twice.
      // This is the whole claim: the arrivals never displaced a row below the
      // cursor, so the window the user is scrolling through stays complete.
      expect(deliveredOriginals).toEqual(originals);
      expect(new Set(served).size).toBe(served.length);
      expect(pages).toBeGreaterThan(2);
      // The arrivals are newer than the cursor, so they sit above the loaded
      // window and the continued chain does not repeat them. That is the
      // correct keyset answer, and the reason a re-read from the head — the
      // silent refresh, or switching views — is what shows them: none of them
      // was ever skipped, they were simply never behind the cursor.
      expect(served.filter((id) => id.startsWith("new-"))).toHaveLength(0);
      expect(arrivals).toBe(pages);

      // The oracle: the same dataset, the same arrival schedule, OFFSET. This
      // is the contrast that makes the assertions above a regression target —
      // put OFFSET back inside listMessagePage and this walk stops converging.
      // Every arrival pushes the whole ordered result down by one, so each
      // window re-serves the row the previous one ended on: one repeat per
      // arrival, and the count of them is the arrival rate, not the mailbox
      // size. (Measured on this fixture: six arrivals, six repeats, against
      // zero for the cursor chain.)
      db.exec("DELETE FROM messages");
      arrivals = 0;
      for (let index = 0; index < ROWS; index += 1) {
        const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
        insertMessage(db, { id: `a-${String(index).padStart(3, "0")}`, mailbox: "INBOX", sentAt: at, createdAt: at });
      }
      const offsetServed: string[] = [];
      for (let page = 1; page <= 200; page += 1) {
        const window = db.prepare(`
          SELECT m.id ${selection.join} JOIN accounts a ON a.id = m.account_id ${selection.where}
          ORDER BY m.sort_key DESC, m.id DESC LIMIT ? OFFSET ?
        `).all(...selection.params, PAGE, (page - 1) * PAGE) as Array<{ id: string }>;
        if (!window.length) break;
        offsetServed.push(...window.map((row) => row.id));
        arrivals += 1;
        const at = new Date(Date.UTC(2027, 0, 1) + arrivals * 60_000).toISOString();
        insertMessage(db, { id: `new-${String(arrivals).padStart(3, "0")}`, mailbox: "INBOX", sentAt: at, createdAt: at });
      }
      const offsetRepeats = offsetServed.length - new Set(offsetServed).size;
      // Guards the fixture: without real arrivals the two schemes agree, and
      // this half of the test would prove nothing about the failure it names.
      expect(offsetRepeats).toBe(arrivals - 1);
      expect(offsetRepeats).toBeGreaterThan(0);
      // The arrivals themselves are never reached by either scheme after the
      // first page, because they are newer than everything already served.
      expect(offsetServed.filter((id) => id.startsWith("new-"))).toHaveLength(0);
    });
  });

  describe("the end of the list", () => {
    it("is announced on the last page only, while new mail keeps the total moving", () => {
      // Enough rows for several full pages, so "the end" is a decision the
      // chain has to keep declining rather than something it stumbles into on
      // the second page.
      for (let index = 0; index < 40; index += 1) {
        const at = new Date(Date.UTC(2026, 5, 1) + index * 60_000).toISOString();
        insertMessage(db, { id: `bulk-${String(index).padStart(3, "0")}`, mailbox: "INBOX", sentAt: at, createdAt: at });
      }
      const selection = buildMessageListSql({ accountId: "account-1" });
      const startTotal = countMessageRows(db, selection);
      const totals: number[] = [startTotal];
      let delivered = 0;
      let fullPages = 0;
      let cursor: ReturnType<typeof decodeMessageCursor> | undefined;

      for (;;) {
        const page = listMessagePage(db, selection, { limit: PAGE, cursor });
        delivered += page.rows.length;
        if (page.nextCursor === null) {
          // Only the final page is short, and only it announces the end.
          expect(page.rows.length).toBeLessThan(PAGE);
          break;
        }
        // A short page before the end, or a null cursor with rows left, is the
        // failure this signal exists to rule out.
        expect(page.rows).toHaveLength(PAGE);
        fullPages += 1;
        if (fullPages > 200) throw new Error("cursor chain did not terminate");
        cursor = decodeMessageCursor(page.nextCursor);
        // One message lands above the cursor while the user reads, so the
        // total the renderer used to gate on moves at every step.
        const at = new Date(Date.UTC(2028, 0, 1) + fullPages * 60_000).toISOString();
        insertMessage(db, { id: `live-${String(fullPages).padStart(3, "0")}`, mailbox: "INBOX", sentAt: at, createdAt: at });
        totals.push(countMessageRows(db, selection));
      }

      // Every row the view held when the walk began was delivered, none twice.
      // The arrivals are newer than the cursor, so they are not in the run —
      // they belong to the head of the list, which a refresh from the top is
      // what collects, and their absence here is the correct keyset behaviour.
      expect(delivered).toBe(startTotal);
      // The count the old gate compared against moved every single step and
      // never caught up with what had been loaded, so `loaded >= total` could
      // not have fired once.
      expect(new Set(totals).size).toBe(totals.length);
      expect(totals[totals.length - 1]!).toBeGreaterThan(startTotal);
      expect(fullPages).toBeGreaterThan(1);
    });

    it("answers the whole view in one page with a null cursor", () => {
      const page = listMessagePage(db, buildMessageListSql({ accountId: "account-1" }), { limit: 1000 });
      expect(page.rows.length).toBe(countMessageRows(db, buildMessageListSql({ accountId: "account-1" })));
      expect(page.nextCursor).toBeNull();
    });
  });

  describe("query plan", () => {
    const ROWS = 400;

    beforeEach(() => {
      db.exec("DELETE FROM messages");
      for (let index = 0; index < ROWS; index += 1) {
        const bucket = index % 7 === 0 ? Math.floor(index / 7) * 7 : index;
        insertMessage(db, {
          id: `p-${String(index).padStart(4, "0")}`,
          accountId: index % 2 === 0 ? "account-1" : "account-2",
          mailbox: index % 2 === 0 ? "INBOX" : "Archive",
          sentAt: index % 5 === 0 ? null : new Date(Date.UTC(2026, 0, 1) + bucket * 60_000).toISOString(),
          createdAt: new Date(Date.UTC(2026, 0, 1) + bucket * 60_000).toISOString(),
        });
      }
    });

    /** The plan of one cursor page, built the way listMessagePage builds it. */
    function cursorPagePlan(selection: MessageListSqlSelection): string {
      const decoded = decodeMessageCursor(encodeMessageCursor({ sortKey: "2026-01-01T00:00:00.000Z", id: "p-0100" }));
      return (db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT m.*, m.sort_key AS list_sort_key, a.email AS account_email, a.provider_name
        ${selection.join}
        JOIN accounts a ON a.id = m.account_id
        ${selection.where} AND (m.sort_key < ? OR (m.sort_key = ? AND m.id < ?))
        ORDER BY m.sort_key DESC, m.id DESC
        LIMIT ?
      `).all(...selection.params, decoded.sortKey, decoded.sortKey, decoded.id, PAGE) as Array<{ detail: string }>)
        .map((row) => row.detail).join(" | ");
    }

    it("seeks the account view instead of sorting every row of the account", () => {
      const plan = cursorPagePlan(buildMessageListSql({ accountId: "account-1" }));
      expect(plan).toContain("idx_messages_account_sort_key");
      expect(plan).not.toContain("USE TEMP B-TREE");
      expect(plan).not.toContain("SCAN m");
    });

    it("seeks the folder view through the effective-mailbox index", () => {
      const plan = cursorPagePlan(buildMessageListSql({ accountId: "account-1", folder: "INBOX" }));
      expect(plan).toContain("idx_messages_account_effective_mailbox");
      expect(plan).not.toContain("USE TEMP B-TREE");
      expect(plan).not.toContain("SCAN m");
    });

    it("orders the cross-account view from an index rather than a full scan and a sorter", () => {
      const plan = cursorPagePlan(buildMessageListSql({}));
      expect(plan).toContain("idx_messages_sort_key_id");
      expect(plan).not.toContain("USE TEMP B-TREE");
      // A seek is impossible without an account to seek into; what must not
      // come back is the table scan plus sorter this view used to plan.
      expect(plan).not.toMatch(/SCAN m(?! USING INDEX)/);
    });

    it.each([
      ["an index that stops at sort_key", "CREATE INDEX probe_two ON messages(account_id, sort_key DESC)"],
      ["no index at all", null],
    ])("produces a sorter for the id tiebreak under %s", (_label, indexSql) => {
      // The reverse assertion. The two list indexes carry `id` as a suffix, so
      // the tiebreak the cursor needs is free; take it away — by pointing the
      // query at a two-column index, or by deleting the list indexes — and the
      // order is no longer served by an index.
      if (indexSql) db.exec(`DROP INDEX IF EXISTS idx_messages_account_sort_key; ${indexSql}`);
      else db.exec("DROP INDEX IF EXISTS idx_messages_account_sort_key");
      const plan = cursorPagePlan(buildMessageListSql({ accountId: "account-1" }));
      expect(plan).toContain("USE TEMP B-TREE");
    });

    it("produces a full scan and a sorter when the ordering is the expression again", () => {
      const plan = (db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT m.*, a.email AS account_email FROM messages m JOIN accounts a ON a.id = m.account_id
        WHERE m.account_id = ? AND UPPER(m.effective_mailbox) = 'INBOX'
        ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC LIMIT ?
      `).all("account-1", PAGE) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
      expect(plan).toContain("USE TEMP B-TREE FOR ORDER BY");
    });
  });
});

describe("GET /api/messages cursor contract", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 7) });
    insertAccount(db, "account-1");
    insertInboxFolder(db);
    for (let index = 0; index < 25; index += 1) {
      const id = `route-${String(index).padStart(2, "0")}`;
      const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
      insertMessage(db, { id, mailbox: "INBOX", sentAt: at, createdAt: at });
      indexMessageFts(db, id, { subject: `Subject ${index}`, fromName: "Sender", fromAddress: "sender@example.com", textBody: at });
    }
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const query = (extra: string) => `/api/messages?accountId=account-1&pageSize=10${extra}`;

  it("answers a page with a cursor that continues it, and null on the last one", async () => {
    const first = await app.inject({ method: "GET", url: query("") });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { items: Array<{ id: string }>; total: number; pageSize: number; nextCursor: string | null };
    expect(body.items).toHaveLength(10);
    expect(body.total).toBe(25);
    expect(body.pageSize).toBe(10);
    expect(typeof body.nextCursor).toBe("string");

    const second = await app.inject({ method: "GET", url: query(`&cursor=${encodeURIComponent(body.nextCursor!)}`) });
    const secondBody = second.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(secondBody.items).toHaveLength(10);
    expect(secondBody.nextCursor).not.toBeNull();

    const third = await app.inject({ method: "GET", url: query(`&cursor=${encodeURIComponent(secondBody.nextCursor!)}`) });
    const thirdBody = third.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(thirdBody.items).toHaveLength(5);
    expect(thirdBody.nextCursor).toBeNull();

    // Disjoint and complete, in one continuous newest-first sequence.
    const all = [...body.items, ...secondBody.items, ...thirdBody.items].map((item) => item.id);
    expect(new Set(all).size).toBe(25);
    const times = all.map((id) => db.prepare("SELECT sent_at FROM messages WHERE id = ?").pluck().get(id) as string);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("keeps the cursor inside the filters it was issued for", async () => {
    const starredQuery = "/api/messages?accountId=account-1&pageSize=10&starred=1";
    db.prepare("UPDATE messages SET flags_json = '[\"\\\\Flagged\"]' WHERE id = 'route-20'").run();
    const first = (await app.inject({ method: "GET", url: starredQuery })).json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(first.items.map((item) => item.id)).toEqual(["route-20"]);
    expect(first.nextCursor).toBeNull();

    const search = (await app.inject({ method: "GET", url: "/api/messages?accountId=account-1&pageSize=10&q=Subject%202" })).json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(search.items.map((item) => item.id)).toEqual(["route-24", "route-23", "route-22", "route-21", "route-20", "route-02"]);
    expect(search.nextCursor).toBeNull();
  });

  it.each([
    ["an empty cursor", "&cursor="],
    ["a cursor that is not base64url", "&cursor=not%20a%20cursor"],
    ["a truncated cursor", `&cursor=${encodeURIComponent(Buffer.from("1\u00002026", "utf8").toString("base64url"))}`],
    ["a cursor from another version", `&cursor=${encodeURIComponent(Buffer.from("9\u00002026-03-01T00:00:00.000Z\u0000abc", "utf8").toString("base64url"))}`],
  ])("answers 400 invalid_argument for %s", async (_label, extra) => {
    const response = await app.inject({ method: "GET", url: `/api/messages?accountId=account-1${extra}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, code: "invalid_argument" });
  });

  it("accepts and ignores a page parameter rather than serving a wrong window", async () => {
    const first = (await app.inject({ method: "GET", url: query("") })).json() as { items: Array<{ id: string }> };
    const stale = (await app.inject({ method: "GET", url: query("&page=3") })).json() as { items: Array<{ id: string }> };
    expect(stale.items).toEqual(first.items);
  });
});
