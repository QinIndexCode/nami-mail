import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

/**
 * The two move routes, after they stopped talking to the provider.
 *
 * Both entries used to run the MOVE inside the request: the reply waited for
 * `operationQueue.enqueueAndRun`, which dialled IMAP, and *then* kicked a
 * background reconcile for the accounts whose outcome the server could not
 * confirm. They answer from the task layer now -- one transaction commits every
 * selected message's goal plus one durable task per account, and the task
 * delivers it -- so what these tests pin is the contract that changed, in the
 * three places a caller can see it:
 *
 *   1. **the reply is off the provider's critical path.** The account's write slot
 *      is held for the whole test, so the runner cannot take a single step, and
 *      the message's goal is nevertheless committed and the reply already sent.
 *      That is the whole point of the switch (I2): a 40 000-id delete answers in
 *      milliseconds instead of after 400 MOVE commands.
 *   2. **the keys.** The single route keeps `{ok, destination, refreshPending}`
 *      and *adds* `{taskId, status}` only when a task was actually committed; the
 *      batch route's set is frozen at `{ok, updated, failed, failures}`. Nothing
 *      was removed (§4.6 "响应体只增不改"), which is why the three keys that
 *      described the provider's answer -- `uid`, `uncertain`, `locationUnverified`
 *      -- are simply absent rather than re-spelled.
 *   3. **the refusals.** Every local refusal stays a 422 whose message is the
 *      exact sentence the legacy path threw for that reason, which is what makes
 *      the switch invisible to the renderer (§0.4 十五 W3).
 *
 * The socket is the only collaborator replaced, and deliberately so:
 * `batchMoveMessages` -- the provider command itself -- stays the production
 * implementation, so "the request never reached the provider" is asserted against
 * the real seam rather than against a stand-in for it.
 */

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { acquireAccountWriteSlots } from "../src/sync-locks.js";

const MASTER_KEY = Buffer.alloc(32, 0x2b);

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `${id}@example.com`,
    "custom",
    "Demo",
    "encrypted",
    "imap.example.com",
    993,
    1,
    "smtp.example.com",
    465,
    1,
    "email",
    "connected",
    new Date().toISOString(),
  );
}

function insertFolder(db: DatabaseHandle, accountId: string, path: string, specialUse: string): void {
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
    .run(accountId, path, path, specialUse);
}

function insertMessage(db: DatabaseHandle, id: string, accountId: string, uid: number, mailbox = "INBOX"): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, accountId, mailbox, uid, "Subject", "Sender", "sender@example.com", "[]",
    new Date().toISOString(), "", "", "", JSON.stringify([]), 0, 0, new Date().toISOString(),
  );
}

const goalOf = (db: DatabaseHandle, id: string): string | null =>
  (db.prepare("SELECT pending_move_destination AS destination FROM messages WHERE id = ?").get(id) as
    | { destination: string | null }
    | undefined)?.destination ?? null;

const taskRows = (db: DatabaseHandle): Array<{ id: string; kind: string; account_id: string; status: string }> =>
  db.prepare("SELECT id, kind, account_id, status FROM tasks ORDER BY account_id").all() as Array<{
    id: string;
    kind: string;
    account_id: string;
    status: string;
  }>;

const itemIds = (db: DatabaseHandle, taskId: string): string[] =>
  (db.prepare("SELECT message_id FROM task_items WHERE task_id = ? ORDER BY rowid").all(taskId) as Array<{ message_id: string }>)
    .map((row) => row.message_id);

