import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { PassThrough } from "node:stream";
import type * as mailModule from "../src/mail.js";

// The backup used to hand every fetched source straight to yazl and move on.
// yazl's addBuffer() queues an async zlib.deflateRaw and returns, and its
// writeToOutputStream() throws away the return value of outputStream.write(),
// so a client that stopped reading turned the whole mailbox into bytes buffered
// inside one PassThrough. The writer below is the other half of the streaming
// rewrite: the collector awaits emit, and emit suspends while the archive runs
// ahead of its reader.
//
// What each case below has to be able to fail on:
//   1. shape  - the two yazl facts the bounds are built on (a PassThrough with
//               real drain semantics, and the per-entry state that says an entry
//               has been written out);
//   2. drain  - with nothing reading, production parks instead of queueing;
//   3. ceiling - even a reader that keeps up cannot make yazl hold more than
//               the configured window of source bytes;
//   4. closed - a download that goes away ends the run instead of hanging or
//               rejecting into nowhere.

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { BackupTransferClosedError, collectMailBackup } from "../src/backup.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { createBackupZipWriter } from "../src/routes/backup.js";

/**
 * Incompressible bytes. A run of identical characters deflates to almost
 * nothing, so a compressible payload would never fill the output stream's 16 KiB
 * high-water mark and the drain signal — the thing under test here — would
 * never fire.
 */
function incompressible(size: number): Buffer {
  return randomBytes(size);
}

/**
 * @types/yazl publishes outputStream as a NodeJS.ReadableStream, which does not
 * carry the writable side every bound here is read from. It is a PassThrough at
 * runtime — the first case below asserts exactly that — so this narrows the
 * published type rather than inventing one.
 */
