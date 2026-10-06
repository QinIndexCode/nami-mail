import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { buildMessageListSql, type MessageListFilterQuery } from "../src/message-filters.js";
import { FLAGGED_PREDICATE_SQL, UNSEEN_PREDICATE_SQL } from "../src/message-flag-indexes.js";
import { countMessageRows, listMessagePage } from "../src/message-queries.js";

// `flags_json` is a JSON text column and the starred / unread views match it
// with a leading-wildcard LIKE, which no full index over that column can serve.
// The partial indexes in message-flag-indexes.ts are the schema that can.
//
// The hazard this file exists for is silent: a partial index is only usable when
// SQLite can prove the query's predicate implies the index's WHERE clause, and
// an index it declines is exactly as fast as no index at all. So a one-character
// edit to either pattern — one backslash, one space — costs 60ms per list
// request on a 50 000-row mailbox and reports nothing. The assertions below
// therefore pin the *predicate text* rather than trusting that the two files
// still agree, and pin the plan for the shape that provably does use the index.

let uidSequence = 0;

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', '2026-01-01T00:00:00.000Z')
  `).run(id, `${id}@example.com`);
}

function insertMessage(db: DatabaseHandle, id: string, flags: string[]): void {
  uidSequence += 1;
  const at = new Date(Date.UTC(2026, 0, 1) + uidSequence * 60_000).toISOString();
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, 'account-1', 'INBOX', ?, '', 'Sender', 'sender@example.com', '[]',
      ?, '', '', '', ?, 0, 0, ?)
  `).run(id, uidSequence, at, JSON.stringify(flags), at);
}

