import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { decodeMessageCursor, type MessageListCursor } from "../src/message-cursor.js";
import { buildMessageListSql, type MessageListSqlSelection } from "../src/message-filters.js";
import { listMessagePage } from "../src/message-queries.js";
import { indexMessageFts } from "../src/message-search.js";

// A search page used to be the most expensive query in the list by two orders
// of magnitude, and not because of anything to do with short queries. Left to
// itself the planner drove the search from `messages`: it could then walk
// idx_messages_account_sort_key in (sort_key DESC, id DESC) order and skip the
// sorter entirely, which looks free until you count what it costs — the whole
// FTS scan is re-run for every candidate message, so the page is
// O(messages_in_account x fts_rows). Measured on 4 000 rows with 48KB payloads,
// a search matching 2% of the mailbox took 33.9 seconds.
//
// The selectivity is the other way round (80 matching rows against 4 000
// messages), so the FTS scan has to drive and `messages` is probed by primary
// key. CROSS JOIN states that without changing the join's meaning or its result.
//
// This file pins the plan — a CROSS JOIN that silently degraded back to JOIN
// would restore the 34s and every assertion here would still pass — and pins
// that the rows and their order did not move.

const ROWS = 60;

describe("search page join order", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES ('account-1', 'a1@example.com', 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', '2026-01-01T00:00:00.000Z')
    `).run();
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen, uid_validity) VALUES ('account-1', 'INBOX', 'Inbox', '\\Inbox', 0, 0, '1')").run();
    for (let index = 0; index < ROWS; index += 1) {
      const id = `m-${String(index).padStart(3, "0")}`;
      const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
      db.prepare(`
        INSERT INTO messages (
          id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
          sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
        ) VALUES (?, 'account-1', 'INBOX', ?, ?, 'Sender', 'sender@example.com', '[]', ?, '', '', '', ?, 0, 0, ?)
      `).run(id, index, `subject ${index}`, at, index % 4 === 0 ? '["\\\\Seen"]' : "[]", at);
      // Every fifth row carries the needle in its body, so a search has both a
      // narrow and a wide match set to be planned against.
      indexMessageFts(db, id, {
        subject: `subject ${index}`,
        fromName: "Sender",
        fromAddress: "sender@example.com",
        textBody: index % 5 === 0 ? "needle in the body" : "unrelated text",
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  const pagePlan = (selection: MessageListSqlSelection): string => (db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT m.*, m.sort_key AS list_sort_key, a.email AS account_email, a.provider_name
    ${selection.join}
    JOIN accounts a ON a.id = m.account_id
    ${selection.where}
    ORDER BY m.sort_key DESC, m.id DESC
    LIMIT 41
  `).all(...selection.params) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");

  it("drives the search from the FTS scan instead of re-scanning it per message", () => {
    const plan = pagePlan(buildMessageListSql({ accountId: "account-1", q: "needle" }));
    // The FTS scan has to come first, or the nested loop is the quadratic one.
    expect(plan).toContain("SCAN fts");
    expect(plan.indexOf("SCAN fts")).toBeLessThan(plan.search(/SEARCH m USING INDEX sqlite_autoindex_messages_1/));
  });

  it("states the join order in the SQL rather than hoping the planner picks it", () => {
    // CROSS JOIN is the mechanism; if this regresses to a plain JOIN the plan
    // assertions above are what would notice, and this says why.
    expect(buildMessageListSql({ accountId: "account-1", q: "needle" }).join).toContain("CROSS JOIN");
  });

  it("still returns the same rows in the same order as an unnested scan", () => {
    // The oracle is the plain join, whose result is by definition what the
    // CROSS JOIN has to reproduce.
    const selection = buildMessageListSql({ accountId: "account-1", q: "needle" });
    const unnested = (db.prepare(`
      SELECT m.id ${selection.join.replace("CROSS JOIN", "JOIN")}
      JOIN accounts a ON a.id = m.account_id ${selection.where}
      ORDER BY m.sort_key DESC, m.id DESC
      LIMIT 41
    `).all(...selection.params) as Array<{ id: string }>).map((row) => row.id);
    const pinned = listMessagePage(db, selection, { limit: 40 }).rows.map((row) => row.id);
    expect(pinned).toEqual(unnested);
    // And the fixture is not degenerate: the search really does match a strict
    // subset, which is the case the join order exists for.
    expect(pinned).toHaveLength(ROWS / 5);
    expect(pinned.length).toBeLessThan(ROWS);
  });

  it("answers a search that matches nothing the same way", () => {
    const selection = buildMessageListSql({ accountId: "account-1", q: "absent" });
    const page = listMessagePage(db, selection, { limit: 40 });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(pagePlan(selection)).toContain("SCAN fts");
  });

  it("paginates a search with the cursor without changing the served sequence", () => {
    const selection = buildMessageListSql({ accountId: "account-1", q: "needle" });
    const ids: string[] = [];
    let cursor: MessageListCursor | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = listMessagePage(db, selection, { limit: 5, cursor });
      ids.push(...page.rows.map((row) => row.id));
      if (page.nextCursor === null) break;
      cursor = decodeMessageCursor(page.nextCursor);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(ROWS / 5);
    // Newest first, and every served id really matches.
    expect(ids).toEqual([...ids].sort().reverse());
    expect(ids[0]).toBe("m-055");
  });

  it("leaves the non-search views on their index-ordered plans", () => {
    // CROSS JOIN only exists in the search join, so the other views must be
    // untouched — they are the ones with pinned plans elsewhere in the suite.
    const inbox = pagePlan(buildMessageListSql({ accountId: "account-1" }));
    expect(inbox).toContain("idx_messages_account_sort_key");
    expect(inbox).not.toContain("USE TEMP B-TREE");
  });
});
