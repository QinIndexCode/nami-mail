import net from "node:net";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type * as appModule from "../src/app.js";
import type * as dbModule from "../src/db.js";
import type * as mailModule from "../src/mail.js";
import type * as syncMovesModule from "../src/sync-moves.js";
import type * as syncModule from "../src/sync.js";

/**
 * Shutdown vs. route-triggered syncs.
 *
 * The runtime hands its `syncAbortController.signal` to the route layer as
 * `RuntimeContext.syncShutdownSignal`. The fire-and-forget syncs a route
 * starts (first sync after account creation / OAuth callback, the background
 * reconciliation after a move) must unwind when the process shuts down, and
 * must NOT unwind when the client that issued the request navigates away —
 * the exact inverse of the interactive sync route's own request signal.
 *
 * Real sockets are used where a client disconnect is part of the behavior
 * under test; the port is discovered before src/config.js is evaluated, so
 * every runtime import below is dynamic (same shape as
 * backup-disconnect-socket.test.ts).
 */

const { testAccountConnection } = vi.hoisted(() => ({ testAccountConnection: vi.fn() }));
const { moveMessage } = vi.hoisted(() => ({ moveMessage: vi.fn() }));
const { syncAccount } = vi.hoisted(() => ({ syncAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, testAccountConnection };
});

vi.mock("../src/sync-moves.js", async (importOriginal) => {
  const actual = await importOriginal<typeof syncMovesModule>();
  return { ...actual, moveMessage };
});

vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof syncModule>();
  return { ...actual, syncAccount };
});

let buildApp: typeof appModule.buildApp;
let openDatabase: typeof dbModule.openDatabase;
let boundPort = 0;

async function freeLoopbackPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address !== "object") throw new Error("Expected a TCP port from the probe server.");
  const { port } = address;
  await new Promise<void>((resolve) => { probe.close(() => resolve()); });
  return port;
}

/** Signals whose pass unwound on abort — the shape a real pass shows while it reads a mailbox. */
const abortedPasses: AbortSignal[] = [];

/** A pass that only lets go when the signal it was handed aborts. */
function blockingPass(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) throw new Error("Every route-triggered sync must carry a shutdown or request signal.");
    signal.addEventListener("abort", () => {
      abortedPasses.push(signal);
      reject(Object.assign(new Error("Sync aborted."), { name: "SyncAbortedError" }));
    }, { once: true });
  });
}

function insertAccount(db: ReturnType<typeof openDatabase>, id = "00000000-0000-4000-8000-000000000001"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    "person@qq.com",
    "qq",
    "QQ Mail",
    "encrypted",
    "imap.qq.com",
    993,
    1,
    "smtp.qq.com",
    465,
    1,
    "email",
    "connected",
    new Date().toISOString(),
  );
}

function insertMessage(db: ReturnType<typeof openDatabase>, id: string, accountId: string): void {
  db.prepare(`
    INSERT INTO messages (id, account_id, mailbox, uid, flags_json, has_attachments, attachments_json, size, created_at)
    VALUES (?, ?, 'INBOX', 1, '[]', 0, '[]', 0, ?)
  `).run(id, accountId, new Date().toISOString());
}

async function postJson(
  path: string,
  payload: unknown,
  options: { destroyAfter?: (destroy: (reason?: Error) => void) => void } = {},
): Promise<{ statusCode?: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: boundPort,
      method: "POST",
      path,
      // No content-type without a body: Fastify rejects an empty JSON body.
      headers: payload === undefined
        ? { host: `127.0.0.1:${boundPort}` }
        : { host: `127.0.0.1:${boundPort}`, "content-type": "application/json" },
    }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
      response.on("error", () => resolve({ statusCode: response.statusCode, body }));
    });
    request.once("error", reject);
    options.destroyAfter?.((reason) => request.destroy(reason));
    request.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}

