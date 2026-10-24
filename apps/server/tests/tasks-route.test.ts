import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { recordTask, TASK_TERMINAL_ROW_TTL_MS, taskRow } from "../src/tasks/index.js";
// Not on the layer's published surface, and deliberately so: ending a task is the
// scheduler's job, and nothing outside the layer settles one by hand. A test that
// needs a settled row says so by reaching past the surface.
import { settleTask } from "../src/tasks/store.js";

/**
 * `GET /api/tasks/:id` is a projection endpoint, and the two things worth
 * pinning are exactly the two things it is easy to get wrong: it must not
 * publish a sealed payload, and a missing row must be a 404 rather than an empty
 * success. The first has a control (`taskRow` shows the ciphertext IS stored) so
 * the negative assertion cannot pass by the payload simply being absent
 * everywhere.
 */
describe("GET /api/tasks/:id", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  const masterKey = Buffer.alloc(32, 0x71);

  beforeEach(async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    app = await buildApp({ db, masterKey });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("answers 404 with the owned code for an id it never held", async () => {
    const response = await app.inject({ method: "GET", url: "/api/tasks/no-such-task" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, code: "not_found", message: "任务不存在。" });
  });

  it("answers the public projection and never the sealed payload", async () => {
    const id = recordTask(db, masterKey, {
      accountId: "account-1",
      kind: "move",
      scope: "batch",
      items: [{ messageId: "message-1" }, { messageId: "message-2" }],
      payload: { target: { mailbox: "Archive" }, secret: "SENTINEL-PLAINTEXT" },
    });

    const response = await app.inject({ method: "GET", url: `/api/tasks/${id}` });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; task: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.task).toEqual({
      id,
      kind: "move",
      scope: "batch",
      status: "pending",
      total: 2,
      updated: 0,
      failed: 0,
    });
    // The key set, not just the values: a field added to the projection by
    // accident (the ciphertext, the fingerprint, the attempt bookkeeping) is a
    // wire change, and this is the assertion that notices.
    expect(Object.keys(body.task).sort()).toEqual(["failed", "id", "kind", "scope", "status", "total", "updated"]);
    expect(response.body).not.toContain("SENTINEL-PLAINTEXT");
    // Control: the payload IS stored, sealed. Without this the line above would
    // also pass for a task whose payload was silently dropped at write time.
    const stored = taskRow(db, id);
    expect(stored?.payload_ciphertext).toBeTruthy();
    expect(stored?.payload_ciphertext).not.toContain("SENTINEL-PLAINTEXT");
  });

  it("offers no undo deadline until the task it would undo has ended", async () => {
    // The window runs from `completed_at`, not from the record (`store.ts:407`), so a
    // pending row has nothing to offer yet: a deadline computed from `created_at`
    // would start the clock before the work did, and a task that took minutes would
    // hand the user a window that had already expired when it settled.
    const now = 1_700_000_000_000;
    const id = recordTask(db, masterKey, {
      accountId: "account-1",
      kind: "undo",
      undoWindowMs: 5 * 60 * 1000,
      now,
    });

    const pending = await app.inject({ method: "GET", url: `/api/tasks/${id}` });

    expect(pending.statusCode).toBe(200);
    expect(pending.json().task).toEqual({
      id,
      kind: "undo",
      scope: "single",
      status: "pending",
      total: 0,
      updated: 0,
      failed: 0,
    });
    // Control for the projection itself: the window IS stored (`recordTask` writes
    // `undo_window_ms`), so the absent key above is the deadline rule and not a
    // window that was dropped on the way in.
    expect(taskRow(db, id)?.undo_window_ms).toBe(5 * 60 * 1000);

    const completedAt = now + 90_000;
    settleTask(db, id, "completed", null, completedAt);

    const settled = await app.inject({ method: "GET", url: `/api/tasks/${id}` });
    expect(settled.json().task).toEqual({
      id,
      kind: "undo",
      scope: "single",
      status: "completed",
      total: 0,
      updated: 0,
      failed: 0,
      undoDeadline: completedAt + 5 * 60 * 1000,
    });
  });
});

/**
 * `GET /api/tasks` answers the delivery panel: two halves whose *selection* is
 * the whole contract. The assertions are therefore about membership and order --
 * which rows are in `syncing`, which are in `attention`, and which are in
 * neither -- plus the two boundaries that are easy to get subtly wrong: the
 * retention cutoff on the terminal half, and the cap on both.
 *
 * The rejected rows get as much attention as the accepted ones on purpose. A
 * completed task shown as a problem, or a cancelled one, would be the panel
 * crying wolf; a task that is still running but missing from `syncing` would be
 * the panel silently losing work.
 */
