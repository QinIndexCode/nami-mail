import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { recordTask, taskRow } from "../src/tasks/index.js";
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