describe("starred and unread flag indexes", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    uidSequence = 0;
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen, uid_validity) VALUES ('account-1', 'INBOX', 'Inbox', '\\Inbox', 0, 0, '1')").run();
    for (let index = 0; index < 40; index += 1) {
      const flags: string[] = [];
      if (index % 3 === 0) flags.push("\\Flagged");
      if (index % 2 === 0) flags.push("\\Seen");
      insertMessage(db, `m-${String(index).padStart(2, "0")}`, flags);
    }
  });

  afterEach(() => {
    db.close();
  });

  describe("the predicate the query uses is the predicate the index is keyed on", () => {
    // The load-bearing assertions. Everything else in this file is downstream of
    // these two holding.
    it("builds the starred filter from the shared constant, unchanged", () => {
      expect(buildMessageListSql({ accountId: "account-1", starred: true }).where).toContain(`m.${FLAGGED_PREDICATE_SQL}`);
    });

    it("builds the unread filter from the shared constant, unchanged", () => {
      expect(buildMessageListSql({ accountId: "account-1", unread: true }).where).toContain(`m.${UNSEEN_PREDICATE_SQL}`);
    });

    it.each([
      ["flagged", "idx_messages_flagged", FLAGGED_PREDICATE_SQL],
      ["unseen", "idx_messages_unseen", UNSEEN_PREDICATE_SQL],
    ])("stores the %s index under exactly the predicate the query emits", (_label, indexName, predicate) => {
      // Read back out of the schema rather than out of the module: what matters
      // is the text SQLite compares the query against, not the constant.
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName) as { sql: string } | undefined;
      expect(row, `${indexName} was not created`).toBeDefined();
      const indexSql = row!.sql;
      const whereClause = indexSql.slice(indexSql.indexOf(" WHERE "));
      // SQLite stores the DDL without the statement's trailing semicolon, so
      // this is `WHERE <predicate>` — compared verbatim, backslashes included.
      expect(whereClause).toBe(` WHERE ${predicate}`);
      // And the pattern really is the two-backslash form JSON.stringify writes.
      expect(predicate).toContain("\\\\");
    });

    it("keeps the two predicates complementary over the whole table", () => {
      // If either pattern ever stopped being a substring test of the stored JSON
      // (say someone "fixed" it to a single backslash), the views would silently
      // return the wrong rows. These counts are the oracle for that.
      const flagged = (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE flags_json LIKE '%\\\\Flagged%'").get() as { count: number }).count;
      const unseen = (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE flags_json NOT LIKE '%\\\\Seen%'").get() as { count: number }).count;
      expect(flagged).toBe(countMessageRows(db, buildMessageListSql({ accountId: "account-1", starred: true })));
      expect(unseen).toBe(countMessageRows(db, buildMessageListSql({ accountId: "account-1", unread: true })));
    });
  });

  describe("results are identical to the LIKE they replace", () => {
    const truth = (sql: string): string[] => (db.prepare(sql).all() as Array<{ id: string }>).map((row) => row.id);

    it("pages the starred view in the same order as a plain LIKE", () => {
      const paged = listMessagePage(db, buildMessageListSql({ accountId: "account-1", starred: true }), { limit: 100 }).rows.map((row) => row.id);
      expect(paged).toEqual(truth("SELECT id FROM messages WHERE flags_json LIKE '%\\\\Flagged%' ORDER BY sort_key DESC, id DESC"));
    });

    it("pages the unread view in the same order as a plain NOT LIKE", () => {
      const paged = listMessagePage(db, buildMessageListSql({ accountId: "account-1", unread: true }), { limit: 100 }).rows.map((row) => row.id);
      expect(paged).toEqual(truth("SELECT id FROM messages WHERE flags_json NOT LIKE '%\\\\Seen%' ORDER BY sort_key DESC, id DESC"));
    });

    it("answers a count that agrees with the rows it pages", () => {
      for (const view of [{ accountId: "account-1", starred: true }, { accountId: "account-1", unread: true }, { accountId: "account-1", starred: true, unread: true }] satisfies MessageListFilterQuery[]) {
        const selection = buildMessageListSql(view);
        expect(countMessageRows(db, selection)).toBe(listMessagePage(db, selection, { limit: 100 }).rows.length);
      }
    });

    it("follows a flag change in both directions", () => {
      const view = buildMessageListSql({ accountId: "account-1", starred: true });
      expect(listMessagePage(db, view, { limit: 100 }).rows.map((row) => row.id)).toContain("m-00");
      db.prepare("UPDATE messages SET flags_json = ? WHERE id = 'm-00'").run(JSON.stringify(["\\Seen"]));
      expect(listMessagePage(db, view, { limit: 100 }).rows.map((row) => row.id)).not.toContain("m-00");
      db.prepare("UPDATE messages SET flags_json = ? WHERE id = 'm-00'").run(JSON.stringify(["\\Flagged", "\\Seen"]));
      expect(listMessagePage(db, view, { limit: 100 }).rows.map((row) => row.id)).toContain("m-00");
    });
  });

  describe("the plan", () => {
    const plan = (sql: string, params: unknown[]): string => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");

    it("serves the cross-account starred count from the partial index", () => {
      // This is the shape that provably needs no statistics: with no account_id
      // to seek, the account indexes cannot serve the predicate at all, so the
      // partial index is the only candidate and SQLite takes it. Measured on a
      // 50 000-row mailbox with 48KB payloads: 58.6ms -> 0.1ms.
      const selection = buildMessageListSql({ starred: true });
      expect(plan(`SELECT COUNT(*) ${selection.join} ${selection.where}`, selection.params)).toContain("idx_messages_flagged");
    });

    it("scans the partial index rather than the table for that count", () => {
      // A bare `SCAN m` would be the table; the point of a partial index here is
      // that only the flagged rows are in it.
      const selection = buildMessageListSql({ starred: true });
      const countPlan = plan(`SELECT COUNT(*) ${selection.join} ${selection.where}`, selection.params);
      expect(countPlan).toContain("USING INDEX idx_messages_flagged");
      expect(countPlan).not.toMatch(/SCAN m$/);
    });

    it("loses the index when the predicate no longer matches, which is the drift this guards", () => {
      // The reverse assertion, and the reason the predicate assertions above are
      // written against schema text: a predicate the planner cannot match is
      // ignored without a word. Bound parameters cannot be used to prove a LIKE
      // constant, so `LIKE ?` silently drops back to a scan.
      const bound = plan(
        "SELECT COUNT(*) FROM messages m WHERE m.account_id = ? AND m.flags_json LIKE ?",
        ["account-1", "%\\Flagged%"],
      );
      expect(bound).not.toContain("idx_messages_flagged");
    });
  });
});