describe("GET /api/tasks", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  const masterKey = Buffer.alloc(32, 0x71);

  beforeEach(async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    app = await buildApp({ db, masterKey });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  // The wire row, spelled here rather than imported from the server's own
  // `DeliveryTask`: a test that read the production type could not notice the
  // projection renaming a field, which is the kind of change that breaks the
  // renderer silently.
  type TaskRowWire = {
    id: string;
    accountId: string;
    accountEmail: string | null;
    kind: string;
    scope: string;
    status: string;
    total: number;
    updated: number;
    failed: number;
    createdAt: number;
    completedAt: number | null;
    dueAt: number | null;
    error?: { code?: string; message?: string };
  };

  const list = async (): Promise<{ syncing: TaskRowWire[]; attention: TaskRowWire[] }> => {
    const response = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; syncing: TaskRowWire[]; attention: TaskRowWire[] };
    expect(body.ok).toBe(true);
    return body;
  };

  it("lists a running task with its account address, and no other key", async () => {
    const id = recordTask(db, masterKey, {
      accountId: "account-1",
      kind: "flags",
      scope: "batch",
      items: [{ messageId: "message-1" }],
      payload: { patch: { seen: true }, secret: "SENTINEL-PLAINTEXT" },
    });

    const body = await list();

    expect(body.syncing).toHaveLength(1);
    // `toEqual` and not `toMatchObject`: this projection is what a renderer reads
    // on a timer, so a field added by accident (the ciphertext, the fingerprint,
    // the attempt bookkeeping) is a wire change, and the equality is what makes
    // such an addition fail here.
    expect(body.syncing[0]).toEqual({
      id,
      accountId: "account-1",
      accountEmail: "account-1@example.com",
      kind: "flags",
      scope: "batch",
      status: "pending",
      total: 1,
      updated: 0,
      failed: 0,
      createdAt: expect.any(Number),
      completedAt: null,
      dueAt: null,
    });
    expect(body.attention).toEqual([]);
  });

  it("never publishes a sealed payload", async () => {
    recordTask(db, masterKey, {
      accountId: "account-1",
      kind: "flags",
      payload: { patch: { seen: true }, secret: "SENTINEL-PLAINTEXT" },
    });

    const response = await app.inject({ method: "GET", url: "/api/tasks" });

    expect(response.body).not.toContain("SENTINEL-PLAINTEXT");
    // Control: the payload IS stored, sealed. Without it the line above would
    // also pass for a task whose payload was dropped at write time.
    const stored = db.prepare("SELECT payload_ciphertext FROM tasks").get() as { payload_ciphertext: string | null };
    expect(stored.payload_ciphertext).toBeTruthy();
    expect(stored.payload_ciphertext).not.toContain("SENTINEL-PLAINTEXT");
  });

  it("orders the outstanding half oldest first, which is how the scheduler drains it", async () => {
    const older = recordTask(db, masterKey, { accountId: "account-1", kind: "flags", now: 1_000 });
    const newer = recordTask(db, masterKey, { accountId: "account-1", kind: "move", now: 2_000 });

    const body = await list();

    expect(body.syncing.map((task) => task.id)).toEqual([older, newer]);
  });

  it("moves a task out of the outstanding half when it ends, and reports it only if it did not deliver", async () => {
    const failed = recordTask(db, masterKey, { accountId: "account-1", kind: "flags" });
    const completed = recordTask(db, masterKey, { accountId: "account-1", kind: "flags" });
    const cancelled = recordTask(db, masterKey, { accountId: "account-1", kind: "snooze" });
    settleTask(db, failed, "failed", { code: "push_failed", message: "STORE 未确认" }, Date.now() - 1_000);
    settleTask(db, completed, "completed", null, Date.now() - 1_000);
    settleTask(db, cancelled, "cancelled", null, Date.now() - 1_000);

    const body = await list();

    expect(body.syncing).toEqual([]);
    // `cancelled` is the deliberate exclusion: a stop somebody asked for is not a
    // delivery that went wrong, and a panel that lists every cancelled snooze as
    // a problem is one people learn to ignore. `completed` is out for the plainer
    // reason that it delivered.
    expect(body.attention.map((task) => task.id)).toEqual([failed]);
    expect(body.attention.map((task) => task.error)).toEqual([{ code: "push_failed", message: "STORE 未确认" }]);
  });

  it("keeps a failure for the retention window and drops it after", async () => {
    const recent = recordTask(db, masterKey, { accountId: "account-1", kind: "move" });
    const stale = recordTask(db, masterKey, { accountId: "account-1", kind: "move" });
    const now = Date.now();
    // One second inside the window and one second outside it, measured against
    // the same `TASK_TERMINAL_ROW_TTL_MS` the pruner uses: the two rows are
    // otherwise identical, so a cutoff written as `>` versus `>=`, or read from
    // the wrong clock, is what this pair separates.
    settleTask(db, recent, "failed", null, now - TASK_TERMINAL_ROW_TTL_MS + 1_000);
    settleTask(db, stale, "failed", null, now - TASK_TERMINAL_ROW_TTL_MS - 1_000);

    const body = await list();

    expect(body.attention.map((task) => task.id)).toEqual([recent]);
  });

  it("reports the newest failure first", async () => {
    const older = recordTask(db, masterKey, { accountId: "account-1", kind: "move" });
    const newer = recordTask(db, masterKey, { accountId: "account-1", kind: "flags" });
    const now = Date.now();
    settleTask(db, older, "unknown_delivery", null, now - 60_000);
    settleTask(db, newer, "unknown_delivery", null, now - 1_000);

    const body = await list();

    expect(body.attention.map((task) => task.id)).toEqual([newer, older]);
  });

  it("caps both halves instead of returning everything the table holds", async () => {
    for (let index = 0; index < 55; index += 1) {
      recordTask(db, masterKey, { accountId: "account-1", kind: "flags", now: 1_000 + index });
    }

    const body = await list();

    expect(body.syncing).toHaveLength(50);
    // The cap keeps the oldest, not an arbitrary 50: a list that dropped its head
    // would hide the task the account's FIFO chain is stuck behind.
    expect(body.syncing[0]?.createdAt).toBe(1_000);
    expect(body.syncing[49]?.createdAt).toBe(1_049);
  });
});

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `${id}@example.com`,
    "gmail",
    "Gmail",
    "encrypted",
    "imap.gmail.com",
    993,
    1,
    "smtp.gmail.com",
    465,
    1,
    "email",
    "connected",
    new Date().toISOString(),
  );
}
