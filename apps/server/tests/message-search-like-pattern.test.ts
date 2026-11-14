import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { buildMessageListSql, type MessageListSqlSelection } from "../src/message-filters.js";
import { ftsLikeEscape, ftsLikePattern, indexMessageFts } from "../src/message-search.js";

// The list search used to bind ESCAPE on every query. That is correct but
// costs the trigram index: SQLite only rewrites a LIKE into the FTS5 trigram
// index when the pattern carries no ESCAPE clause. The fix is three states, and
// each one exists because dropping it regressed something measurable:
//
// - ESCAPE on everything: 38.8ms instead of 0.2ms for a 3+ character query.
// - ESCAPE only for `%`/`_`: a query containing `\` matched the wrong rows
//   (17 vs 8), because `\` is the escape character itself.
// - ESCAPE only for `%`/`_`/`\`, never for short queries: a 1-2 character
//   query lost the single FTS scan and became a MULTI-INDEX OR of four
//   independent scans (229ms -> 850ms for a two-character Chinese query).
//
// This file pins the pattern, the plan, and that the rows did not move.

type Fixture = {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  body: string;
};

const FIXTURE: Fixture[] = [
  { id: "m-review", subject: "Quarterly review", fromName: "Ada Lovelace", fromAddress: "ada@example.com", body: "Numbers attached." },
  { id: "m-review-upper", subject: "REVIEW MEETING", fromName: "Alan Turing", fromAddress: "alan@example.com", body: "Agenda." },
  { id: "m-percent", subject: "Project 100% done", fromName: "Sender", fromAddress: "s@example.com", body: "body" },
  { id: "m-percent-decoy", subject: "Project 100X done", fromName: "Sender", fromAddress: "s@example.com", body: "body" },
  { id: "m-underscore", subject: "code_branch merge", fromName: "Sender", fromAddress: "s@example.com", body: "body" },
  { id: "m-underscore-decoy", subject: "codeXbranch merge", fromName: "Sender", fromAddress: "s@example.com", body: "body" },
  { id: "m-backslash", subject: "path C:\\temp\\notes", fromName: "Sender", fromAddress: "s@example.com", body: "body" },
  { id: "m-backslash-decoy", subject: "path C:/temp/notes", fromName: "Sender", fromAddress: "s@example.com", body: "body" },
  { id: "m-two-cjk", subject: "通知中心上线", fromName: "测试", fromAddress: "test@example.com", body: "这是一封中文正文邮件" },
  { id: "m-cjk-decoy", subject: "English subject", fromName: "测试", fromAddress: "test@example.com", body: "No Chinese body here" },
  { id: "m-body", subject: "unrelated", fromName: "Sender", fromAddress: "s@example.com", body: "the needle is in the body" },
  { id: "m-one-cjk", subject: "中", fromName: "Sender", fromAddress: "s@example.com", body: "single character subject" },
];

let uid = 0;

function seed(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES ('account-1', 'a1@example.com', 'custom', 'Demo', 'encrypted',
      'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', ?)
  `).run(new Date().toISOString());
  const now = new Date().toISOString();
  for (const row of FIXTURE) {
    uid += 1;
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, sent_at, flags_json, has_attachments,
        size, created_at, encrypted_payload, payload_version
      ) VALUES (?, 'account-1', 'INBOX', ?, ?, '[]', 0, 0, ?, NULL, 0)
    `).run(row.id, uid, now, now);
    indexMessageFts(db, row.id, {
      subject: row.subject,
      fromName: row.fromName,
      fromAddress: row.fromAddress,
      textBody: row.body,
    });
  }
}

/** What a literal case-insensitive substring search must return. */
function expectedIds(query: string): string[] {
  const needle = query.toLowerCase();
  return FIXTURE
    .filter((row) => [row.subject, row.fromName, row.fromAddress, row.body]
      .some((text) => text.toLowerCase().includes(needle)))
    .map((row) => row.id)
    .sort();
}

