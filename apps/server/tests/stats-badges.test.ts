import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { UNSEEN_PREDICATE_SQL } from "../src/message-flag-indexes.js";

// The sidebar badges polled every few seconds by GET /api/stats.
//
// The hazard this file exists for is that a count gets its number by a shape the
// planner cannot serve with an index. It used to be one statement with six
// SUM(CASE WHEN ...) arms: SQLite cannot prove a predicate buried inside a CASE
// implies a partial index's WHERE clause, so an index matching the predicate
// *exactly* is silently declined and the endpoint degrades to a full scan of
// messages -- carrying every row's encrypted payload -- while still returning
// correct numbers. Batch 3 replaced that with derived counts, and the shape to
// watch for changed with it: the unified inbox is now TWO steps (resolve the
// inbox paths from `folders`, then one indexed count per path), and the form it
// replaced -- a per-message correlated `EXISTS (SELECT 1 FROM folders ...)` --
// measured 277.52ms unread / 217.60ms total on 51 000 rows (contract §0.2).
//
// So the assertions below come in pairs: the badge *values* (the endpoint must
// not change what it reports) and the badge *plans* (it must keep reaching the
// indexes). A future edit that re-folds a predicate into a CASE, or that goes
// back to looking the folder up per message, passes the first and fails the
// second.

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
      db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
        .run(id, "INBOX", "Inbox", "\\Inbox");
      db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
        .run(id, "Newsletters", "Newsletters", "\\Inbox");
      db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
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
      // The counters start at zero in JS and no statement has to return a row
      // for the answer to exist (`mailboxBadges`), so an empty mailbox is 0 and
      // not NULL. This is the shape that replaced the `FROM messages m` anchor
      // the old SUM-arms comment argued was load-bearing.
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
    // These plan the endpoint's *own* statements rather than a hand-written
    // fragment: re-folding a badge back into SUM(CASE WHEN ...), or going back to
    // a per-message folder lookup, would leave every fragment-level assertion
    // here passing while the endpoint quietly started scanning the table.
    async function statsStatements(): Promise<string[]> {
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
      return seen;
    }

    /**
     * The plan of the one statement carrying `fragment`'s shape.
     *
     * Every placeholder is bound to the same instant the endpoint binds: a snooze
     * comparison planned against NULL is a different query to the planner, so a
     * null-binding helper could report an index for a query that never binds one.
     * The count comes from the statement itself, so an edit that changes its
     * arity fails here rather than planning something the endpoint never runs.
     */
    function planOf(statements: string[], matches: (sql: string) => boolean): string {
      const found = statements.filter(matches);
      expect(found, `${found.length} /api/stats statements matched`).toHaveLength(1);
      const sql = found[0]!;
      const params = Array<string>((sql.match(/\?/g) ?? []).length).fill(now);
      return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((row) => row.detail).join(" | ");
    }

    it("serves the starred, snoozed and attachments badges from their partial indexes", async () => {
      const statements = await statsStatements();
      expect(planOf(statements, (sql) => sql.includes("m.flags_json LIKE"))).toContain("idx_messages_flagged");
      expect(planOf(statements, (sql) => sql.includes("m.snoozed_until >"))).toContain("idx_messages_snoozed_until");
      expect(planOf(statements, (sql) => sql.includes("m.has_attachments = 1"))).toContain("idx_messages_has_attachments");
    });

    it("counts the unified inbox per folder instead of resolving the folder per message", async () => {
      const statements = await statsStatements();
      // The unread half is the partial index built for exactly this query
      // (message-flag-indexes.ts): one top-level WHERE per folder, so the
      // predicate is the index's own and the planner takes it. The total half has
      // no partial index -- `effective_mailbox` is a generated column, so a
      // partial predicate would have to be spelled the same way by hand -- and is
      // served by the plain `(account_id, effective_mailbox, …)` index instead.
      const inboxUnread = planOf(statements, (sql) => sql.includes("effective_mailbox = ?") && sql.includes(UNSEEN_PREDICATE_SQL));
      expect(inboxUnread).toContain("idx_messages_unseen_by_folder");
      const inboxTotal = planOf(statements, (sql) => sql.includes("effective_mailbox = ?") && !sql.includes(UNSEEN_PREDICATE_SQL));
      expect(inboxTotal).toContain("idx_messages_account_effective_mailbox");
      // And the shape that cost 277.52ms / 217.60ms is pinned as absent: no arm
      // folded into a CASE for the planner to decline, and no folder looked up
      // once per message. Both are what "correct but slow" looks like here.
      for (const sql of statements) {
        expect(sql).not.toMatch(/SUM\s*\(/i);
        expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT/i);
      }
    });
  });
});