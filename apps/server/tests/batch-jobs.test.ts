import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
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
  async function waitForJob(jobId: string, status: "completed" | "failed" = "completed") {
    for (let i = 0; i < 200; i += 1) {
      const snapshot = getBatchJobSnapshot(jobId);
      if (snapshot && snapshot.status === status) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Job ${jobId} did not settle as ${status}`);
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
    expect(done.changedIds).toEqual(["message-1", "message-2", "message-3"]);
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
    expect(scopedDone.changedIds).toEqual(["global-inbox"]);

    const global = createBatchJob(
      { kind: "flags", patch: { seen: true }, query: { q: "Quarterly", scope: "all" } },
      { db, masterKey, oauthService: undefined },
    );
    const globalDone = await waitForJob(global.id);
    expect(globalDone.status).toBe("completed");
    expect(globalDone.updated).toBe(2);
    expect(globalDone.changedIds.sort()).toEqual(["global-inbox", "global-projects"]);
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

  it("opens the undo window when the job completes, not when it was created", async () => {
    let now = 1_700_000_000_000;
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
