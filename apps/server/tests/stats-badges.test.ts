import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

// The sidebar badges polled every few seconds by GET /api/stats.
//
// The hazard this file exists for is that the endpoint's six counts used to be
// six SUM(CASE WHEN ...) arms over one table walk. That shape is correct but
// opaque: SQLite cannot prove a predicate buried inside a CASE implies a partial
// index's WHERE clause, so an index that matches the predicate *exactly* is
// silently declined and the endpoint degrades to a full scan of messages —
// carrying every row's encrypted payload — while still returning correct
// numbers. Nothing warns; the sidebar just gets slow, permanently.
//
// So the assertions below come in pairs: the badge *values* (the endpoint must
// not change what it reports) and the badge *plans* (it must keep reaching the
// indexes). A future edit that re-folds a predicate into a CASE passes the first
// and fails the second.

describe("GET /api/stats sidebar badges", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  const now = new Date().toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 7) });
    for (const id of ["account-1", "account-2"]) {
      db.prepare(`
        INSERT INTO accounts (
          id, email, provider, provider_name, encrypted_password,
          imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
          username_mode, status, created_at
        ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', ?)
      `).run(id, `${id}@example.com`, now);
      // "Newsletters" is inbox membership by special_use only, so the unified
      // inbox filter's EXISTS branch is genuinely exercised, not just its
      // UPPER(mailbox) = 'INBOX' half.
      db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
        .run(id, "INBOX", "Inbox", "\\Inbox");
      db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
        .run(id, "Newsletters", "Newsletters", "\\Inbox");
      db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
        .run(id, "Archive", "Archive", "\\Archive");
    }

    // Flags are stored the way sync writes them: a JSON.stringify result, so a
    // "\Seen" flag lands in the column as an escaped two-backslash \Seen.
    const rows: Array<{
      id: string; account: string; mailbox: string; flags: string[];
      hasAttachments: number; snoozedUntil: string | null;
    }> = [
      // Unread inbox message.
      { id: "m-plain", account: "account-1", mailbox: "INBOX", flags: [], hasAttachments: 0, snoozedUntil: null },
      // Read inbox message: counts in `messages`, not in `unread`.
      { id: "m-read", account: "account-1", mailbox: "INBOX", flags: ["\\Seen"], hasAttachments: 0, snoozedUntil: null },
      // Unread + starred: in both badges, and the only starred row.
      { id: "m-starred", account: "account-1", mailbox: "INBOX", flags: ["\\Flagged"], hasAttachments: 1, snoozedUntil: null },
      // Inbox by special_use, not by path. Unread, so it counts.
      { id: "m-newsletter", account: "account-1", mailbox: "Newsletters", flags: [], hasAttachments: 0, snoozedUntil: null },
      // Archived: outside the unified inbox, so in neither messages nor unread,
      // and starred badges are cross-folder so it still counts there.
      { id: "m-archived", account: "account-1", mailbox: "Archive", flags: ["\\Flagged"], hasAttachments: 0, snoozedUntil: null },
      // Snoozed into the future: hidden from the inbox until due.
      { id: "m-snoozed", account: "account-1", mailbox: "INBOX", flags: [], hasAttachments: 0, snoozedUntil: future },
      // Snoozed but already due: released back into the inbox.
      { id: "m-due", account: "account-1", mailbox: "INBOX", flags: [], hasAttachments: 0, snoozedUntil: past },
      // Second account: every badge above spans accounts, so a count that
      // accidentally filtered to one account would show up here.
      { id: "m-other", account: "account-2", mailbox: "INBOX", flags: ["\\Seen"], hasAttachments: 1, snoozedUntil: null },
    ];
    let uid = 0;
    for (const row of rows) {
      uid += 1;
      db.prepare(`
        INSERT INTO messages (
          id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
          sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, snoozed_until, created_at
        ) VALUES (?, ?, ?, ?, ?, 'Demo', 'demo@example.com', '[]', ?, '', '', '', ?, ?, 0, ?, ?)
      `).run(row.id, row.account, row.mailbox, uid, `Subject ${row.id}`, now, JSON.stringify(row.flags), row.hasAttachments, row.snoozedUntil, now);
    }
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("counts every badge the sidebar shows", async () => {
    const response = await app.inject({ method: "GET", url: "/api/stats" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accounts: 2,
      // Inbox rows minus the still-snoozed one: plain, read, starred,
      // newsletter, due, other. m-archived is out (not inbox), m-snoozed is out
      // (not due).
      messages: 6,
      // The inbox rows among those that are not \Seen: plain, starred,
      // newsletter, due. m-read and m-other are seen; m-snoozed is hidden.
      unread: 4,
      // Cross-folder, so it spans both the inbox and the archive.
      starred: 2,
      snoozed: 1,
      attachments: 2,
    });
  });

  it("counts an empty mailbox as all zeroes rather than null", async () => {
    const empty = openDatabase(":memory:");
    const emptyApp = await buildApp({ db: empty, masterKey: Buffer.alloc(32, 9) });
    try {
      const response = await emptyApp.inject({ method: "GET", url: "/api/stats" });
      // SUM() over no rows is NULL; the badges are counts and must be 0. This is
      // the one behaviour a SUM-arm to COUNT(*) rewrite could plausibly change,
      // since the COALESCE guards only protect the arms that stayed SUM.
      expect(response.json()).toEqual({
        accounts: 0, messages: 0, unread: 0, starred: 0, snoozed: 0, attachments: 0,
      });
    } finally {
      await emptyApp.close();
      empty.close();
    }
  });

  it("follows a flag change in both badge directions", async () => {
    // PATCH /api/messages/:id with { seen, flagged }, not a raw flags array, so
    // this exercises the same write path the sidebar's own toggle uses.
    await app.inject({ method: "PATCH", url: "/api/messages/m-plain", payload: { flagged: true } });
    // Starring does not mark as read, so only the starred badge moves.
    const starred = await app.inject({ method: "GET", url: "/api/stats" });
    expect(starred.json()).toMatchObject({ starred: 3, unread: 4 });

    await app.inject({ method: "PATCH", url: "/api/messages/m-plain", payload: { seen: true } });
    const read = await app.inject({ method: "GET", url: "/api/stats" });
    expect(read.json()).toMatchObject({ starred: 3, unread: 3 });
  });

  describe("the badges that a partial index can serve reach it", () => {
    // These plan the endpoint's *own* statement rather than a hand-written
    // fragment: re-folding a badge back into SUM(CASE WHEN ...) would leave
    // every fragment-level assertion here passing while the endpoint quietly
    // went back to scanning the table.
    async function statsPlan(): Promise<string> {
      const seen: string[] = [];
      const bind = db.prepare.bind(db);
      (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        seen.push(sql);
        return bind(sql);
      };
      try {
        await app.inject({ method: "GET", url: "/api/stats" });
      } finally {
        (db as unknown as { prepare: typeof bind }).prepare = bind;
      }
      const sql = seen.find((statement) => statement.includes("AS attachments"));
      expect(sql, "the /api/stats query was never prepared").toBeDefined();
      // Three placeholders, in badge order: messages, unread, snoozed.
      const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql!}`).all(now, now, now) as Array<{ detail: string }>).map((row) => row.detail);
      return detail.join(" | ");
    }

    it("serves the starred, snoozed and attachments badges from their partial indexes", async () => {
      const detail = await statsPlan();
      expect(detail).toContain("idx_messages_flagged");
      expect(detail).toContain("idx_messages_snoozed_until");
      expect(detail).toContain("idx_messages_has_attachments");
    });

    it("walks the table once, and does not trade that for a walk of the unseen index", async () => {
      // `messages` and `unread` both test inbox membership, which reads the
      // effective_mailbox generated column plus a correlated folders lookup, so
      // no index covers them and they share a single pass. Giving `unread` its
      // own COUNT(*) was measured and is *slower*: the unseen index holds ~55%
      // of the mailbox and none of the columns the inbox test reads, so it
      // becomes a full walk of the partial index with a row fetch per entry —
      // 773ms against 528ms on 50 000 rows. Both halves of that are pinned
      // here, because the split looks like an improvement and is not one.
      const detail = await statsPlan();
      expect(detail.split(" | ").filter((line) => line === "SCAN m")).toHaveLength(1);
      expect(detail).not.toContain("idx_messages_unseen");
    });
  });
});