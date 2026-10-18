import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { folderCounts, mailboxBadges } from "../src/folder-counts.js";
import { UNSEEN_PREDICATE_SQL } from "../src/message-flag-indexes.js";

/**
 * The sidebar's derived counts (contract §3.6 / §4.5, I4).
 *
 * `folders.total` and `folders.unseen` are gone, so every number the sidebar
 * shows is a query over `messages` — the same target state the list renders.
 * Two things have to be true at once, and this file is the pair:
 *
 *   1. the reading equals a full recount, for ANY target state, not just the
 *      states a fixture starts in. That is what the 220-step property test below
 *      is for: the old counters could only be checked against hand-kept
 *      arithmetic, which is exactly why their drift went unnoticed;
 *   2. the reading is served by an index instead of a scan of the mailbox. That
 *      is asserted as a *plan* (and as the index's own key columns) rather than
 *      as a better millisecond budget: the 51k-row / 704MB measurements that
 *      decided between a two- and a three-column partial index live in the
 *      contract's §0.2 and in `output/refactor-2026-10/bench-folder-counts.mts`,
 *      and what a test can pin without flaking is which index the planner takes.
 *      A budget is asserted too, but as the endpoint's SLO with margin over a
 *      whole sidebar refresh -- never as evidence about the shape.
 *
 * The expectations are spelled out here rather than imported from
 * `folder-counts.ts`: an assertion that reuses the module's own predicate is a
 * mirror of it, and would keep passing if the predicate were wrong.
 */

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();
const DUE_LATER = new Date(NOW + 4 * 3_600_000).toISOString();
const ALREADY_DUE = new Date(NOW - 4 * 3_600_000).toISOString();

/**
 * The folders every seeded account gets.
 *
 * Two of them are inboxes — one by path, one by `special_use` only — because the
 * unified badge resolves its paths from `folders` and a fixture with a single
 * INBOX would never exercise the second half of that rule.
 */
const FOLDERS = [
  { path: "INBOX", name: "Inbox", specialUse: "\\Inbox" },
  { path: "Newsletters", name: "Newsletters", specialUse: "\\Inbox" },
  { path: "Archive", name: "Archive", specialUse: "\\Archive" },
  { path: "Projects", name: "Projects", specialUse: null },
] as const;
const PATHS = FOLDERS.map((folder) => folder.path);
const accountIdOf = (index: number): string => `account-${index + 1}`;

/** A deterministic PRNG, so a failing step can be re-run instead of guessed at. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flagsFor = (roll: number): string[] => {
  const flags: string[] = [];
  if (roll % 2 === 0) flags.push("\\Seen");
  if (roll % 3 === 0) flags.push("\\Flagged");
  return flags;
};

/** A row the property test can mutate, and the account it belongs to. */
type SeededRow = { id: string; accountId: string };
type Seeded = { rows: SeededRow[]; insertMessage: (id: string, accountId: string, mailbox: string) => void };

/** Accounts, their folders, and messages spread over them. */
function seed(db: DatabaseHandle, accounts: number, perAccount: number, rand: () => number): Seeded {
  const insertAccount = db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', ?)
  `);
  const insertFolder = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)");
  const insert = db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, flags_json, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, 'Demo message', 'Demo', 'demo@example.com', '[]', ?, '', '', '', ?, 0, ?)
  `);
  const ids: SeededRow[] = [];
  let uid = 0;
  for (let account = 0; account < accounts; account += 1) {
    const accountId = accountIdOf(account);
    insertAccount.run(accountId, `${accountId}@example.com`, NOW_ISO);
    for (const folder of FOLDERS) insertFolder.run(accountId, folder.path, folder.name, folder.specialUse);
    for (let index = 0; index < perAccount; index += 1) {
      uid += 1;
      const id = `${accountId}-m${index}`;
      const mailbox = PATHS[Math.floor(rand() * PATHS.length)]!;
      insert.run(id, accountId, mailbox, uid, JSON.stringify(flagsFor(Math.floor(rand() * 6))), NOW_ISO, Math.floor(rand() * 2), NOW_ISO);
      ids.push({ id, accountId });
    }
  }
  return {
    rows: ids,
    insertMessage: (id: string, accountId: string, mailbox: string) => {
      uid += 1;
      insert.run(id, accountId, mailbox, uid, JSON.stringify([]), NOW_ISO, 0, NOW_ISO);
    },
  };
}

// ── independent recount ────────────────────────────────────────────────────
// Each of these answers the question from `messages` alone, with the predicate
// written out. They are the "full recomputation" half of G3.

