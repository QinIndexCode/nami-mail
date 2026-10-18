import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { SERVER_EVENT_TYPES, ServerEventBus, type ServerEvent } from "../src/events.js";
import { recordTask, taskRow } from "../src/tasks/index.js";
import { TASK_TERMINAL_STATUSES } from "../src/tasks/types.js";
import { REALTIME_EVENT_NAMES } from "../../web/src/realtimeEventNames.js";
import { TASK_TERMINAL_STATUSES as WEB_TERMINAL_STATUSES } from "../../web/src/taskStatuses.js";

/**
 * The two sides of the push contract, pinned against each other (contract §8
 * G12).
 *
 * Three assertions, each covering a different silent failure:
 *
 *   1. The server's emit manifest equals the client's listener registry. A name
 *      on one side only is a frame nobody receives (or a listener for an event
 *      that never fires), and neither side reports an error.
 *   2. The terminal-status vocabulary is the same on both sides. A renderer that
 *      did not know `cancelled` would treat a settled task as still running.
 *   3. One row read through every surface -- `/api/tasks/:id`, the batch-job
 *      alias, and the `task-settled` frame -- reports the same terminal state.
 *      The alias may re-spell it (`failed` for `cancelled`), but it may not
 *      disagree about whether the task ended.
 *
 * The compile-time half lives in the `Record<ServerEvent["type"], true>` below:
 * adding a union member without adding it to that object stops the test project
 * from type-checking, which is the only moment a name can be forgotten without
 * anything at runtime noticing.
 */
const UNION_EVENT_NAMES: Record<ServerEvent["type"], true> = {
  "mail.received": true,
  "mail.synced": true,
  "settings.changed": true,
  "sync.progress": true,
  "task-progress": true,
  "task-settled": true,
  "mail-changed": true,
};

describe("SSE wire contract", () => {
  it("emits exactly the event names the renderer listens for", () => {
    expect(Object.keys(UNION_EVENT_NAMES).sort()).toEqual([...SERVER_EVENT_TYPES].sort());
    // The difference in both directions, spelled out: a set equality failure
    // reads as a wall of names, while these two lines name the missing side.
    expect(SERVER_EVENT_TYPES.filter((name) => !(REALTIME_EVENT_NAMES as readonly string[]).includes(name))).toEqual([]);
    expect(REALTIME_EVENT_NAMES.filter((name) => !(SERVER_EVENT_TYPES as readonly string[]).includes(name))).toEqual([]);
  });

  it("uses one terminal-status vocabulary on both sides", () => {
    expect(WEB_TERMINAL_STATUSES).toEqual(TASK_TERMINAL_STATUSES);
  });

  describe("one settled task, three readings", () => {
    let db: DatabaseHandle;
    let app: FastifyInstance | undefined;
    const masterKey = Buffer.alloc(32, 0x4d);

    beforeEach(() => {
      db = openDatabase(":memory:");
      db.prepare(`
        INSERT INTO accounts (
          id, email, provider, provider_name, encrypted_password,
          imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
          username_mode, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "account-1", "reader@example.com", "custom", "Demo", "encrypted",
        "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", new Date().toISOString(),
      );
    });

    afterEach(async () => {
      if (app) await app.close();
      if (db) db.close();
    });

    it("reports the same terminal status through the task route, the job alias, and the settled frame", async () => {
      // No payload: the move runner settles `failed` with `no_payload` on its
      // first sighting, which is a terminal state reached without a socket --
      // exactly what this test needs from a task it did not accept itself.
      const taskId = recordTask(db, masterKey, { accountId: "account-1", kind: "move" });
      const bus = new ServerEventBus();
      const events: ServerEvent[] = [];
      bus.subscribe((event) => events.push(event));

      // The row exists before buildApp, so the scheduler's own `resume()` picks
      // it up; no test drives the task layer by hand here.
      app = await buildApp({ db, masterKey, serverEvents: bus });

      await vi.waitFor(() => {
        expect(events.some((event) => event.type === "task-settled")).toBe(true);
      }, { timeout: 10_000 });

      const settled = events.find((event) => event.type === "task-settled") as Extract<ServerEvent, { type: "task-settled" }>;
      const taskResponse = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
      const aliasResponse = await app.inject({ method: "GET", url: `/api/batch-jobs/${taskId}` });

      expect(taskResponse.statusCode).toBe(200);
      expect(aliasResponse.statusCode).toBe(200);
      const taskStatus = (taskResponse.json() as { task: { status: string } }).task.status;
      const aliasStatus = (aliasResponse.json() as { job: { status: string } }).job.status;

      expect(taskRow(db, taskId)?.status).toBe("failed");
      expect(taskStatus).toBe("failed");
      expect(aliasStatus).toBe("failed");
      expect(settled.payload).toEqual({ accountId: "account-1", taskId, status: "failed" });
    });

    it("keeps the id stable across the surfaces (the alias resolves a member, not a second row)", async () => {
      const taskId = recordTask(db, masterKey, { accountId: "account-1", kind: "move", id: `job-${randomUUID()}` });
      app = await buildApp({ db, masterKey, serverEvents: new ServerEventBus() });

      const response = await app.inject({ method: "GET", url: `/api/batch-jobs/${taskId}` });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { job: { id: string } }).job.id).toBe(taskId);
    });
  });
});