function outputOf(zip: ZipFile): PassThrough {
  return zip.outputStream as unknown as PassThrough;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------------------------------------------------------------- 1 shape --

type YazlEntryShape = { state?: number; compressedSize?: number | null; uncompressedSize?: number; doFileDataPump?: unknown };
type YazlInternalsShape = { entries?: YazlEntryShape[] };

describe("yazl exposes what the back-pressure bounds are built on", () => {
  it("is a PassThrough, so writableNeedDrain and drain are real writable signals", async () => {
    const zip = new ZipFile();
    const output = outputOf(zip);
    // The drain criterion is only valid because outputStream is a standard
    // Duplex. A future yazl that changed it would silently stop the bound.
    expect(output).toBeInstanceOf(PassThrough);
    expect(typeof output.writableNeedDrain).toBe("boolean");
    expect(typeof output.writableLength).toBe("number");

    let drained = false;
    output.on("drain", () => { drained = true; });
    output.on("error", () => undefined);
    // 512 KiB with nobody reading overruns the 16 KiB mark, and the drain only
    // arrives once a reader shows up — which is the whole criterion.
    zip.addBuffer(incompressible(512 * 1024), "emails/0001_message.eml");
    await vi.waitFor(() => expect(output.writableNeedDrain).toBe(true));
    expect(drained).toBe(false);

    const seen: Buffer[] = [];
    output.on("data", (chunk: Buffer) => { seen.push(chunk); });
    await vi.waitFor(() => expect(drained).toBe(true));
    expect(seen.length).toBeGreaterThan(0);
  });

  it("marks an entry written only after it reaches the output stream", async () => {
    const zip = new ZipFile();
    outputOf(zip).on("error", () => undefined);
    outputOf(zip).resume();
    const internals = zip as unknown as YazlInternalsShape;
    const source = incompressible(256 * 1024);

    zip.addBuffer(source, "emails/0001_message.eml");
    const entry = internals.entries?.[0] as YazlEntryShape;
    // Straight after addBuffer the entry is queued and uncompressedSize is known,
    // compressedSize is not: this is the window the ceiling measures.
    expect(entry.uncompressedSize).toBe(source.length);
    expect(entry.state).toBe(0);
    expect(entry.compressedSize).toBeNull();

    await vi.waitFor(() => expect(entry.state).toBe(3));
    expect(typeof entry.compressedSize).toBe("number");
  });
});

// ---------------------------------------------------------------- 2 drain --

describe("the zip writer stops producing while the archive is not being read", () => {
  it("parks the producer and lets a reader release it", async () => {
    const zip = new ZipFile();
    outputOf(zip).on("error", () => undefined);
    // A ceiling of one entry, so the first overshoot is what trips the gate and
    // the case below is about the drain, not about the quota.
    const writer = createBackupZipWriter(zip, { maxInFlightBytes: 64 * 1024 });
    const source = incompressible(64 * 1024);
    const total = 24;

    let produced = 0;
    const run = (async () => {
      for (let index = 0; index < total; index += 1) {
        await writer.add(source, `emails/${String(index).padStart(4, "0")}.eml`);
        produced += 1;
      }
    })();

    // Nothing is reading. Give the deflate pool and the pump far more turns than
    // they need: without the drain wait the whole archive is added in that time.
    await sleep(300);
    expect(produced).toBeLessThan(total);
    expect(produced).toBeGreaterThan(0);
    // And the archive is not sitting in the output stream waiting for a reader.
    expect(outputOf(zip).writableNeedDrain).toBe(true);
    expect(outputOf(zip).writableLength).toBeLessThan((total * source.length) / 2);

    outputOf(zip).on("data", () => undefined);
    await run;

    expect(produced).toBe(total);
    expect(writer.stats().added).toBe(total);
  });
});

// -------------------------------------------------------------- 3 ceiling --

describe("the zip writer caps what yazl is allowed to hold", () => {
  it("keeps the in-flight window at the ceiling even when a reader keeps up", async () => {
    const zip = new ZipFile();
    outputOf(zip).on("error", () => undefined);
    // A reader that is never behind, and entries small enough that the stream
    // never crosses its high-water mark: nothing but the ceiling can stop the
    // producer here, so removing the ceiling check is what turns this red.
    outputOf(zip).on("data", () => undefined);
    const limit = 32 * 1024;
    const source = incompressible(4096);
    const total = 200;
    const writer = createBackupZipWriter(zip, { maxInFlightBytes: limit });

    for (let index = 0; index < total; index += 1) {
      await writer.add(source, `emails/${String(index).padStart(4, "0")}.eml`);
    }
    const stats = writer.stats();

    expect(stats.added).toBe(total);
    // The window is the ceiling plus the one entry that crossed it, not the
    // whole mailbox: without the ceiling this is every entry.
    expect(stats.peakInFlightBytes).toBeLessThanOrEqual(limit + source.length);
    expect(stats.peakInFlightBytes).toBeLessThan((total * source.length) / 2);
    expect(stats.waits).toBeGreaterThan(0);

    await writer.flush();
    expect(writer.stats().inFlightBytes).toBe(0);
  });

  it("follows the compression ratio instead of drifting", async () => {
    // Reservations are released per entry by that entry's own state, never by a
    // running total, so a highly compressible mailbox frees its window as it
    // goes instead of accumulating a phantom "bytes still owed" that would stall
    // the export at some point mid-run.
    const zip = new ZipFile();
    outputOf(zip).on("error", () => undefined);
    outputOf(zip).on("data", () => undefined);
    const writer = createBackupZipWriter(zip, { maxInFlightBytes: 16 * 1024 });
    const source = Buffer.alloc(64 * 1024, 0x61);

    for (let index = 0; index < 48; index += 1) await writer.add(source, `emails/${index}.eml`);

    // Every reservation is accounted for by an entry, and none of them is left
    // behind: the counter cannot have drifted over the run.
    expect(writer.stats().added).toBe(48);
    await writer.flush();
    expect(writer.stats().inFlightBytes).toBe(0);
  });
});

// ------------------------------------------------------------ 3b the memory --

type CentralEntry = { name: string; compressedSize: number; localHeaderOffset: number };

/** Walks the central directory, which yazl writes from its own entry list. */
function centralDirectory(archive: Buffer): CentralEntry[] {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(-1);
  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const entries: CentralEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    entries.push({
      name: archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"),
      compressedSize,
      localHeaderOffset: archive.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Reads one entry back out of the archive the way a zip reader would. */
function readEntry(archive: Buffer, entry: CentralEntry): Buffer {
  const header = entry.localHeaderOffset;
  expect(archive.readUInt32LE(header)).toBe(0x04034b50);
  const nameLength = archive.readUInt16LE(header + 26);
  const extraLength = archive.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  return inflateRawSync(archive.subarray(start, start + entry.compressedSize));
}

describe("the zip writer hands each written entry's memory back to yazl", () => {
  it("produces an archive that still reads back byte for byte", async () => {
    // yazl keeps every entry in a list it cannot prune — end() walks that list
    // for the central directory — and each entry still carries the closure that
    // captures its compressed payload. The writer drops that closure once the
    // entry has been written, so this is the case that would break if it dropped
    // it too early: a payload written twice, or not at all.
    const zip = new ZipFile();
    outputOf(zip).on("error", () => undefined);
    const chunks: Buffer[] = [];
    outputOf(zip).on("data", (chunk: Buffer) => { chunks.push(chunk); });
    const writer = createBackupZipWriter(zip, { maxInFlightBytes: 64 * 1024 });
    const sources = new Map<string, Buffer>();
    const total = 24;

    for (let index = 0; index < total; index += 1) {
      const path = `emails/${String(index).padStart(4, "0")}.eml`;
      // Distinct, non-uniform content, so a shifted or duplicated payload cannot
      // pass by being all zeros.
      const source = incompressible(4096).fill(index % 256, 0, 2048);
      sources.set(path, source);
      await writer.add(source, path);
    }
    await writer.flush();
    zip.end();
    await new Promise<void>((resolve) => { outputOf(zip).on("end", () => resolve()); });

    const archive = Buffer.concat(chunks);
    const entries = centralDirectory(archive);
    expect(entries.map((entry) => entry.name)).toEqual([...sources.keys()]);
    for (const entry of entries) {
      expect(readEntry(archive, entry).equals(sources.get(entry.name))).toBe(true);
    }
    // Every entry that was written had its pump replaced, so none of them still
    // holds its compressed payload.
    const internals = zip as unknown as YazlInternalsShape;
    const pumps = (internals.entries ?? []).map((entry) => (entry as { doFileDataPump?: unknown }).doFileDataPump);
    expect(pumps).toHaveLength(total);
    expect(pumps.every((pump) => typeof pump === "function")).toBe(true);
    expect(new Set(pumps).size).toBe(1);
  });
});

// --------------------------------------------------------------- 4 closed --

describe("a download that goes away ends the export", () => {
  it("rejects the writer once the socket is gone", async () => {
    const zip = new ZipFile();
    outputOf(zip).on("error", () => undefined);
    let gone = false;
    const writer = createBackupZipWriter(zip, { isAborted: () => gone });

    await writer.add(incompressible(4096), "emails/0001_message.eml");
    gone = true;

    await expect(writer.add(incompressible(4096), "emails/0002_message.eml")).rejects.toBeInstanceOf(BackupTransferClosedError);
    expect(writer.closed).toBe(true);
    // flush() is the tail of the export and must not throw on a dead transfer.
    await expect(writer.flush()).resolves.toBeUndefined();
  });

  it("releases a writer that is parked on a stream that dies under it", async () => {
    const zip = new ZipFile();
    outputOf(zip).on("error", () => undefined);
    const writer = createBackupZipWriter(zip, { maxInFlightBytes: 1024 });
    const source = incompressible(64 * 1024);

    const pending = writer.add(source, "emails/0001_message.eml");
    await vi.waitFor(() => expect(outputOf(zip).writableNeedDrain).toBe(true));

    // A write to a destroyed PassThrough returns false without ever raising
    // writableNeedDrain, so a parked writer would wait for a drain that can no
    // longer come. It has to be woken by the stream's own close.
    outputOf(zip).destroy();
    await expect(pending).rejects.toBeInstanceOf(BackupTransferClosedError);
    expect(writer.closed).toBe(true);
  });
});

// --------------------------------------------------------- collector exit --

describe("collectMailBackup when the download is closed mid-run", () => {
  const now = "2026-08-10T00:00:00.000Z";

  function fixture(count: number): DatabaseHandle {
    const db = openDatabase(":memory:");
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
    for (let uid = 1; uid <= count; uid += 1) {
      const sentAt = new Date(Date.parse(now) + uid * 1000).toISOString();
      insert.run(`message-${uid}`, uid, `Subject ${uid}`, sentAt, sentAt);
    }
    return db;
  }

  it("stops the walk without booking a folder failure or leaving a rejection behind", async () => {
    vi.clearAllMocks();
    const db = fixture(250);
    const lock = { release: vi.fn() };
    const client = {
      usable: true,
      connect: vi.fn(async () => undefined),
      getMailboxLock: vi.fn(async () => lock),
      fetch: vi.fn(async function* fetch(uids: number[]) {
        for (const uid of uids) yield { uid, source: Buffer.from(`source ${uid}`) };
      }),
      logout: vi.fn(async () => undefined),
    };
    imapClientForAccount.mockReturnValue(client);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    let emitted = 0;
    let report: Awaited<ReturnType<typeof collectMailBackup>> | undefined;
    let account: unknown;
    let fetches = 0;
    let firstFetch: number[] = [];
    let released = false;
    let loggedOut = false;
    try {
      report = await collectMailBackup(db, Buffer.alloc(32, 21), {
        emit: () => {
          emitted += 1;
          // Exactly what the route's writer does once the client is gone.
          if (emitted === 3) throw new BackupTransferClosedError();
        },
      });
      // Give any stray promise a full turn to reject into nowhere.
      await sleep(50);
      account = db.prepare("SELECT status, last_error, last_error_code FROM accounts WHERE id = 'account-1'").get();
      fetches = client.fetch.mock.calls.length;
      firstFetch = (client.fetch.mock.calls[0]?.[0] ?? []) as number[];
      released = lock.release.mock.calls.length > 0;
      loggedOut = client.logout.mock.calls.length > 0;
    } finally {
      process.off("unhandledRejection", onUnhandled);
      db.close();
    }

    expect(unhandled).toEqual([]);
    expect(emitted).toBe(3);
    // The messages that were never attempted are not booked as failures, and
    // the two that made it are still counted as exported.
    expect(report).toMatchObject({ exported: 2, failed: [] });
    // The mailbox is fine — a client closing a download tab is not an account
    // error, so the row must not be touched. This is the difference between this
    // error and every other emit failure.
    expect(account).toMatchObject({ status: "connected", last_error: null, last_error_code: null });
    // The walk stops instead of working through the remaining 150 messages.
    expect(fetches).toBe(1);
    expect(firstFetch).toHaveLength(100);
    // The folder is still closed down properly.
    expect(released).toBe(true);
    expect(loggedOut).toBe(true);
  });
});

