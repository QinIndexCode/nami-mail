import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { ServerEventBus, emitAccountSynced } from "../src/events.js";

describe("server event bus", () => {
  it("delivers events to subscribers and stops after unsubscribe", () => {
    const bus = new ServerEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    const event = { type: "mail.received", payload: { accountId: "account-1", count: 1, messages: [] } } as const;
    bus.emit(event);
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe();
    bus.emit(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps delivering to other subscribers when one throws", () => {
    const bus = new ServerEventBus();
    const brittle = vi.fn(() => {
      throw new Error("delivery failed");
    });
    const healthy = vi.fn();
    bus.subscribe(brittle);
    bus.subscribe(healthy);
    bus.emit({ type: "mail.synced", payload: { accountId: "account-1", lastSyncedAt: "2026-08-10T00:00:00.000Z" } });
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("emitAccountSynced reports the persisted last_synced_at for the account", () => {
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO accounts (id, email, provider, provider_name, encrypted_password, imap_host, imap_port, imap_secure, imap_transport, smtp_host, smtp_port, smtp_secure, smtp_transport, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "account-1", "a@example.com", "gmail", "Gmail", "x", "imap.gmail.com", 993, 1, "tls", "smtp.gmail.com", 465, 1, "tls", "2026-08-10T00:00:00.000Z", "connected",
      );
      const bus = new ServerEventBus();
      const listener = vi.fn();
      bus.subscribe(listener);

      // No sync has run yet: nothing to report.
      emitAccountSynced(db, bus, "account-1");
      expect(listener).not.toHaveBeenCalled();

      db.prepare("UPDATE accounts SET last_synced_at = ? WHERE id = ?").run("2026-08-10T21:05:14.659Z", "account-1");
      emitAccountSynced(db, bus, "account-1");
      expect(listener).toHaveBeenCalledWith({ type: "mail.synced", payload: { accountId: "account-1", lastSyncedAt: "2026-08-10T21:05:14.659Z" } });

      // A missing bus is a no-op (SSE is optional at runtime).
      expect(() => emitAccountSynced(db, undefined, "account-1")).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("POST /api/accounts/:id/sync broadcasts mail.synced after a successful pass", async () => {
    const db = openDatabase(":memory:");
    const bus = new ServerEventBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    // A minimal healthy mailbox so syncAccount completes without touching the network.
    const lock = { release: vi.fn() };
    imapClientForAccount.mockReturnValue({
      usable: true,
      connect: vi.fn(async () => undefined),
      getMailboxLock: vi.fn(async () => lock),
      mailbox: { exists: 1, uidValidity: 1n },
      list: vi.fn(async () => [{ path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" }]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch: vi.fn(async function* () {
        yield { uid: 1, emailId: "m1", flags: new Set(["\\Seen"]), internalDate: new Date("2026-08-10T00:00:00.000Z"), size: 10, source: Buffer.from("Subject: x\r\n\r\nbody") };
      }),
      logout: vi.fn(async () => undefined),
    });
    const app = await buildApp({ db, masterKey: Buffer.alloc(32, 9), serverEvents: bus });
    try {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO accounts (id, email, provider, provider_name, encrypted_password, imap_host, imap_port, imap_secure, imap_transport, smtp_host, smtp_port, smtp_secure, smtp_transport, username_mode, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "account-sync-1", "b@example.com", "custom", "Demo", "x", "imap.example.com", 993, 1, "tls", "smtp.example.com", 465, 1, "tls", "email", "connected", now,
      );
      const response = await app.inject({ method: "POST", url: "/api/accounts/account-sync-1/sync" });
      expect(response.statusCode).toBe(200);
      const syncedEvents = listener.mock.calls
        .map((call) => call[0])
        .filter((event) => event?.type === "mail.synced");
      expect(syncedEvents.length).toBeGreaterThan(0);
      expect(syncedEvents[0]).toMatchObject({
        type: "mail.synced",
        payload: { accountId: "account-sync-1", lastSyncedAt: expect.any(String) },
      });
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("GET /api/events SSE", () => {
  let db: DatabaseHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let bus: ServerEventBus;
  let baseUrl: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    bus = new ServerEventBus();
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 9), serverEvents: bus });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) db.close();
  });

  it("answers 404 when no event bus is wired into the context", async () => {
    const plainDb = openDatabase(":memory:");
    const plain = await buildApp({ db: plainDb, masterKey: Buffer.alloc(32, 9) });
    try {
      const response = await plain.inject({ method: "GET", url: "/api/events" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ ok: false, code: "events_unavailable" });
    } finally {
      await plain.close();
      plainDb.close();
    }
  });

  it("streams bus events to a connected client and cleans up on disconnect", async () => {
    const chunks: string[] = [];
    let responseStatus = 0;
    let contentType = "";
    const request = http.get(`${baseUrl}/api/events`, (response) => {
      responseStatus = response.statusCode ?? 0;
      contentType = response.headers["content-type"] ?? "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => chunks.push(chunk));
    });
    // Hijacked responses do not flush headers until the first write, so wait
    // for the route's subscription instead of the client's response event.
    await vi.waitFor(() => expect(bus.listenerCount).toBe(1));
    bus.emit({
      type: "mail.received",
      payload: {
        accountId: "account-1",
        count: 1,
        messages: [{ id: "message-1", accountId: "account-1", subject: "Verification code", fromName: "Demo", fromAddress: "demo@example.com" }],
      },
    });
    bus.emit({ type: "mail.synced", payload: { accountId: "account-1", lastSyncedAt: "2026-08-10T00:00:00.000Z" } });

    await vi.waitFor(() => {
      const body = chunks.join("");
      expect(body).toContain('"type":"mail.received"');
      expect(body).toContain("Verification code");
      expect(body).toContain('"type":"mail.synced"');
    });
    expect(responseStatus).toBe(200);
    expect(contentType).toContain("text/event-stream");
    // Named events (WHATWG EventSource): the `event:` line is what makes
    // client-side addEventListener("mail.received") fire at all. Without it
    // browser listeners receive every frame as the default "message" event.
    expect(chunks.join("")).toMatch(/^event: /);
    expect(chunks.join("")).toContain("event: mail.received\ndata: {\"type\":\"mail.received\"");
    expect(chunks.join("")).toContain("event: mail.synced\ndata: {\"type\":\"mail.synced\"");

    // Disconnect the client; the route must notice, unsubscribe and end its
    // half of the stream so the server shuts down without a dangling socket.
    const streamEnded = new Promise<void>((resolve) => request.once("close", resolve));
    request.destroy();
    await streamEnded;
  });
});