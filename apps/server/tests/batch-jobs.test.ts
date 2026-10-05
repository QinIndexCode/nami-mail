import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { createBatchJob, getBatchJobSnapshot, undoBatchJob } from "../src/batch-jobs.js";
import { indexMessageFts } from "../src/message-search.js";
import type { MessageListFilterQuery } from "../src/message-filters.js";

describe("batch jobs (predicate-scoped list operations)", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => lock),
    messageFlagsAdd: vi.fn(async () => undefined),
    messageFlagsRemove: vi.fn(async () => undefined),
    messageMove: vi.fn(async (uids: number | number[], destination: string) => {
      const list = Array.isArray(uids) ? uids : [uids];
      return { path: "INBOX", destination, uidMap: new Map(list.map((uid) => [uid, uid + 100])) };
    }),
    logout: vi.fn(async () => undefined),
  };

  /** Waits until the queued job settles, then returns its snapshot. */
  async function waitForJob(jobId: string, status: "completed" | "failed" = "completed", attempts = 200) {
    for (let i = 0; i < attempts; i += 1) {
      const snapshot = getBatchJobSnapshot(jobId);
      if (snapshot && snapshot.status === status) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Job ${jobId} did not settle as ${status}`);
  }

  /**
   * Test-only prepared-statement cache, kept as a floor under the 40 000-row
   * case below and nothing else.
   *
   * It was added when `moveMessagesInOneCommand` re-compiled its six
   * statements per message, so a 40 000-row selection paid 240 000
   * `sqlite3_prepare` calls. The source has since moved those statements (and
   * the per-chunk row lookup) into one per-connection bundle in
   * `sync-move-statements.ts`, so the job now compiles about a dozen
   * statements in total: measured on this machine, the 40 000-row case takes
   * 2.64s on the raw handle and 2.60s through this cache — the same number,
   * because there is nothing left here to hide.
   *
   * It stays wired in anyway, and its remaining job is narrower than it was:
   * it is a time floor, not a correctness gate. If either the bundle or this
   * cache is ever removed, a per-message recompile turns this case from ~2.6s
   * into ~8s and it fails on its 30s budget under load instead of reporting
   * anything useful. The contract that actually names the statements is the
   * 2500-row case above, which runs on the raw handle precisely so nothing on
   * this side can hide it.
   *
   * It keys on the exact SQL string and replays the statement with the
   * caller's parameters, so every statement the job issues, every variable it
   * binds and every write it performs is unchanged. That includes the driver's
   * variable ceiling, which is decided by the SQL text and its bound values,
   * not by how many times the statement was compiled.
   */
  function memoizingDb(handle: DatabaseHandle): DatabaseHandle {
    const statements = new Map<string, ReturnType<DatabaseHandle["prepare"]>>();
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (sql: string) => {
            const cached = statements.get(sql);
            if (cached) return cached;
            const statement = target.prepare(sql);
            statements.set(sql, statement);
            return statement;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  type TrackedClient = {
    usable: boolean;
    connect: ReturnType<typeof vi.fn>;
    getMailboxLock: ReturnType<typeof vi.fn>;
    messageMove: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  };

  /**
   * Hands out a *fresh* client per call instead of the shared one, so a test
   * can assert that every connection the job opened was logged out — a shared
   * mock would let a leaked-and-reused client hide behind a single spy.
   * `onCreate` runs as each client is dialled, which is the only moment a test
   * can arm a per-connection behaviour (e.g. one provider refusal) before the
   * code under test reaches for it.
   */
  function trackOpenedClients(onCreate?: (entry: TrackedClient, index: number) => void) {
    const opened: TrackedClient[] = [];
    imapClientForAccount.mockImplementation(async () => {
      const entry: TrackedClient = {
        usable: true,
        connect: vi.fn(async () => undefined),
        getMailboxLock: vi.fn(async () => lock),
        messageMove: vi.fn(async (uids: number | number[], destination: string) => {
          const list = Array.isArray(uids) ? uids : [uids];
          return { path: "INBOX", destination, uidMap: new Map(list.map((uid) => [uid, uid + 100])) };
        }),
        logout: vi.fn(async () => undefined),
      };
      opened.push(entry);
      onCreate?.(entry, opened.length - 1);
      return entry;
    });
    return opened;
  }

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    client.getMailboxLock.mockImplementation(async () => lock);
    imapClientForAccount.mockReturnValue(client);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-1", "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", now);
    for (const [path, name, specialUse, total] of [
      ["INBOX", "Inbox", "\\Inbox", 3],
      ["Trash", "Trash", "\\Trash", 0],
      ["[Gmail]/所有邮件", "All Mail", "\\All", 0],
      ["Projects", "Projects", null, 0],
    ] as Array<[string, string, string | null, number]>) {
      db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
        .run("account-1", path, name, specialUse, total, 0);
    }
    const insert = (id: string, uid: number, mailbox: string) => {
      db.prepare(`
        INSERT INTO messages (
          id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
          sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, "account-1", mailbox, uid, "Subject", "Demo", "demo@example.com", "[]", now, "", "", "", JSON.stringify([]), 0, 0, now);
    };
    insert("message-1", 42, "INBOX");
    insert("message-2", 43, "INBOX");
    insert("message-3", 44, "INBOX");
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  const inboxQuery: MessageListFilterQuery = { folder: "INBOX" };

  /** The progress response's exact key set. Progress numbers, never the scope. */
  const PROGRESS_KEYS = [
    "createdAt", "done", "failed", "id", "kind", "status", "total", "undoWindowMs", "updated",
  ];

  it("exposes progress numbers only — never the undo scope — on every snapshot", async () => {
    const created = createBatchJob({ kind: "flags", patch: { seen: true }, query: inboxQuery }, { db, masterKey, oauthService: undefined });
    // A job that is still running is the payload the 600ms poll loop re-reads
    // for minutes: it must already be free of the changed-id array.
    expect(Object.keys(created).sort()).toEqual(PROGRESS_KEYS);
    expect("changedIds" in created).toBe(false);

    const done = await waitForJob(created.id);
    expect(Object.keys(done).sort()).toEqual(PROGRESS_KEYS);
    expect("changedIds" in done).toBe(false);

    // Progress numbers are what the poll actually consumes, and they must
    // still describe the real outcome.
    expect(done).toMatchObject({ status: "completed", total: 3, done: 3, updated: 3, failed: 0 });

    // The undo scope is gone from the wire but intact in memory: the undo job
    // reverses exactly the three messages the flags job changed.
    const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
    expect(undone.ok).toBe(true);
    const undoJob = await waitForJob(undone.jobId!);
    expect(Object.keys(undoJob).sort()).toEqual(PROGRESS_KEYS);
    expect(undoJob).toMatchObject({ kind: "undo", status: "completed", total: 3, done: 3, updated: 3, failed: 0 });
    for (const id of ["message-1", "message-2", "message-3"]) {
      const row = db.prepare("SELECT flags_json FROM messages WHERE id = ?").get(id) as { flags_json: string };
      expect(JSON.parse(row.flags_json)).not.toContain("\\Seen");
    }
  });

  it("keeps the changed ids out of a large selection's progress response", async () => {
    // The regression this shape change exists for: at M ids the old snapshot
    // cost ~M*40 bytes per poll, i.e. 1.3 MB per response for a 30k selection
    // re-read every 600ms. The progress payload must be flat in M.
    const COUNT = 2_000;
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, 'account-1', 'INBOX', ?, 'Subject', 'Demo', 'demo@example.com', '[]', ?, '', '', '', ?, 0, 0, ?)
    `);
    db.transaction(() => {
      for (let i = 0; i < COUNT; i += 1) {
        insert.run(`wide-${i}`, 50_000 + i, now, JSON.stringify([]), now);
      }
    })();

    const created = createBatchJob({ kind: "flags", patch: { seen: true }, query: { folder: "INBOX" } }, { db, masterKey, oauthService: undefined });
    const done = await waitForJob(created.id);

    expect(done.total).toBe(COUNT + 3);
    expect(done.updated).toBe(COUNT + 3);
    // ~200 bytes regardless of the selection size — and no id array to ship.
    expect(Object.keys(done).sort()).toEqual(PROGRESS_KEYS);
    expect(JSON.stringify(done).length).toBeLessThan(300);

    // Undo still reverses the whole scope, which is where the ids live now.
    const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
    const undoJob = await waitForJob(undone.jobId!);
    expect(undoJob.updated).toBe(COUNT + 3);
  });

  it("keeps a settled job's undo scope out of the Map once the undo window closes", async () => {
    // Memory hygiene: the undo scope is dead weight once the window expires
    // (undoBatchJob answers "expired" without reading it), and the Map holds a
    // job for the full TTL, so a sweep on the next create drops it. The scope
    // is server-private, so the only honest assertion is that the sweep is
    // invisible: the job still polls, and undo still answers "expired".
    let now = 1_700_000_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const created = createBatchJob({ kind: "flags", patch: { seen: true }, query: inboxQuery }, { db, masterKey, oauthService: undefined });
      await waitForJob(created.id);

      // Inside the window: a create sweeps the Map but must not touch a scope
      // that undo can still read.
      createBatchJob({ kind: "flags", patch: { flagged: true }, query: inboxQuery }, { db, masterKey, oauthService: undefined });
      const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
      expect(undone.ok).toBe(true);
      expect((await waitForJob(undone.jobId!)).updated).toBe(3);

      // Past the window: the same create-sweep runs, and the job is still
      // pollable but permanently un-undoable — exactly as before the sweep.
      const expiring = createBatchJob({ kind: "flags", patch: { seen: true }, query: inboxQuery }, { db, masterKey, oauthService: undefined });
      await waitForJob(expiring.id);
      now += 6 * 60_000;
      createBatchJob({ kind: "flags", patch: { seen: true }, query: inboxQuery }, { db, masterKey, oauthService: undefined });
      expect(getBatchJobSnapshot(expiring.id)).toMatchObject({ status: "completed", updated: 3 });
      expect(undoBatchJob(expiring.id, { db, masterKey, oauthService: undefined })).toEqual({ ok: false, reason: "expired" });
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("forgets a job once its TTL prunes it", async () => {
    let now = 1_700_000_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const created = createBatchJob({ kind: "flags", patch: { seen: true }, query: inboxQuery }, { db, masterKey, oauthService: undefined });
      await waitForJob(created.id);
      expect(getBatchJobSnapshot(created.id)).not.toBeNull();

      // Past the TTL, the next create sweeps it; a progress poll for a job the
      // server has forgotten is a 404, the same as an unknown id.
      now += 16 * 60_000;
      const next = createBatchJob({ kind: "flags", patch: { seen: true }, query: inboxQuery }, { db, masterKey, oauthService: undefined });
      expect(next.id).not.toBe(created.id);
      expect(getBatchJobSnapshot(created.id)).toBeNull();
      expect(undoBatchJob(created.id, { db, masterKey, oauthService: undefined })).toEqual({ ok: false, reason: "not_found" });
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("moves a predicate selection with aggregated batch calls and restores it on undo", async () => {
    const created = createBatchJob({ kind: "move", target: "trash", query: inboxQuery }, { db, masterKey, oauthService: undefined });
    const done = await waitForJob(created.id);

    expect(done.status).toBe("completed");
    expect(done.updated).toBe(3);
    expect(done.failed).toBe(0);
    // One connection and one MOVE command served all three messages instead
    // of one connection per message.
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.messageMove).toHaveBeenCalledWith([42, 43, 44], "Trash", { uid: true });
    for (const id of ["message-1", "message-2", "message-3"]) {
      expect(db.prepare("SELECT mailbox FROM messages WHERE id = ?").get(id)).toEqual({ mailbox: "Trash" });
    }
    // The job's connection is handed back when the job settles.
    expect(client.logout).toHaveBeenCalledTimes(1);

    const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
    expect(undone.ok).toBe(true);
    const undoJob = await waitForJob(undone.jobId!);
    expect(undoJob.updated).toBe(3);
    expect(undoJob.failed).toBe(0);
    for (const id of ["message-1", "message-2", "message-3"]) {
      expect(db.prepare("SELECT mailbox FROM messages WHERE id = ?").get(id)).toEqual({ mailbox: "INBOX" });
    }
  });

  it("applies a flags job to the whole predicate scope and flips only changed ids on undo", async () => {
    const created = createBatchJob({ kind: "flags", patch: { seen: true }, query: inboxQuery }, { db, masterKey, oauthService: undefined });
    const done = await waitForJob(created.id);

    expect(done.status).toBe("completed");
    expect(done.updated).toBe(3);
    for (const id of ["message-1", "message-2", "message-3"]) {
      const row = db.prepare("SELECT flags_json FROM messages WHERE id = ?").get(id) as { flags_json: string };
      expect(JSON.parse(row.flags_json)).toContain("\\Seen");
    }

    const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
    expect(undone.ok).toBe(true);
    const undoJob = await waitForJob(undone.jobId!);
    expect(undoJob.updated).toBe(3);
    for (const id of ["message-1", "message-2", "message-3"]) {
      const row = db.prepare("SELECT flags_json FROM messages WHERE id = ?").get(id) as { flags_json: string };
      expect(JSON.parse(row.flags_json)).not.toContain("\\Seen");
    }
  });

  it("resolves a scope=all selection across every account and mailbox", async () => {
    // A second account with an inbox hit and a non-inbox hit; both must be
    // selected by a global search while the plain q stays inbox-scoped.
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-2", "account-2@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", new Date().toISOString());
    const now = new Date().toISOString();
    const insertGlobal = (id: string, uid: number, mailbox: string, subject: string) => {
      db.prepare(`
        INSERT INTO messages (
          id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
          sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, "account-2", mailbox, uid, subject, "Demo", "account-2@example.com", "[]", now, "", "", "", JSON.stringify([]), 0, 0, now);
      indexMessageFts(db, id, { subject, fromName: "Demo", fromAddress: "account-2@example.com", textBody: "" });
    };
    insertGlobal("global-inbox", 10, "INBOX", "Quarterly figures");
    insertGlobal("global-projects", 11, "Projects", "Quarterly figures");

    const scoped = createBatchJob(
      { kind: "flags", patch: { flagged: true }, query: { q: "Quarterly" } },
      { db, masterKey, oauthService: undefined },
    );
    const scopedDone = await waitForJob(scoped.id);
    expect(scopedDone.status).toBe("completed");
    expect(scopedDone.updated).toBe(1);
    // The unscoped query hit one message; the message outside the scope never
    // got the flag and must not be reversed by undo either.
    const flagsOf = (id: string) =>
      JSON.parse((db.prepare("SELECT flags_json FROM messages WHERE id = ?").get(id) as { flags_json: string }).flags_json) as string[];

    const global = createBatchJob(
      { kind: "flags", patch: { seen: true }, query: { q: "Quarterly", scope: "all" } },
      { db, masterKey, oauthService: undefined },
    );
    const globalDone = await waitForJob(global.id);
    expect(globalDone.status).toBe("completed");
    expect(globalDone.updated).toBe(2);
    expect(flagsOf("global-inbox")).toEqual(expect.arrayContaining(["\\Flagged", "\\Seen"]));
    expect(flagsOf("global-projects")).toEqual(["\\Seen"]);

    // The undo scope of the scoped job is exactly the one message it changed —
    // proven by the reverse, not by an id list in the progress payload.
    const scopedUndo = undoBatchJob(scoped.id, { db, masterKey, oauthService: undefined });
    expect(scopedUndo.ok).toBe(true);
    expect((await waitForJob(scopedUndo.jobId!)).updated).toBe(1);
    expect(flagsOf("global-inbox")).toEqual(["\\Seen"]);
    expect(flagsOf("global-projects")).toEqual(["\\Seen"]);

    const globalUndo = undoBatchJob(global.id, { db, masterKey, oauthService: undefined });
    expect((await waitForJob(globalUndo.jobId!)).updated).toBe(2);
    expect(flagsOf("global-inbox")).toEqual([]);
    expect(flagsOf("global-projects")).toEqual([]);
  });

  it("resolves an Attachments-view selection by the attachment flag alone", async () => {
    // No accountId or folder: the Attachments view crosses every account and
    // mailbox and only the has_attachments flag decides the candidate set.
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-2", "account-2@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", now);
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("attach-projects", "account-2", "Projects", 10, "Budget pdf", "Demo", "account-2@example.com", "[]", now, "", "", "", JSON.stringify([]), 1, 0, now);
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("plain-projects", "account-2", "Projects", 11, "Plain note", "Demo", "account-2@example.com", "[]", now, "", "", "", JSON.stringify([]), 0, 0, now);

    const created = createBatchJob(
      { kind: "flags", patch: { seen: true }, query: { hasAttachments: true } },
      { db, masterKey, oauthService: undefined },
    );
    const done = await waitForJob(created.id);
    expect(done.status).toBe("completed");
    expect(done.updated).toBe(1);
    expect(db.prepare("SELECT flags_json FROM messages WHERE id = ?").get("plain-projects")).toEqual({ flags_json: "[]" });

    const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
    expect(undone.ok).toBe(true);
    const undoJob = await waitForJob(undone.jobId!);
    expect(undoJob.updated).toBe(1);
  });

  it("leaves a message alone on undo when the user re-moved it after the job", async () => {
    const created = createBatchJob({ kind: "move", target: "trash", query: inboxQuery }, { db, masterKey, oauthService: undefined });
    await waitForJob(created.id);
    // The user manually re-moved message-2 to a label folder after the job.
    db.prepare("UPDATE messages SET mailbox = ? WHERE id = ?").run("Projects", "message-2");

    const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
    expect(undone.ok).toBe(true);
    const undoJob = await waitForJob(undone.jobId!);
    expect(undoJob.updated).toBe(3);
    expect(undoJob.failed).toBe(0);
    // message-2 stays where the user put it; the untouched two come back.
    expect(db.prepare("SELECT mailbox FROM messages WHERE id = ?").get("message-2")).toEqual({ mailbox: "Projects" });
    expect(db.prepare("SELECT mailbox FROM messages WHERE id = ?").get("message-1")).toEqual({ mailbox: "INBOX" });
    expect(db.prepare("SELECT mailbox FROM messages WHERE id = ?").get("message-3")).toEqual({ mailbox: "INBOX" });
  });

  it("counts idempotent moves (already in the target folder) as updated", async () => {
    // A re-delete inside the Trash view: every matched message already lives
    // in the target folder. The job must count them as moved without issuing
    // any IMAP command, and undo must be a no-op too.
    db.prepare("UPDATE messages SET mailbox = 'Trash', uid = uid + 200 WHERE id IN (?, ?, ?)")
      .run("message-1", "message-2", "message-3");
    db.prepare("UPDATE folders SET total = 3 WHERE account_id = ? AND path = ?").run("account-1", "Trash");

    const created = createBatchJob({ kind: "move", target: "trash", query: { folder: "Trash" } }, { db, masterKey, oauthService: undefined });
    const done = await waitForJob(created.id);

    expect(done.updated).toBe(3);
    expect(done.failed).toBe(0);
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.messageMove).not.toHaveBeenCalled();

    const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
    expect(undone.ok).toBe(true);
    const undoJob = await waitForJob(undone.jobId!);
    expect(undoJob.updated).toBe(3);
    expect(undoJob.failed).toBe(0);
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it("pays one IMAP connection per account for a whole move job and its undo", { timeout: 20_000 }, async () => {
    // The cost this pins: a job used to dial and hang up on one connection per
    // 100-id chunk (~4s each on Gmail), so a 40 000-id selection paid 400 of
    // them for the move and then one *per message* for the undo. The count
    // that matters is per account, not per chunk: 500 ids of one account are
    // 5 chunks and must still be 1 connect.
    //
    // 500 rather than 40 000 so the case stays a fast gate on the property,
    // not a benchmark of it: at 5 chunks a per-chunk regression is 5 connects
    // and cannot hide behind "a few". The undo below is the expensive half
    // (one serial move per entry), which is also why the scale is modest.
    const COUNT = 500;
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, 'account-1', 'Projects', ?, 'Subject', 'Demo', 'demo@example.com', '[]', ?, '', '', '', ?, 0, 0, ?)
    `);
    db.transaction(() => {
      for (let i = 0; i < COUNT; i += 1) {
        insert.run(`conn-${i}`, 50_000 + i, now, JSON.stringify([]), now);
      }
    })();
    const opened = trackOpenedClients();

    const created = createBatchJob({ kind: "move", target: "trash", query: { folder: "Projects" } }, { db, masterKey, oauthService: undefined });
    const done = await waitForJob(created.id, "completed", 4000);

    expect(done.total).toBe(COUNT);
    expect(done.updated).toBe(COUNT);
    expect(done.failed).toBe(0);
    // Chunking is unchanged — 5 aggregated MOVE commands of 100 uids each —
    // only the connection is shared. If the commands ever collapse to one,
    // this stops proving that the count is per *account*.
    expect(opened).toHaveLength(1);
    expect(opened[0]!.messageMove).toHaveBeenCalledTimes(5);
    // One connect for the whole job...
    expect(opened[0]!.connect).toHaveBeenCalledTimes(1);
    // ...and it is handed back before the job reports itself completed, so a
    // settled job never leaves a socket open.
    expect(opened[0]!.logout).toHaveBeenCalledTimes(1);

    const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
    const undoJob = await waitForJob(undone.jobId!, "completed", 4000);

    // The undo keeps its per-message protocol — one MOVE per restored message,
    // because each entry has its own origin folder and its own intent to
    // claim — but it is one connection for all of them, released like any
    // other. The move job's connection is long gone by now: the undo opens a
    // second one rather than reusing a released session.
    expect(undoJob.updated).toBe(COUNT);
    expect(undoJob.failed).toBe(0);
    expect(opened).toHaveLength(2);
    expect(opened[1]!.connect).toHaveBeenCalledTimes(1);
    expect(opened[1]!.messageMove).toHaveBeenCalledTimes(COUNT);
    expect(opened[1]!.logout).toHaveBeenCalledTimes(1);
    // Every connection either job opened was logged out exactly once.
    for (const connection of opened) {
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(connection.logout).toHaveBeenCalledTimes(1);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox = 'Projects'").get()).toEqual({ count: COUNT });
  });

  it("drops a shared connection after a failed undo entry instead of failing the rest", async () => {
    // The undo reuses one connection for every entry, so a connection that
    // failed one entry must be dropped: otherwise one bad socket fails the
    // whole remaining scope, where the per-message connection it replaced cost
    // exactly one message. The provider refusing one MOVE is the observable
    // shape of that — the entry fails, and the next entry still gets a live
    // connection and still moves.
    const opened = trackOpenedClients((entry, index) => {
      // Index 0 is the move job's connection; index 1 is the undo's first, and
      // the one whose single message the provider refuses.
      if (index === 1) entry.messageMove.mockResolvedValue(null as never);
    });

    const created = createBatchJob({ kind: "move", target: "trash", query: inboxQuery }, { db, masterKey, oauthService: undefined });
    const done = await waitForJob(created.id);
    expect(done.updated).toBe(3);
    expect(opened).toHaveLength(1);

    const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
    const undoJob = await waitForJob(undone.jobId!);

    // Accounting is per entry, unchanged: the refused one fails, the other two
    // are restored, and every entry still advances `done`.
    expect(undoJob.updated).toBe(2);
    expect(undoJob.failed).toBe(1);
    expect(undoJob.done).toBe(3);
    expect(db.prepare("SELECT mailbox FROM messages WHERE id = 'message-1'").get()).toEqual({ mailbox: "Trash" });
    expect(db.prepare("SELECT mailbox FROM messages WHERE id = 'message-2'").get()).toEqual({ mailbox: "INBOX" });
    expect(db.prepare("SELECT mailbox FROM messages WHERE id = 'message-3'").get()).toEqual({ mailbox: "INBOX" });
    // Three connections: the job's, the undo's refused one (dropped, not
    // reused), and the one that carried the remaining two entries — not one
    // per message, and not one poisoned connection for all of them.
    expect(opened).toHaveLength(3);
    for (const connection of opened) {
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(connection.logout).toHaveBeenCalledTimes(1);
    }
  });

  it("logs a job's connection out even when the job dies mid-flight", { timeout: 20_000 }, async () => {
    // Hoisting the connection to job scope means the job now owns a socket
    // that outlives a single batch, so a job that throws between chunks must
    // still hand it back — otherwise every failed job leaks a connection and
    // the next one dials another.
    //
    // 150 ids is two chunks of different sizes (100 and 50) so the throw lands
    // on the *second* chunk's row lookup: a second chunk of the same size would
    // reuse the compiled statement and never reach `prepare` at all. The
    // lookup is the first statement of a batch and sits outside the per-group
    // guard, so its failure ends the job instead of one message's.
    const COUNT = 150;
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, 'account-1', 'Projects', ?, 'Subject', 'Demo', 'demo@example.com', '[]', ?, '', '', '', ?, 0, 0, ?)
    `);
    db.transaction(() => {
      for (let i = 0; i < COUNT; i += 1) {
        insert.run(`dead-${i}`, 60_000 + i, now, JSON.stringify([]), now);
      }
    })();
    const opened = trackOpenedClients();

    const prepare = db.prepare.bind(db);
    let rowLookups = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("SELECT id, account_id, mailbox, uid") && rowLookups++ >= 1) {
        throw new Error("cache is gone");
      }
      return prepare(sql);
    });

    const created = createBatchJob({ kind: "move", target: "trash", query: { folder: "Projects" } }, { db, masterKey, oauthService: undefined });
    const done = await waitForJob(created.id, "failed", 400);

    expect(done.status).toBe("failed");
    expect(done.error).toBe("cache is gone");
    // The first chunk completed before the job died, so the job really did
    // reach the provider with the connection it then had to release.
    expect(done.updated).toBe(100);
    expect(done.done).toBe(100);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.connect).toHaveBeenCalledTimes(1);
    expect(opened[0]!.logout).toHaveBeenCalledTimes(1);
  });

  it("looks up move origins in bounded chunks instead of one giant IN list", { timeout: 20_000 }, async () => {
    // A predicate-scoped selection has no row cap, so the origin snapshot must
    // be split: the driver rejects a statement with more bound variables than
    // its ceiling, and a 40 000-message "select all" used to fail the whole job
    // at 0% with the raw SQL in the toast. 2500 ids must therefore be looked up
    // as 1000 + 1000 + 500.
    //
    // The two counts below are the whole contract, and they are deliberately
    // different numbers:
    //   * bound per call — 1000, 1000, 500: the selection really is split into
    //     three lookups, each far below the driver ceiling. Chunking did not
    //     quietly become one giant IN list again.
    //   * compiled once — 1000, 500: the two chunks of the same size run one
    //     prepared statement, so the job no longer re-runs sqlite3_prepare on
    //     SQL text that is byte-identical to what the chunk before it already
    //     compiled. Only the placeholder count is reused; the ids stay bound
    //     parameters, which is what the per-call counts above prove.
    // Asserting compiles alone would let a cache hide the chunking, and
    // asserting calls alone would let a regression recompile per chunk; the
    // pair is what pins the behaviour down.
    //
    // Budget: this case moves 2500 messages in 25 aggregated commands and then
    // undoes them one message at a time. 20s is >4x the worst load observed
    // with the rest of the suite on the machine. It runs on the raw handle on
    // purpose: a statement cache on the test side would hide all but the first
    // of the three chunk lookups from the `db.prepare` spy this case is built
    // on.
    const COUNT = 2500;
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, 'account-1', 'Projects', ?, 'Subject', 'Demo', 'demo@example.com', '[]', ?, '', '', '', ?, 0, 0, ?)
    `);
    db.transaction(() => {
      for (let i = 0; i < COUNT; i += 1) {
        insert.run(`chunk-${i}`, 1000 + i, now, JSON.stringify([]), now);
      }
    })();

    const compiled: string[] = [];
    const boundPerCall: number[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("SELECT id, mailbox FROM messages WHERE id IN")) return statement;
      compiled.push(sql);
      // Count the values each lookup actually binds, not just how many
      // statements were compiled: a reused statement is invisible to the
      // `prepare` spy but still runs.
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property === "all") {
            return (...params: unknown[]) => {
              boundPerCall.push(params.length);
              return (target.all as (...args: unknown[]) => unknown[])(...params);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    const created = createBatchJob({ kind: "move", target: "trash", query: { folder: "Projects" } }, { db, masterKey, oauthService: undefined });
    const done = await waitForJob(created.id, "completed", 2000);

    expect(done.total).toBe(COUNT);
    expect(done.updated).toBe(COUNT);
    // Three lookups, in the chunk sizes the selection actually splits into.
    expect(boundPerCall).toEqual([1000, 1000, 500]);
    // ...served by one compiled statement per distinct size, never more.
    expect(compiled.map((sql) => (sql.match(/\?/g) ?? []).length)).toEqual([1000, 500]);
    for (const sql of compiled) {
      expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1000);
    }

    // Undo still restores every origin mailbox, which is what the chunked
    // lookup exists for.
    const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
    const undoJob = await waitForJob(undone.jobId!, "completed", 2000);
    expect(undoJob.updated).toBe(COUNT);
    expect(undoJob.failed).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox = 'Projects'").get()).toEqual({ count: COUNT });
  });

  it("compiles each per-message move statement once for a whole 2500-row job", { timeout: 20_000 }, async () => {
    // The job above proved the *origin snapshot* compiles once per chunk shape.
    // This is the other half: the six statements `moveMessagesInOneCommand`
    // issued per message. Compiled at the point of use, a 2500-row selection
    // paid ~15 000 `sqlite3_prepare` calls for SQL text that is byte-identical
    // every time (measured on a 40 000-row selection: 240 000 calls, 4.6s).
    // They are now compiled once per connection and replayed, so the compile
    // count must be a function of the *statements*, never of the rows.
    //
    // This is the case that can actually see it: it runs on the raw handle, so
    // the `db.prepare` spy observes every compile the job issues. The
    // 40 000-row case below runs through `memoizingDb`, which would hide the
    // difference entirely.
    //
    // Three assertions, deliberately redundant. `counts` pins the exact number
    // of compiles per statement, so a regression names the statement that
    // started recompiling; `unnamed` says *no* SQL the job issues is compiled
    // more than once beyond the one shape the previous case documents, so a
    // new per-message statement is caught even though this test has never heard
    // of it; and `compiled` is the whole job's total, so two statements
    // recompiling together cannot hide behind the per-name map.
    const COUNT = 2500;
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, 'account-1', 'Projects', ?, 'Subject', 'Demo', 'demo@example.com', '[]', ?, '', '', '', '[]', 0, 0, ?)
    `);
    db.transaction(() => {
      for (let i = 0; i < COUNT; i += 1) insert.run(`permsg-${i}`, 2000 + i, now, now);
    })();

    // Distinctive fragments of the statements the move path owns, keyed by a
    // name the failure can print. Whitespace is normalized first: the count
    // is the contract, not the indentation.
    const SHAPES: Record<string, string> = {
      "batch row lookup": "SELECT id, account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id IN (",
      "origin snapshot chunk": "SELECT id, mailbox FROM messages WHERE id IN (",
      "begin move intent": "SET pending_move_destination = ?, pending_move_state = 'intent', pending_move_candidate_uid = ?",
      "clear move intent": "SET pending_move_destination = NULL, pending_move_state = NULL",
      "uidplus duplicate read": "SELECT id, mailbox, uid, remote_id_lookup, flags_json, all_mail_archived FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ? AND id <> ?",
      "uidplus duplicate delete": "DELETE FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ? AND id <> ?",
      "uidplus confirm": "SET mailbox = ?, uid = ?, all_mail_archived = ?, pending_move_destination = NULL",
      "decrease folder count": "total = CASE WHEN total > 0 THEN total - 1 ELSE 0 END",
      "increase folder count": "SET total = total + 1, unseen = unseen + ?",
      "account read": "SELECT * FROM accounts WHERE id = ?",
      "destination lookup": "SELECT path, special_use FROM folders WHERE account_id = ? AND special_use IN (",
    };
    const counts = new Map<string, number>();
    const bySql = new Map<string, number>();
    const compile = db.prepare.bind(db);
    let compiled = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      compiled += 1;
      const normalized = sql.replace(/\s+/g, " ").trim();
      bySql.set(normalized, (bySql.get(normalized) ?? 0) + 1);
      for (const [name, fragment] of Object.entries(SHAPES)) {
        if (normalized.includes(fragment)) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return compile(sql);
    });

    const created = createBatchJob({ kind: "move", target: "trash", query: { folder: "Projects" } }, { db, masterKey, oauthService: undefined });
    const done = await waitForJob(created.id, "completed", 2000);

    expect(done.total).toBe(COUNT);
    expect(done.updated).toBe(COUNT);
    // One compile per statement the job actually ran, however many rows it ran
    // it on. The row lookup is one width (MOVE_CHUNK_SIZE) across all 25 calls,
    // and the account read and the destination lookup are the two statements
    // that used to be rebuilt per (account, mailbox) group — 25 groups, 25
    // compiles each, 50 of the job's 61 prepares for byte-identical SQL.
    expect(Object.fromEntries(counts)).toEqual({
      "batch row lookup": 1,
      "origin snapshot chunk": 2,
      "begin move intent": 1,
      "clear move intent": 1,
      "uidplus duplicate read": 1,
      "uidplus duplicate delete": 1,
      "uidplus confirm": 1,
      "decrease folder count": 1,
      "increase folder count": 1,
      "account read": 1,
      "destination lookup": 1,
    });
    // ...and no statement this test does not name is recompiling either. The
    // origin snapshot is the one exception, and only because the previous case
    // documents it: it compiles once per chunk *shape* (1000 and 500), which is
    // two, not 25. Everything else in the job must appear exactly once.
    expect([...counts].filter(([name, count]) => count > 1 && name !== "origin snapshot chunk")).toEqual([]);
    // The same floor stated over the *raw* SQL rather than the shapes above, so
    // a statement this test has never heard of is caught too. Only the two
    // origin-snapshot widths may exceed one, and that is the documented case.
    const originSnapshot = "SELECT id, mailbox FROM messages WHERE id IN (";
    expect([...bySql].filter(([sql, count]) => count > 1 && !sql.startsWith(originSnapshot))).toEqual([]);
    // The whole job: scope query, two snapshot widths, the row lookup, the two
    // per-group reads and the six move statements — 13 prepares for 2500 rows.
    // A per-group regression in either of the two per-group readers puts this
    // back at 61; a per-message one puts it above 15 000.
    expect(compiled).toBe(13);
  });

  it("moves a selection larger than the SQLite variable ceiling", { timeout: 30_000 }, async () => {
    // The regression this chunking exists for: 32 766 ids compile, 40 000 throw
    // "too many SQL variables", and a predicate-scoped selection is unbounded.
    //
    // This runs the real thing: a real 40 000-message move job, a real chunked
    // origin snapshot, 40 000 real row rewrites. What it does not do is pay for
    // work that is not the subject under test. The fixture is built by one
    // recursive-CTE INSERT instead of 40 000 single-row runs (383ms -> 148ms);
    // the SQL text, the bound variables, the driver's variable ceiling and
    // every write are exactly what the unguarded job issued.
    //
    // Budget: ~2.6s isolated (2.60s through `memoizingDb`, 2.64s on the raw
    // handle — the bundle means there is nothing left for that cache to hide)
    // and ~5.7s with 115 other workers on the machine, so the 30s ceiling is
    // >5x the worst load observed and never the binding constraint — a real
    // regression still fails here, a loaded CI box does not.
    const COUNT = 40_000;
    const now = new Date().toISOString();
    db.prepare(`
      WITH RECURSIVE seq(i) AS (
        SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ?
      )
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      )
      SELECT
        'bulk-' || i, 'account-1', 'Projects', 100000 + i,
        'Subject', 'Demo', 'demo@example.com', '[]',
        ?, '', '', '', '[]', 0, 0, ?
      FROM seq
    `).run(COUNT, now, now);

    const created = createBatchJob({ kind: "move", target: "trash", query: { folder: "Projects" } }, { db: memoizingDb(db), masterKey, oauthService: undefined });
    const done = await waitForJob(created.id, "completed", 20_000);

    // Read back through the raw handle: the ids really were resolved from 40 000
    // rows, the job really did complete, and the cache really did end up with
    // 40 000 rows in the destination.
    expect(done.error).toBeUndefined();
    expect(done.status).toBe("completed");
    expect(done.total).toBe(COUNT);
    expect(done.updated).toBe(COUNT);
    expect(done.failed).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox = 'Trash'").get()).toEqual({ count: COUNT });
  });

  it("opens the undo window when the job completes, not when it was created", async () => {    let now = 1_700_000_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    // Hold the first STORE open so the job spans longer than the undo window
    // measured from its creation.
    let releaseStore: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseStore = resolve; });
    client.messageFlagsAdd.mockImplementationOnce(async () => { await gate; });

    const created = createBatchJob({ kind: "flags", patch: { seen: true }, query: inboxQuery }, { db, masterKey, oauthService: undefined });
    // Let the job start and block on the STORE gate, then let more than the
    // undo window pass before it finishes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    now += 6 * 60_000;
    releaseStore();
    await waitForJob(created.id);

    // Undo is still within the window measured from completion (0 minutes),
    // even though the job outlived the window measured from creation.
    const undone = undoBatchJob(created.id, { db, masterKey, oauthService: undefined });
    expect(undone.ok).toBe(true);
    await waitForJob(undone.jobId!);
    // A second job completes right away; once the window since ITS completion
    // passes, undo must expire.
    const after = createBatchJob({ kind: "flags", patch: { seen: true }, query: inboxQuery }, { db, masterKey, oauthService: undefined });
    await waitForJob(after.id);
    now += 6 * 60_000;
    expect(undoBatchJob(after.id, { db, masterKey, oauthService: undefined })).toEqual({ ok: false, reason: "expired" });
    dateSpy.mockRestore();
  });
});