/** The implementation this change replaces: escape and bind ESCAPE, always. */
function legacySqlIds(db: DatabaseHandle, query: string): string[] {
  const pattern = `%${ftsLikeEscape(query)}%`;
  const rows = db.prepare(`
    SELECT m.id
    FROM messages_fts fts CROSS JOIN messages m ON m.id = fts.message_id
    WHERE (fts.subject LIKE ? ESCAPE '\\'
      OR fts.from_name LIKE ? ESCAPE '\\'
      OR fts.from_address LIKE ? ESCAPE '\\'
      OR fts.body LIKE ? ESCAPE '\\')
    ORDER BY m.id
  `).all(pattern, pattern, pattern, pattern) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function selectionFor(query: string): MessageListSqlSelection {
  return buildMessageListSql({ accountId: "account-1", folder: "INBOX", q: query });
}

function currentIds(db: DatabaseHandle, query: string): string[] {
  const selection = selectionFor(query);
  return (db.prepare(`SELECT m.id ${selection.join} ${selection.where} ORDER BY m.id`)
    .all(...selection.params) as Array<{ id: string }>).map((row) => row.id);
}

function planRows(db: DatabaseHandle, query: string): string[] {
  const selection = selectionFor(query);
  return (db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT m.id ${selection.join} ${selection.where} ORDER BY m.sort_key DESC, m.id DESC LIMIT 41
  `).all(...selection.params) as Array<{ detail: string }>).map((row) => row.detail);
}

function plan(db: DatabaseHandle, query: string): string {
  return planRows(db, query).join(" | ");
}

/** The `SCAN fts ...` lines, one per OR-ed column. */
function ftsScans(db: DatabaseHandle, query: string): string[] {
  return planRows(db, query).filter((detail) => detail.includes("SCAN fts"));
}

describe("ftsLikePattern", () => {
  it("escapes a wildcard or the escape character itself", () => {
    expect(ftsLikePattern("100%")).toEqual({ pattern: "%100\\%%", escape: true });
    expect(ftsLikePattern("code_branch")).toEqual({ pattern: "%code\\_branch%", escape: true });
    expect(ftsLikePattern("C:\\temp")).toEqual({ pattern: "%C:\\\\temp%", escape: true });
    // A mix must escape every special character, not just the first one.
    expect(ftsLikePattern("50%_of\\all")).toEqual({ pattern: "%50\\%\\_of\\\\all%", escape: true });
  });

  it("drops ESCAPE for wildcard-free queries of three or more characters", () => {
    expect(ftsLikePattern("review")).toEqual({ pattern: "%review%", escape: false });
    expect(ftsLikePattern("通知中心")).toEqual({ pattern: "%通知中心%", escape: false });
  });

  it("keeps ESCAPE below the trigram floor so the scan stays single-pass", () => {
    expect(ftsLikePattern("通")).toEqual({ pattern: "%通%", escape: true });
    expect(ftsLikePattern("通知")).toEqual({ pattern: "%通知%", escape: true });
  });

  it("counts code points, matching the trigram tokenizer's floor", () => {
    // Four UTF-16 units but two characters: still below the floor.
    expect(ftsLikePattern("😀😀").escape).toBe(true);
    expect(ftsLikePattern("😀😀😀").escape).toBe(false);
  });
});

describe("list search LIKE planning and results", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seed(db);
  });

  afterEach(() => {
    db.close();
  });

  it("uses the trigram index for every OR-ed column of a 3+ character query", () => {
    // One scan per column, and each one goes through the trigram index
    // (`0:L<n>`); `MULTI-INDEX OR` itself is fine here — it is the union of
    // four *indexed* scans, which is exactly what the ESCAPE-free LIKE buys.
    const scans = ftsScans(db, "quarterly");
    expect(scans).toHaveLength(4);
    for (const scan of scans) expect(scan).toMatch(/VIRTUAL TABLE INDEX 0:L\d/);
  });

  it("keeps a 1-2 character query on a single FTS scan", () => {
    for (const query of ["通", "通知"]) {
      // Below the trigram floor the ESCAPE-free spelling split into four
      // independent scans (229ms -> 850ms); the ESCAPE keeps one.
      const scans = ftsScans(db, query);
      expect(scans, query).toHaveLength(1);
      expect(scans[0], query).not.toMatch(/VIRTUAL TABLE INDEX 0:L\d/);
      expect(plan(db, query), query).not.toContain("MULTI-INDEX OR");
    }
  });

  it("binds ESCAPE only when the pattern needs it", () => {
    expect(selectionFor("quarterly").where).not.toContain("ESCAPE");
    expect(selectionFor("通知").where).toContain("ESCAPE");
    expect(selectionFor("100%").where).toContain("ESCAPE");
    expect(selectionFor("code_branch").where).toContain("ESCAPE");
    expect(selectionFor("C:\\temp").where).toContain("ESCAPE");
  });

  it("returns the same rows as the legacy always-ESCAPE spelling for wildcard-free words", () => {
    const queries = ["a", "通知", "中", "review", "REVIEW", "Review", "needle", "quarterly", "ada@example", "english subject"];
    for (const query of queries) {
      expect(currentIds(db, query), query).toEqual(expectedIds(query));
      expect(currentIds(db, query), query).toEqual(legacySqlIds(db, query));
    }
  });

  it("treats wildcards and the escape character literally", () => {
    expect(currentIds(db, "100%")).toEqual(["m-percent"]);
    expect(currentIds(db, "%")).toEqual(["m-percent"]);
    expect(currentIds(db, "_")).toEqual(["m-underscore"]);
    expect(currentIds(db, "code_branch")).toEqual(["m-underscore"]);
    expect(currentIds(db, "C:\\temp")).toEqual(["m-backslash"]);
    expect(currentIds(db, "\\")).toEqual(["m-backslash"]);
  });

  it("matches case-insensitively without a wildcard", () => {
    expect(currentIds(db, "review")).toEqual(["m-review", "m-review-upper"]);
    expect(currentIds(db, "REVIEW")).toEqual(["m-review", "m-review-upper"]);
  });
});