async function get(path: string): Promise<{ statusCode?: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: boundPort,
      method: "GET",
      path,
      headers: { host: `127.0.0.1:${boundPort}` },
    }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
      response.on("error", () => resolve({ statusCode: response.statusCode, body }));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("a process shutdown stops the syncs routes started", () => {
  const originalPort = process.env.PORT;
  let app: Awaited<ReturnType<typeof appModule.buildApp>> | undefined;
  let db: ReturnType<typeof openDatabase> | undefined;
  let shutdownController: AbortController;

  beforeAll(async () => {
    boundPort = await freeLoopbackPort();
    process.env.PORT = String(boundPort);
    ({ buildApp } = await import("../src/app.js"));
    ({ openDatabase } = await import("../src/db.js"));
  });

  afterAll(() => {
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    abortedPasses.length = 0;
    shutdownController = new AbortController();
    syncAccount.mockImplementation((...args: unknown[]) => blockingPass(args[6] as AbortSignal | undefined));
    testAccountConnection.mockResolvedValue({ folders: [], smtp: true });
    moveMessage.mockResolvedValue({ accountId: "00000000-0000-4000-8000-000000000001", destination: "Archive", refreshPending: true });

    db = openDatabase(":memory:");
    insertAccount(db);
    insertMessage(db, "message-1", "00000000-0000-4000-8000-000000000001");
    const context = {
      db,
      masterKey: Buffer.alloc(32, 7),
      // Swapped for a fresh controller before every test: the routes read the
      // field per call, exactly as they would from a runtime-owned context.
      syncShutdownSignal: shutdownController.signal,
    };
    app = await buildApp(context as never);
    await app.listen({ host: "127.0.0.1", port: boundPort });
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) db.close();
    app = undefined;
    db = undefined;
  });

  it("returns the create-account response immediately, then aborts the first sync on shutdown", async () => {
    // Generated per run: the value only has to satisfy the request schema, and
    // a fresh fake per run keeps the fixture free of credential literals.
    const accountPassword = `test-password-${randomUUID()}`;
    const response = await postJson("/api/accounts/manual", {
      email: "someone@qq.com",
      password: accountPassword,
      imap: { host: "imap.qq.com", port: 993, transport: "tls" },
      smtp: { host: "smtp.qq.com", port: 465, transport: "tls" },
    });

    // The response never queued behind the sync: the pass is still blocked
    // while the reply is already on the wire.
    expect(response.statusCode).toBe(201);
    expect(syncAccount).toHaveBeenCalledTimes(1);
    const signal = syncAccount.mock.calls[0]?.[6] as AbortSignal;
    expect(signal).toBe(shutdownController.signal);
    expect(signal.aborted).toBe(false);

    // A client that navigates away does nothing to the pass (no abort here);
    // only the process going down does.
    shutdownController.abort();
    await vi.waitFor(() => expect(abortedPasses).toContain(signal));
    expect(signal.aborted).toBe(true);
  }, 20_000);

  it("returns the move response immediately, then aborts the background reconciliation on shutdown", async () => {
    const response = await postJson("/api/messages/message-1/move", { target: "archive" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, refreshPending: true });
    expect(syncAccount).toHaveBeenCalledTimes(1);
    const signal = syncAccount.mock.calls[0]?.[6] as AbortSignal;
    expect(signal).toBe(shutdownController.signal);

    shutdownController.abort();
    await vi.waitFor(() => expect(abortedPasses).toContain(signal));
  }, 20_000);

  it("returns the OAuth callback page immediately, then aborts the first sync on shutdown", async () => {
    // The stub completes the authorization and points the route at the
    // account row the fixture inserted, exactly where `finish()` hands the
    // route a real accountId.
    const oauthService = {
      finish: async () => ({ status: "success", accountId: "00000000-0000-4000-8000-000000000001" }),
    };
    const context = {
      db,
      masterKey: Buffer.alloc(32, 7),
      syncShutdownSignal: shutdownController.signal,
      oauthService,
      oauthCallbackOrigin: `http://127.0.0.1:${boundPort}`,
    };
    if (app) await app.close();
    app = await buildApp(context as never);
    await app.listen({ host: "127.0.0.1", port: boundPort });

    // GET is exempt from the local API token and carries its own Host check.
    const callback = await get(`/api/oauth/google/callback?code=authorization-code&state=oauth-state`);
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain("<!doctype html>");
    expect(syncAccount).toHaveBeenCalledTimes(1);
    const signal = syncAccount.mock.calls[0]?.[6] as AbortSignal;
    expect(signal).toBe(shutdownController.signal);

    // The callback page closing its own window is the standard flow, not a
    // cancellation: only the process going down stops this first pass.
    shutdownController.abort();
    await vi.waitFor(() => expect(abortedPasses).toContain(signal));
  }, 20_000);

  it("stops the interactive sync when either the request goes away or shutdown fires, and leaves the other path alone", async () => {
    // A. The request-scoped path: the client disconnects, the pass unwinds,
    //    and the shutdown signal is untouched.
    let destroyRequest: ((reason?: Error) => void) | undefined;
    const disconnected = postJson("/api/accounts/00000000-0000-4000-8000-000000000001/sync", undefined, {
      destroyAfter: (destroy) => { destroyRequest = destroy; },
    }).catch(() => ({ statusCode: undefined, body: "" }));
    await vi.waitFor(() => expect(syncAccount).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    const requestSignal = syncAccount.mock.calls[0]?.[6] as AbortSignal;
    expect(requestSignal).not.toBe(shutdownController.signal);
    destroyRequest?.(new Error("client navigated away"));
    await vi.waitFor(() => expect(abortedPasses).toContain(requestSignal));
    expect(requestSignal.aborted).toBe(true);
    expect(shutdownController.signal.aborted).toBe(false);
    await disconnected;

    // B. The shutdown path: the client stays connected, the process goes down,
    //    and the request still receives the route's cancelled response.
    const duringShutdown = postJson("/api/accounts/00000000-0000-4000-8000-000000000001/sync", undefined);
    await vi.waitFor(() => expect(syncAccount).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    const shutdownAbortedSignal = syncAccount.mock.calls[1]?.[6] as AbortSignal;
    shutdownController.abort();
    await vi.waitFor(() => expect(abortedPasses).toContain(shutdownAbortedSignal));
    const response = await duringShutdown;
    expect(response.statusCode).toBe(499);
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, code: "cancelled" });
  }, 20_000);
});


