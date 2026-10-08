import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  clearMessageSnooze,
  listSnoozedMessages,
  releaseDueSnoozedMessages,
  setMessageSnoozed,
} from "../src/snooze.js";

describe("snooze storage", () => {
  let db: DatabaseHandle;
  const now = new Date().toISOString();

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-1", "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", now);
    for (const [id, uid, until] of [["message-1", 1, null], ["message-2", 2, null]] as Array<[string, number, string | null]>) {
      db.prepare(`
        INSERT INTO messages (
          id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
          sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at, snoozed_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, "account-1", "INBOX", uid, "Subject", "Demo", "demo@example.com", "[]", now, "", "", "", "[]", 0, 0, now, until);
    }
  });

  afterEach(() => {
    db.close();
  });

  it("sets, clears and lists snoozes", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    setMessageSnoozed(db, "message-1", future);
    expect(listSnoozedMessages(db)).toHaveLength(1);
    expect(listSnoozedMessages(db)[0].snoozed_until).toBe(future);

    clearMessageSnooze(db, "message-1");
    expect(listSnoozedMessages(db)).toHaveLength(0);
  });

  it("throws when the message does not exist", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(() => setMessageSnoozed(db, "missing", future)).toThrow("邮件不存在。");
    expect(() => clearMessageSnooze(db, "missing")).toThrow("邮件不存在。");
  });

  it("releases only snoozes whose time has arrived", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    setMessageSnoozed(db, "message-1", past);
    setMessageSnoozed(db, "message-2", future);

    const released = releaseDueSnoozedMessages(db, Buffer.alloc(32, 7), new Date().toISOString());

    expect(released.map((entry) => entry.id).sort()).toEqual(["message-1"]);
    expect(released[0]).toMatchObject({ accountId: "account-1", subject: "Subject", fromAddress: "demo@example.com" });
    // The due message is cleared; the future one stays snoozed.
    expect(listSnoozedMessages(db).map((row) => row.id)).toEqual(["message-2"]);
  });

  // R05: the snoozed view and the due release compare snoozed_until as a
  // STRING against a UTC now — an offset form sorted wrongly and the message
  // came back at the wrong time (or never). The stored value is the same
  // instant in UTC form.
  it("stores an offset snooze as the same instant in UTC (R05)", () => {
    const snoozedUntil = setMessageSnoozed(db, "message-1", "2026-01-01T09:00:00+08:00");
    expect(snoozedUntil).toBe("2026-01-01T01:00:00.000Z");

    // One minute before the instant: string comparison agrees with reality.
    expect(listSnoozedMessages(db, "2026-01-01T00:59:00.000Z").map((row) => row.id)).toEqual(["message-1"]);
    // One millisecond past it: released, and only the offset task.
    const released = releaseDueSnoozedMessages(db, Buffer.alloc(32, 7), "2026-01-01T01:00:00.001Z");
    expect(released.map((entry) => entry.id)).toEqual(["message-1"]);
  });

  it("rejects an unparseable snooze time (R05)", () => {
    expect(() => setMessageSnoozed(db, "message-1", "not-a-date")).toThrow("稍后处理时间无效。");
  });
});

describe("snooze API routes", () => {
  let app: FastifyInstance;
  let routeDb: DatabaseHandle;
  const routeNow = new Date().toISOString();

  beforeEach(async () => {
    routeDb = openDatabase(":memory:");
    app = await buildApp({ db: routeDb, masterKey: Buffer.alloc(32, 7) });
    routeDb.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-1", "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", routeNow);
    routeDb.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "INBOX", "Inbox", "\\Inbox", 2, 0);
    for (const [id, uid] of [["message-1", 1], ["message-2", 2]] as Array<[string, number]>) {
      routeDb.prepare(`
        INSERT INTO messages (
          id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
          sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at, snoozed_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, "account-1", "INBOX", uid, `Subject ${uid}`, "Demo", "demo@example.com", "[]", routeNow, "", "", "", "[]", 0, 0, routeNow, null);
    }
  });

  afterEach(async () => {
    await app.close();
    routeDb.close();
  });

  it("snoozes a message and hides it from the inbox and stats", async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    const set = await app.inject({
      method: "POST",
      url: "/api/messages/message-1/snooze",
      payload: { until },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ ok: true, snoozedUntil: until });

    const inbox = await app.inject({ method: "GET", url: "/api/messages" });
    expect(inbox.json().items.map((item: { id: string }) => item.id)).toEqual(["message-2"]);

    const snoozed = await app.inject({ method: "GET", url: "/api/messages?snoozed=1" });
    expect(snoozed.statusCode).toBe(200);
    expect(snoozed.json().items.map((item: { id: string; snoozedUntil: string | null }) => [item.id, item.snoozedUntil])).toEqual([["message-1", until]]);

    const stats = await app.inject({ method: "GET", url: "/api/stats" });
    // The snoozed message is hidden; message-2 remains unread in the inbox.
    // toMatchObject (not toEqual): cross-folder badge keys evolve separately.
    expect(stats.json()).toMatchObject({ accounts: 1, messages: 1, unread: 1 });
  });

  it("cancels a snooze so the message is visible again", async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    await app.inject({ method: "POST", url: "/api/messages/message-1/snooze", payload: { until } });
    const removed = await app.inject({ method: "DELETE", url: "/api/messages/message-1/snooze" });
    expect(removed.statusCode).toBe(200);
    const inbox = await app.inject({ method: "GET", url: "/api/messages" });
    expect(inbox.json().items.map((item: { id: string }) => item.id).sort()).toEqual(["message-1", "message-2"]);
  });

  it("returns the normalized UTC snooze for an offset request (R05)", async () => {
    // The request carries +08:00; the reply carries the stored UTC form of
    // the same instant.
    const instant = new Date(Date.now() + 3_600_000);
    const offsetForm = new Date(instant.getTime() + 8 * 3_600_000).toISOString().replace("Z", "+08:00");
    const set = await app.inject({
      method: "POST",
      url: "/api/messages/message-1/snooze",
      payload: { until: offsetForm },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().snoozedUntil).toBe(instant.toISOString());
  });

  it("rejects past snooze times and missing messages", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const invalid = await app.inject({
      method: "POST",
      url: "/api/messages/message-1/snooze",
      payload: { until: past },
    });
    expect(invalid.statusCode).toBe(400);

    const future = new Date(Date.now() + 60_000).toISOString();
    const missing = await app.inject({
      method: "POST",
      url: "/api/messages/missing/snooze",
      payload: { until: future },
    });
    expect(missing.statusCode).toBe(404);

    const missingDelete = await app.inject({ method: "DELETE", url: "/api/messages/missing/snooze" });
    expect(missingDelete.statusCode).toBe(404);
  });
});