describe("POST /api/messages/:id/move, answered from the task layer", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  /** Held by the test, not by the app: nothing the runner needs can run. */
  let releaseSlots: Array<() => void> = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
    insertAccount(db, "account-2");
    insertFolder(db, "account-1", "INBOX", "\\Inbox");
    insertFolder(db, "account-1", "Archive", "\\Archive");
    insertFolder(db, "account-2", "INBOX", "\\Inbox");
    app = await buildApp({ db, masterKey: MASTER_KEY });
    releaseSlots = await acquireAccountWriteSlots(["account-1", "account-2"]);
  });

  afterEach(async () => {
    for (const release of releaseSlots) release();
    releaseSlots = [];
    if (app) await app.close();
    if (db) db.close();
  });

  it("commits the goal and returns the task id while the account's write slot is still held", async () => {
    insertMessage(db, "message-1", "account-1", 1);

    const response = await app.inject({
      method: "POST",
      url: "/api/messages/message-1/move",
      payload: { target: "archive" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; destination: string; refreshPending: boolean; taskId?: string; status?: string };
    expect(body).toMatchObject({ ok: true, destination: "Archive", refreshPending: true, status: "pending" });
    expect(typeof body.taskId).toBe("string");
    // The keys the provider's answer used to carry are gone, not renamed. The
    // renderer reads all three as optional and treats an absent `uid` as "keep
    // the local one" (§0.4 十五 W2).
    expect(Object.keys(body).sort()).toEqual(["destination", "ok", "refreshPending", "status", "taskId"]);
    // Local-first: the target state the renderer will reconcile against is
    // already committed, and the provider has not been asked for anything.
    expect(goalOf(db, "message-1")).toBe("Archive");
    expect(imapClientForAccount).not.toHaveBeenCalled();
    const [task] = taskRows(db);
    expect(task).toMatchObject({ id: body.taskId, kind: "move", account_id: "account-1" });
    expect(itemIds(db, task!.id)).toEqual(["message-1"]);
  });

  it("answers a message already at the destination with no pending refresh", async () => {
    // The slice still commits its task -- one task per account slice is the shape
    // every entry shares, and the row is what carries the slice's `total` -- but
    // that task has nothing to deliver, so `refreshPending` is false. Legacy
    // answered this case `false` too (`moveMessage`'s arrived-message branch),
    // and reading the goal count rather than the task count is what keeps it that
    // way (§0.4 十五 W2).
    insertMessage(db, "message-1", "account-1", 1, "Archive");

    const response = await app.inject({
      method: "POST",
      url: "/api/messages/message-1/move",
      payload: { target: "archive" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { destination: string; refreshPending: boolean; taskId?: string };
    expect(body).toMatchObject({ ok: true, destination: "Archive", refreshPending: false });
    expect(typeof body.taskId).toBe("string");
    expect(goalOf(db, "message-1")).toBeNull();
    // The task exists and has nothing to send: its whole selection is the settled
    // row, which is `changed = 0`, so the runner returns before dialling.
    const [task] = taskRows(db);
    expect(itemIds(db, task!.id)).toEqual(["message-1"]);
    expect(imapClientForAccount).not.toHaveBeenCalled();
  });

  it("refuses an unknown id in the sentence the legacy path threw, and commits nothing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/messages/missing-message/move",
      payload: { target: "archive" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ ok: false, code: "unprocessable", message: "Message not found." });
    expect(taskRows(db)).toEqual([]);
  });

  it("answers an account with no folder for the target with that target's own sentence", async () => {
    // account-2 has no archive folder. The wording is the same string
    // `moveActionErrorMessage` shipped for this case, read from the target table
    // both then and now (§0.4 十五 W3).
    insertMessage(db, "message-2", "account-2", 1);

    const response = await app.inject({
      method: "POST",
      url: "/api/messages/message-2/move",
      payload: { target: "archive" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      code: "unprocessable",
      message: "这个邮箱没有提供可用的归档文件夹。",
    });
    expect(goalOf(db, "message-2")).toBeNull();
  });
});

describe("POST /api/messages/batch/move, answered from the task layer", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  let releaseSlots: Array<() => void> = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
    insertAccount(db, "account-2");
    insertFolder(db, "account-1", "INBOX", "\\Inbox");
    insertFolder(db, "account-1", "Archive", "\\Archive");
    insertFolder(db, "account-2", "INBOX", "\\Inbox");
    insertFolder(db, "account-2", "Archive", "\\Archive");
    app = await buildApp({ db, masterKey: MASTER_KEY });
    releaseSlots = await acquireAccountWriteSlots(["account-1", "account-2"]);
  });

  afterEach(async () => {
    for (const release of releaseSlots) release();
    releaseSlots = [];
    if (app) await app.close();
    if (db) db.close();
  });

  it("commits one task per affected account, each holding its own slice, and freezes the key set", async () => {
    insertMessage(db, "message-1", "account-1", 1);
    insertMessage(db, "message-2", "account-1", 2);
    insertMessage(db, "message-3", "account-2", 1);

    const response = await app.inject({
      method: "POST",
      url: "/api/messages/batch/move",
      payload: { ids: ["message-1", "message-2", "message-3"], target: "archive" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["failed", "failures", "ok", "updated"]);
    // `updated` counts every id whose goal is now in force -- no per-id echo, and
    // no "pending" account list: the reconcile is each task's own business now.
    expect(body).toEqual({ ok: true, updated: 3, failed: 0, failures: [] });
    expect(imapClientForAccount).not.toHaveBeenCalled();

    const tasks = taskRows(db);
    expect(tasks.map((task) => task.account_id)).toEqual(["account-1", "account-2"]);
    expect(itemIds(db, tasks[0]!.id)).toEqual(["message-1", "message-2"]);
    expect(itemIds(db, tasks[1]!.id)).toEqual(["message-3"]);
    expect(goalOf(db, "message-3")).toBe("Archive");
  });

  it("reports a refused id with the sentence that reason has always been answered in", async () => {
    // message-1 is already in the archive (done, and counted as such);
    // message-2 belongs to an account with no archive (refused, in the target's
    // words); the third id has no row at all. No provider call is possible for
    // any of the three: a settled selection and a refused one both leave their
    // task with nothing to send.
    insertMessage(db, "message-1", "account-1", 1, "Archive");
    insertAccount(db, "account-3");
    insertFolder(db, "account-3", "INBOX", "\\Inbox");
    insertMessage(db, "message-2", "account-3", 1);

    const response = await app.inject({
      method: "POST",
      url: "/api/messages/batch/move",
      payload: { ids: ["message-1", "message-2", "missing-message"], target: "archive" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      updated: 1,
      failed: 2,
      failures: [
        { id: "message-2", message: "这个邮箱没有提供可用的归档文件夹。" },
        { id: "missing-message", message: "Message not found." },
      ],
    });
  });
});
