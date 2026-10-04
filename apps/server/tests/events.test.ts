import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { ServerEventBus, emitAccountSynced, type ServerEvent } from "../src/events.js";
import {
  registerEventsRoutes,
  maxEventStreams,
  maxPendingEventBytes,
  type EventsRouteLimits,
} from "../src/routes/events.js";
import type { RuntimeContext } from "../src/types.js";

describe("server event bus", () => {
  it("delivers events to subscribers and stops after unsubscribe", () => {
    const bus = new ServerEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    const event = { type: "mail.received", payload: { accountId: "account-1", count: 1, messages: [] } } as const;
    bus.emit(event);
    expect(listener).toHaveBeenCalledWith(event, JSON.stringify(event));
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
    bus.emit({ type: "mail.synced", payload: { accountId: "account-1", lastSyncedAt: "2026-08-10T00:00:00.000Z", warningCode: null } });
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("serializes each event once per emit, no matter how many subscribers are attached", () => {
    const bus = new ServerEventBus();
    let serializations = 0;
    const counted = {
      toJSON() {
        serializations += 1;
        return "2026-08-10T00:00:00.000Z";
      },
    };
    // The bus hands the identical object to every listener, so the count is a
    // direct measurement of how many times the frame was built — the thing the
    // SSE route used to pay per subscriber.
    const event = { type: "settings.changed", payload: { at: counted } } as unknown as ServerEvent;
    const frames: Array<string | null> = [];
    for (let subscriber = 0; subscriber < 5; subscriber += 1) {
      bus.subscribe((_received, serialized) => { frames.push(serialized); });
    }

    bus.emit(event);

    expect(serializations).toBe(1);
    expect(frames).toEqual(Array.from({ length: 5 }, () => '{"type":"settings.changed","payload":{"at":"2026-08-10T00:00:00.000Z"}}'));
  });

  it("delivers a null frame instead of throwing when an event cannot be serialized", () => {
    const bus = new ServerEventBus();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const received: Array<string | null> = [];
    bus.subscribe((_event, serialized) => { received.push(serialized); });
    const survivor = vi.fn();

    expect(() => bus.emit({ type: "settings.changed", payload: cyclic } as unknown as ServerEvent)).not.toThrow();
    expect(received).toEqual([null]);

    bus.subscribe(survivor);
    bus.emit({ type: "mail.synced", payload: { accountId: "account-1", lastSyncedAt: "2026-08-10T00:00:00.000Z", warningCode: null } });
    expect(survivor).toHaveBeenCalledTimes(1);
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
      expect(listener).toHaveBeenCalledWith(
        { type: "mail.synced", payload: { accountId: "account-1", lastSyncedAt: "2026-08-10T21:05:14.659Z", warningCode: null } },
        '{"type":"mail.synced","payload":{"accountId":"account-1","lastSyncedAt":"2026-08-10T21:05:14.659Z","warningCode":null}}',
      );

      // A missing bus is a no-op (SSE is optional at runtime).
      expect(() => emitAccountSynced(db, undefined, "account-1")).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("emitAccountSynced carries the persisted sync warning code when one exists", () => {
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO accounts (id, email, provider, provider_name, encrypted_password, imap_host, imap_port, imap_secure, imap_transport, smtp_host, smtp_port, smtp_secure, smtp_transport, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "account-1", "a@example.com", "gmail", "Gmail", "x", "imap.gmail.com", 993, 1, "tls", "smtp.gmail.com", 465, 1, "tls", "2026-08-10T00:00:00.000Z", "connected",
      );
      const bus = new ServerEventBus();
      const listener = vi.fn();
      bus.subscribe(listener);
      db.prepare("UPDATE accounts SET last_synced_at = ?, last_sync_warning_code = ? WHERE id = ?").run("2026-08-10T21:05:14.659Z", "sync_limit", "account-1");
      emitAccountSynced(db, bus, "account-1");
      expect(listener).toHaveBeenCalledWith(
        { type: "mail.synced", payload: { accountId: "account-1", lastSyncedAt: "2026-08-10T21:05:14.659Z", warningCode: "sync_limit" } },
        '{"type":"mail.synced","payload":{"accountId":"account-1","lastSyncedAt":"2026-08-10T21:05:14.659Z","warningCode":"sync_limit"}}',
      );
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
        "00000000-0000-4000-8000-000000000001", "b@example.com", "custom", "Demo", "x", "imap.example.com", 993, 1, "tls", "smtp.example.com", 465, 1, "tls", "email", "connected", now,
      );
      const response = await app.inject({ method: "POST", url: "/api/accounts/00000000-0000-4000-8000-000000000001/sync" });
      expect(response.statusCode).toBe(200);
      const syncedEvents = listener.mock.calls
        .map((call) => call[0])
        .filter((event) => event?.type === "mail.synced");
      expect(syncedEvents.length).toBeGreaterThan(0);
      expect(syncedEvents[0]).toMatchObject({
        type: "mail.synced",
        payload: { accountId: "00000000-0000-4000-8000-000000000001", lastSyncedAt: expect.any(String), warningCode: null },
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
  // Generated per test, not written as a literal: the value only needs to
  // prove the header flows into the hook, and a fresh capability per run is
  // better test hygiene than a shared magic string.
  let eventsAccessToken: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    bus = new ServerEventBus();
    eventsAccessToken = `events-${randomUUID()}`;
    // The SSE test drives a real socket to a dynamic port (0): with no token
    // that exact combination is the Host allowlist's fail-closed case, so the
    // test presents the desktop capability instead, like production does.
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 9), serverEvents: bus }, { localApiAccessToken: eventsAccessToken });
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
    const request = http.get(`${baseUrl}/api/events`, { headers: { "x-nami-api-token": eventsAccessToken } }, (response) => {
      responseStatus = response.statusCode ?? 0;
      contentType = response.headers["content-type"] ?? "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => chunks.push(chunk));
    });
    // Hijacked responses do not flush headers until the first write, so wait
    // for the route's subscription instead of the client's response event.
    await vi.waitFor(() => expect(bus.listenerCount).toBe(1), { timeout: 10_000 });
    bus.emit({
      type: "mail.received",
      payload: {
        accountId: "account-1",
        count: 1,
        messages: [{ id: "message-1", accountId: "account-1", subject: "Verification code", fromName: "Demo", fromAddress: "demo@example.com" }],
      },
    });
    bus.emit({ type: "mail.synced", payload: { accountId: "account-1", lastSyncedAt: "2026-08-10T00:00:00.000Z", warningCode: null } });

    await vi.waitFor(() => {
      const body = chunks.join("");
      expect(body).toContain('"type":"mail.received"');
      expect(body).toContain("Verification code");
      expect(body).toContain('"type":"mail.synced"');
    }, { timeout: 10_000 });
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

// The stream is a resource a client holds open, and the two ways to run out of
// it are a client that stops reading and a client that never disconnects. Both
// are bounded here, on a bare instance so the limits can be tightened to
// something a unit test can actually fill.
describe("GET /api/events stream limits", () => {
  let app: FastifyInstance;
  let bus: ServerEventBus;
  let baseUrl: string;
  const open: http.ClientRequest[] = [];

  async function serve(limits: EventsRouteLimits): Promise<void> {
    app = Fastify();
    bus = new ServerEventBus();
    registerEventsRoutes(app, {
      // The route reads exactly one field off the context; a bare app keeps the
      // harness from dragging the whole local API into a stream-limits test.
      context: { serverEvents: bus } as unknown as RuntimeContext,
      log: app.log,
      limits,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  /** Opens a stream and resolves once the route has subscribed it. */
  function openStream(): Promise<http.ClientRequest> {
    const request = http.get(`${baseUrl}/api/events`, (response) => {
      response.resume();
    });
    // A server that drops the socket mid-frame surfaces here as ECONNRESET,
    // which is the outcome several of these cases are asserting; without a
    // listener it would be an unhandled error rather than a passing test.
    request.on("error", () => {});
    open.push(request);
    return vi.waitFor(() => {
      expect(bus.listenerCount).toBeGreaterThan(0);
      return request;
    }, { timeout: 10_000 });
  }

  /** Resolves when the client socket is gone, however it went. */
  function disconnected(request: http.ClientRequest): Promise<void> {
    return new Promise<void>((resolve) => {
      request.once("close", resolve);
      request.once("error", () => resolve());
    });
  }

  afterEach(async () => {
    for (const request of open.splice(0)) request.destroy();
    if (app) await app.close();
  });

  it("drops a client whose socket stops taking frames instead of buffering without bound", async () => {
    await serve({ maxPendingBytes: 4 * 1024 });
    const request = await openStream();
    const closed = disconnected(request);

    // One frame far larger than both the per-connection budget and the socket's
    // own high-water mark: the write cannot be taken outright, which is the
    // signal a half-open peer never lets go.
    bus.emit({
      type: "mail.received",
      payload: {
        accountId: "account-1",
        count: 1,
        messages: [{ id: "message-1", accountId: "account-1", subject: "x".repeat(64 * 1024), fromName: "Demo", fromAddress: "demo@example.com" }],
      },
    });

    await closed;
    // The connection is retired, not left leaking: the subscription is gone.
    await vi.waitFor(() => expect(bus.listenerCount).toBe(0), { timeout: 10_000 });
  });

  it("refuses a stream past the subscriber ceiling with a real status, before hijacking", async () => {
    await serve({ maxStreams: 1 });
    await openStream();

    const refused = await app.inject({ method: "GET", url: "/api/events" });

    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({
      ok: false,
      code: "events_overloaded",
      message: "Too many event stream connections are already open.",
    });
    // The refusal must not have taken a slot of its own or left a half-open
    // stream behind for the next caller to inherit.
    expect(bus.listenerCount).toBe(1);
  });

  it("keeps the shipped defaults sized for real renderers", () => {
    expect(maxEventStreams).toBe(32);
    expect(maxPendingEventBytes).toBe(4 * 1024 * 1024);
  });
});