const rowsOf = <T,>(db: DatabaseHandle, sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[];
const countOf = (db: DatabaseHandle, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { count: number }).count;

const recountFolder = (db: DatabaseHandle, accountId: string, path: string) => ({
  total: countOf(db, "SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND effective_mailbox = ?", accountId, path),
  unseen: countOf(
    db,
    "SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND effective_mailbox = ? AND flags_json NOT LIKE '%\\Seen%'",
    accountId,
    path,
  ),
});

/** The unified inbox as the sidebar defines it: inbox paths, minus active snoozes. */
const recountInbox = (db: DatabaseHandle, accountId: string) => {
  const inboxPaths = rowsOf<{ path: string }>(
    db,
    "SELECT path FROM folders WHERE account_id = ? AND (special_use = '\\Inbox' OR UPPER(path) = 'INBOX')",
    accountId,
  ).map((row) => row.path);
  let messages = 0;
  let unread = 0;
  for (const path of inboxPaths) {
    messages += countOf(
      db,
      "SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND effective_mailbox = ? AND (snoozed_until IS NULL OR snoozed_until <= ?)",
      accountId,
      path,
      NOW_ISO,
    );
    unread += countOf(
      db,
      "SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND effective_mailbox = ? AND (snoozed_until IS NULL OR snoozed_until <= ?) AND flags_json NOT LIKE '%\\Seen%'",
      accountId,
      path,
      NOW_ISO,
    );
  }
  return { messages, unread };
};

/** Every badge `/api/stats` reports, recounted for one account or for all of them. */
const recountBadges = (db: DatabaseHandle, accountId?: string) => {
  const accountIds = accountId ? [accountId] : rowsOf<{ id: string }>(db, "SELECT id FROM accounts").map((row) => row.id);
  let messages = 0;
  let unread = 0;
  for (const id of accountIds) {
    const inbox = recountInbox(db, id);
    messages += inbox.messages;
    unread += inbox.unread;
  }
  const scope = accountId ? " AND account_id = ?" : "";
  const params: unknown[] = accountId ? [accountId] : [];
  return {
    messages,
    unread,
    starred: countOf(db, `SELECT COUNT(*) AS count FROM messages WHERE flags_json LIKE '%\\Flagged%'${scope}`, ...params),
    snoozed: countOf(db, `SELECT COUNT(*) AS count FROM messages WHERE snoozed_until IS NOT NULL AND snoozed_until > ?${scope}`, NOW_ISO, ...params),
    attachments: countOf(db, `SELECT COUNT(*) AS count FROM messages WHERE has_attachments = 1${scope}`, ...params),
  };
};

/**
 * The whole invariant, checked for every account and for the whole mailbox.
 *
 * Reading it in one place is deliberate: the pairwise comparisons (badge vs
 * recount, global vs the sum over accounts) are what I4 claims, and spreading
 * them over the mutation steps would only make a failure harder to name.
 */
function expectAgrees(db: DatabaseHandle, context: string, accounts: number): void {
  for (let account = 0; account < accounts; account += 1) {
    const accountId = accountIdOf(account);
    for (const path of PATHS) {
      expect(folderCounts(db, accountId).find((count) => count.path === path), `${context}: ${accountId}/${path} is missing`)
        .toEqual({ path, ...recountFolder(db, accountId, path) });
    }
    const badges = mailboxBadges(db, NOW, accountId);
    const recounted = recountBadges(db, accountId);
    expect(
      { messages: badges.messages, unread: badges.unread, starred: badges.starred, snoozed: badges.snoozed, attachments: badges.attachments },
      `${context}: ${accountId} badges`,
    ).toEqual(recounted);
    expect(badges.accounts, `${context}: ${accountId} accounts`).toBe(1);
  }
  const global = mailboxBadges(db, NOW);
  const globalRecount = recountBadges(db);
  expect(
    { messages: global.messages, unread: global.unread, starred: global.starred, snoozed: global.snoozed, attachments: global.attachments },
    `${context}: whole-mailbox badges`,
  ).toEqual(globalRecount);
  expect(global.accounts, `${context}: whole-mailbox accounts`).toBe(accounts);
  // The scoped badges are a partition of the global ones, not a different
  // reading: nothing a chip shows may fail to appear in the total above it.
  const perAccount = Array.from({ length: accounts }, (_, account) => mailboxBadges(db, NOW, accountIdOf(account)));
  for (const key of ["messages", "unread", "starred", "snoozed", "attachments"] as const) {
    expect(perAccount.reduce((sum, badges) => sum + badges[key], 0), `${context}: ${key} does not partition`)
      .toBe(globalRecount[key]);
  }
}

describe("derived sidebar counts", () => {
  it("stays equal to a full recount across 220 random changes (G3)", () => {
    const db = openDatabase(":memory:");
    try {
      const rand = mulberry32(0x5eed);
      const seeded = seed(db, 2, 40, rand);
      const rows = seeded.rows;
      const writes = {
        flags: db.prepare("UPDATE messages SET flags_json = ? WHERE id = ?"),
        snooze: db.prepare("UPDATE messages SET snoozed_until = ? WHERE id = ?"),
        goal: db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = ? WHERE id = ?"),
        confirm: db.prepare("UPDATE messages SET mailbox = ?, pending_move_destination = NULL, pending_move_state = NULL WHERE id = ?"),
        remove: db.prepare("DELETE FROM messages WHERE id = ?"),
      };
      expectAgrees(db, "seed", 2);

      for (let step = 0; step < 220; step += 1) {
        const row = rows[Math.floor(rand() * rows.length)]!;
        const { id, accountId } = row;
        const path = PATHS[Math.floor(rand() * PATHS.length)]!;
        let description: string;
        switch (step % 7) {
          case 0: {
            const flags = JSON.stringify(flagsFor(Math.floor(rand() * 6)));
            writes.flags.run(flags, id);
            description = `flags(${id}) = ${flags}`;
            break;
          }
          case 1: {
            // A goal written but not yet claimed: the row already reads in its
            // destination (`effective_mailbox`'s COALESCE arm).
            writes.goal.run(path, null, id);
            description = `goal(${id}) -> ${path} (unclaimed)`;
            break;
          }
          case 2: {
            // Claimed by the executor: the row reads back at its source until
            // the provider confirms, which is the `intent` arm.
            writes.goal.run(path, "intent", id);
            description = `goal(${id}) -> ${path} (in flight)`;
            break;
          }
          case 3: {
            writes.goal.run(path, "confirmed", id);
            description = `goal(${id}) -> ${path} (confirmed)`;
            break;
          }
          case 4: {
            writes.confirm.run(path, id);
            description = `arrive(${id}) at ${path}`;
            break;
          }
          case 5: {
            const when = rand() < 0.4 ? DUE_LATER : rand() < 0.7 ? ALREADY_DUE : null;
            writes.snooze.run(when, id);
            description = `snooze(${id}) = ${when ?? "cleared"}`;
            break;
          }
          default: {
            if (rows.length > 12 && rand() < 0.5) {
              writes.remove.run(id);
              rows.splice(rows.indexOf(row), 1);
              description = `delete(${id})`;
            } else {
              const fresh = `late-${step}`;
              seeded.insertMessage(fresh, accountId, path);
              rows.push({ id: fresh, accountId });
              description = `insert(${fresh}) into ${path}`;
            }
            break;
          }
        }
        expectAgrees(db, `step ${step}: ${description}`, 2);
      }

      // The loop is a property test, not a fixture walk: if it never moved a row
      // into another folder, or never deleted one, it would still pass while
      // saying much less. Each of those leaves a row count it can be caught by.
      expect(countOf(db, "SELECT COUNT(*) AS count FROM messages WHERE pending_move_destination IS NOT NULL")).toBeGreaterThan(0);
      expect(countOf(db, "SELECT COUNT(*) AS count FROM messages WHERE snoozed_until IS NOT NULL")).toBeGreaterThan(0);
      expect(countOf(db, "SELECT COUNT(*) AS count FROM messages WHERE flags_json LIKE '%\\Seen%'")).toBeGreaterThan(0);
      expect(countOf(db, "SELECT COUNT(*) AS count FROM messages WHERE flags_json NOT LIKE '%\\Seen%'")).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("counts a snoozed message in its folder and not in the unified inbox", () => {
    const db = openDatabase(":memory:");
    try {
      const rand = mulberry32(1);
      const seeded = seed(db, 1, 0, rand);
      seeded.insertMessage("snoozed", accountIdOf(0), "INBOX");
      db.prepare("UPDATE messages SET snoozed_until = ? WHERE id = ?").run(DUE_LATER, "snoozed");
      // The asymmetry is the list's own (folder-counts.ts): the unified view
      // hides an actively-snoozed row, an explicit folder selection shows it.
      // I4 binds each badge to the list it describes, so both readings are
      // correct and neither may be "fixed" to match the other.
      expect(folderCounts(db, accountIdOf(0)).find((count) => count.path === "INBOX")).toEqual({ path: "INBOX", total: 1, unseen: 1 });
      expect(mailboxBadges(db, NOW, accountIdOf(0))).toMatchObject({ messages: 0, unread: 0, snoozed: 1 });

      // And it comes back on its own once due: no writer has to release it.
      db.prepare("UPDATE messages SET snoozed_until = ? WHERE id = ?").run(ALREADY_DUE, "snoozed");
      expect(mailboxBadges(db, NOW, accountIdOf(0))).toMatchObject({ messages: 1, unread: 1, snoozed: 0 });
      expect(folderCounts(db, accountIdOf(0)).find((count) => count.path === "INBOX")).toEqual({ path: "INBOX", total: 1, unseen: 1 });
    } finally {
      db.close();
    }
  });

  it("answers the folder counts from the indexes built for them, not from a scan", () => {
    const db = openDatabase(":memory:");
    try {
      seed(db, 1, 60, mulberry32(7));
      const seen: string[] = [];
      const bind = db.prepare.bind(db);
      (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        seen.push(sql);
        return bind(sql);
      };
      try {
        folderCounts(db, accountIdOf(0));
      } finally {
        (db as unknown as { prepare: typeof bind }).prepare = bind;
      }

      const planOf = (matches: (sql: string) => boolean): string => {
        const found = seen.filter(matches);
        expect(found, `${found.length} statements matched`).toHaveLength(1);
        const sql = found[0]!;
        const params = Array<string>((sql.match(/\?/g) ?? []).length).fill(accountIdOf(0));
        return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
          .map((row) => row.detail).join(" | ");
      };

      // The per-folder unread count is the query the three-column partial index
      // exists for: one top-level WHERE per folder, because an aggregate with
      // the predicate in a `SUM(CASE ...)` arm is declined outright (363.81ms
      // against 0.86ms, contract §0.2).
      const unread = planOf((sql) => sql.includes("effective_mailbox = ?") && sql.includes(UNSEEN_PREDICATE_SQL));
      expect(unread).toContain("idx_messages_unseen_by_folder");
      expect(unread).not.toContain("SCAN messages");
      // The per-folder total needs no new index: the list's own folder index
      // already starts with the two columns this predicates on.
      const total = planOf((sql) => sql.includes("GROUP BY effective_mailbox"));
      expect(total).toContain("idx_messages_account_effective_mailbox");
      expect(total).not.toContain("SCAN messages");

      // And the index is keyed the way the SLO needed it, not merely named the
      // same: `snoozed_until` has to be IN the index, because the badge excludes
      // active snoozes and SQLite would otherwise fetch every matching row to
      // read it (1.30ms against 68.07ms on 51k rows, contract §0.2).
      const keyed = (db.prepare("PRAGMA index_xinfo(idx_messages_unseen_by_folder)").all() as Array<{ name: string | null; key: number }>)
        .filter((column) => column.key === 1)
        .map((column) => column.name);
      expect(keyed).toEqual(["account_id", "effective_mailbox", "snoozed_until"]);
      // Nothing about the sidebar may reintroduce the dropped counters.
      const folderColumns = (db.prepare("PRAGMA table_info(folders)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(folderColumns).not.toContain("total");
      expect(folderColumns).not.toContain("unseen");
    } finally {
      db.close();
    }
  });

  it("refreshes the whole sidebar inside the endpoint's budget", () => {
    const db = openDatabase(":memory:");
    try {
      const accounts = 3;
      seed(db, accounts, 2_500, mulberry32(11));
      const refresh = (): void => {
        for (let account = 0; account < accounts; account += 1) folderCounts(db, accountIdOf(account));
        mailboxBadges(db, NOW);
      };
      refresh();
      const durations: number[] = [];
      for (let round = 0; round < 25; round += 1) {
        const started = performance.now();
        refresh();
        durations.push(performance.now() - started);
      }
      durations.sort((left, right) => left - right);
      const p95 = durations[Math.floor(durations.length * 0.95)]!;
      // 200ms is the contract's SLO for one refresh of the sidebar, and the
      // margin here is deliberate: this fixture is 7 500 rows against the 51 000
      // the number was measured on (§0.2), so a budget failure means the shape
      // changed, which the plan assertions above name exactly. The timing is a
      // backstop for the aggregate the user feels, not the shape evidence.
      expect(durations.length).toBe(25);
      expect(p95).toBeLessThan(200);
    } finally {
      db.close();
    }
  });
});
