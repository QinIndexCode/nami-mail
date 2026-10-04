import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// Type-only imports: erased at compile time, so they do not evaluate config.js
// before the port below is in place.
import type { buildApp } from "../src/app.js";
import type { openDatabase } from "../src/db.js";
import type { AccountRecord } from "../src/types.js";
import type * as mailModule from "../src/mail.js";

/**
 * The backup export over a real socket that goes away mid-transfer.
 *
 * The unit cases in backup-backpressure.test.ts drive the writer against a
 * stream it controls; what they cannot show is the signal the route actually
 * relies on. The zip writer treats the response socket as the authority for
 * "the client is gone", because a destroyed PassThrough stops being useful but
 * a PassThrough Fastify never destroys can still sit there open with no reader,
 * and a stream like that never drains. This file therefore aborts a real
 * download and asserts the two things that only the wire can prove: the export
 * stops instead of queueing the rest of the mailbox, and nothing about the
 * account row or the process changes.
 *
 * Like the host-guard socket suite, the port is discovered before src/config.js
 * is evaluated, so every runtime import below is dynamic.
 */

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

type BuildApp = typeof buildApp;
type OpenDatabase = typeof openDatabase;

let build: BuildApp;
let open: OpenDatabase;
let boundPort = 0;

async function freeLoopbackPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port from the probe server.");
  await new Promise<void>((resolve) => { probe.close(() => resolve()); });
  return address.port;
}

const now = "2026-08-10T00:00:00.000Z";
/** Big enough that the archive is still being written when the socket dies. */
const SOURCE_SIZE = 256 * 1024;
const MESSAGES = 400;

describe("a backup download that is aborted over a real socket", () => {
  const originalPort = process.env.PORT;
  let app: Awaited<ReturnType<BuildApp>>;
  let db: ReturnType<OpenDatabase>;
  let backgroundDirectory = "";
  const fetches: number[] = [];
  const logouts: number[] = [];

  beforeAll(async () => {
    boundPort = await freeLoopbackPort();
    process.env.PORT = String(boundPort);
    ({ buildApp: build } = await import("../src/app.js"));
    ({ openDatabase: open } = await import("../src/db.js"));

    db = open(":memory:");
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES ('account-1', 'one@example.com', 'custom', 'Demo', 'encrypted',
        'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', ?)
    `).run(now);
    const insert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments,
        attachment_kinds_json, size, created_at
      ) VALUES (?, 'account-1', 'INBOX', ?, ?, 'Sender', 'sender@example.com', '[]',
        ?, '', '', '', '[]', 0, '[]', 0, ?)
    `);
    for (let uid = 1; uid <= MESSAGES; uid += 1) {
      const sentAt = new Date(Date.parse(now) + uid * 1000).toISOString();
      insert.run(`message-${uid}`, uid, `Subject ${uid}`, sentAt, sentAt);
    }

    // One source buffer reused by every message: the fixture is about the wire,
    // not about how much source the mailbox holds.
    const source = randomBytes(SOURCE_SIZE);
    imapClientForAccount.mockImplementation((_account: AccountRecord) => ({
      usable: true,
      connect: vi.fn(async () => undefined),
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      fetch: vi.fn(async function* fetch(uids: number[]) {
        fetches.push(uids.length);
        for (const uid of uids) yield { uid, source };
      }),
      logout: vi.fn(async () => { logouts.push(1); }),
    }));

    backgroundDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-backup-abort-"));
    app = await build({ db, masterKey: Buffer.alloc(32, 7), backgroundDirectory });
    await app.listen({ host: "127.0.0.1", port: boundPort });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) db.close();
    if (backgroundDirectory) fs.rmSync(backgroundDirectory, { recursive: true, force: true });
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  it("stops the export and leaves the account row alone", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const errors: unknown[] = [];
    const onError = (error: unknown): void => { errors.push(error); };
    process.on("uncaughtException", onError);
    try {
      const received = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({
          hostname: "127.0.0.1",
          port: boundPort,
          method: "GET",
          path: "/api/backup",
          headers: { host: `127.0.0.1:${boundPort}` },
        }, (response) => {
          response.once("data", (chunk: Buffer) => {
            // The archive is streaming: pull the plug with the response open.
            response.destroy();
            resolve(chunk.length);
          });
          response.on("error", () => undefined);
        });
        request.once("error", reject);
        request.end();
      });

      expect(received).toBeGreaterThan(0);
      // The server side has to notice on its own; nothing here waits on it.
      // The folder being closed is the marker that the walk is over: without the
      // abort the export keeps fetching to the end of the mailbox, because a
      // write to a stream nobody reads does not fail on its own.
      await vi.waitFor(() => expect(logouts.length).toBeGreaterThan(0), { timeout: 10_000, interval: 25 });
      const fetched = fetches.reduce((total, size) => total + size, 0);
      expect(fetched).toBeLessThan(MESSAGES);
      // And it stays stopped rather than draining the rest of the mailbox.
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      expect(fetches.reduce((total, size) => total + size, 0)).toBe(fetched);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      process.off("uncaughtException", onError);
    }

    expect(errors).toEqual([]);
    expect(unhandled).toEqual([]);
    // A client closing a download is not a mailbox failure.
    expect(db.prepare("SELECT status, last_error, last_error_code FROM accounts WHERE id = 'account-1'").get()).toMatchObject({
      status: "connected",
      last_error: null,
      last_error_code: null,
    });
    // The folder was still closed down on the way out.
    expect(logouts.length).toBeGreaterThan(0);
  }, 20_000);
});


