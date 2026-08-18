import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";

// Backup streams RFC822 sources from the provider; stub the IMAP transport so
// the collect step never touches a real network.
const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import { buildApp } from "../src/app.js";
import { backupEntryName, collectMailBackup } from "../src/backup.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

const now = "2026-08-10T00:00:00.000Z";

function insertAccount(db: DatabaseHandle, id: string, email: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, email, "custom", "Demo", "encrypted",
    "imap.example.com", 993, 1, "smtp.example.com", 465, 1,
    "email", "connected", now,
  );
}

function insertMessage(
  db: DatabaseHandle,
  message: {
    id: string;
    accountId: string;
    mailbox: string;
    uid: number;
    subject: string;
    sentAt: string;
    pendingMoveState?: string;
    pendingMoveDestination?: string;
  },
): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments,
      attachment_kinds_json, size, created_at, pending_move_state, pending_move_destination
    ) VALUES (?, ?, ?, ?, ?, 'Sender', 'sender@example.com', '[]',
      ?, '', '', '', '[]', 0, '[]', 0, ?, ?, ?)
  `).run(
    message.id, message.accountId, message.mailbox, message.uid, message.subject,
    message.sentAt, message.sentAt ?? now,
    message.pendingMoveState ?? null,
    message.pendingMoveDestination ?? null,
  );
}

function makeClient(sourceByUid: Record<number, Buffer>) {
  const lock = { release: vi.fn() };
  return {
    usable: true,
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => lock),
    fetch: vi.fn(async function* fetch(uids: number[]) {
      for (const uid of uids) {
        const source = sourceByUid[uid];
        if (source) yield { uid, source };
      }
    }),
    logout: vi.fn(async () => undefined),
  };
}

const subjectA = "Quarterly\n report/2026";
const subjectB = "退款: 订单 #42?";
const subjectC = "Vacation photos";

describe("backupEntryName", () => {
  it("mangles separators and control characters out of entry paths", () => {
    expect(backupEntryName(subjectA, 1)).toBe("emails/0001_Quarterly  report 2026.eml");
    // The colon and question mark become spaces (the original space after the
    // colon stays), so two spaces separate 退款 and 订单.
    expect(backupEntryName(subjectB, 2)).toBe("emails/0002_退款  订单 #42.eml");
  });

  it("falls back for empty subjects and keeps the padded index", () => {
    expect(backupEntryName("   ", 12)).toBe("emails/0012_message.eml");
    expect(backupEntryName("", 1)).toBe("emails/0001_message.eml");
  });
});

describe("collectMailBackup", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    db = openDatabase(":memory:");
    insertAccount(db, "account-1", "one@example.com");
    insertAccount(db, "account-2", "two@example.com");
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 21) });
  });

  it("fetches every message over one connection per (account, mailbox) group", async () => {
    const source = Buffer.from("From: one@example.com\r\n\r\nHi");
    // Rows are ordered by mailbox, then sent time; Archive sorts before INBOX.
    insertMessage(db, { id: "message-1", accountId: "account-1", mailbox: "INBOX", uid: 11, subject: subjectA, sentAt: now });
    insertMessage(db, { id: "message-2", accountId: "account-1", mailbox: "INBOX", uid: 12, subject: subjectB, sentAt: "2026-08-09T23:00:00.000Z" });
    insertMessage(db, { id: "message-3", accountId: "account-1", mailbox: "Archive", uid: 31, subject: subjectC, sentAt: "2026-08-09T22:00:00.000Z" });
    const client = makeClient({ 11: source, 12: source, 31: source });
    imapClientForAccount.mockReturnValue(client);

    const entries: { path: string; source: Buffer }[] = [];
    const report = await collectMailBackup(db, Buffer.alloc(32, 21), { emit: (entry) => entries.push(entry) });

    expect(report).toMatchObject({ accountCount: 1, messageCount: 3, exported: 3, failed: [] });
    expect(imapClientForAccount).toHaveBeenCalledTimes(2);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(client.getMailboxLock).toHaveBeenCalledWith("Archive");
    expect(client.fetch).toHaveBeenCalledWith(expect.arrayContaining([11, 12]), expect.objectContaining({ source: true }), expect.objectContaining({ uid: true }));
    expect(client.fetch).toHaveBeenCalledWith([31], expect.objectContaining({ source: true }), expect.objectContaining({ uid: true }));
    expect(new Set(entries.map((entry) => entry.path))).toEqual(
      new Set(["emails/0001_Vacation photos.eml", "emails/0002_退款  订单 #42.eml", "emails/0003_Quarterly  report 2026.eml"]),
    );
    expect(entries.every((entry) => entry.source.equals(source))).toBe(true);
  });

  it("records a per-message failure without aborting the rest of the folder", async () => {
    insertMessage(db, { id: "message-1", accountId: "account-1", mailbox: "INBOX", uid: 11, subject: subjectA, sentAt: now });
    insertMessage(db, { id: "message-2", accountId: "account-1", mailbox: "INBOX", uid: 12, subject: subjectB, sentAt: now });
    const client = makeClient({ 12: Buffer.from("ok") });
    client.fetch.mockImplementation(async function* fetch(uids: number[]) {
      for (const uid of uids) {
        yield uid === 11 ? { uid: 99, source: Buffer.from("stale") } : { uid, source: Buffer.from("ok") };
      }
    });
    imapClientForAccount.mockReturnValue(client);

    const report = await collectMailBackup(db, Buffer.alloc(32, 21));

    expect(report.exported).toBe(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ messageId: "message-1", code: "unknown" });
  });

  it("fails every message in a group whose connection cannot be opened and records the classified code", async () => {
    insertMessage(db, { id: "message-1", accountId: "account-1", mailbox: "AAA-broken", uid: 11, subject: subjectA, sentAt: now });
    insertMessage(db, { id: "message-2", accountId: "account-1", mailbox: "ZZZ-healthy", uid: 31, subject: subjectC, sentAt: "2026-08-09T22:00:00.000Z" });
    const broken = makeClient({});
    broken.connect.mockRejectedValue(new Error("connection refused"));
    const healthy = makeClient({ 31: Buffer.from("ok") });
    imapClientForAccount.mockImplementationOnce(() => broken).mockReturnValue(healthy);

    const report = await collectMailBackup(db, Buffer.alloc(32, 21));

    expect(report.exported).toBe(1);
    expect(report.failed.map((failure) => failure.messageId)).toEqual(["message-1"]);
    expect(report.failed[0]).toMatchObject({ code: "connection_refused" });
    expect(report.failed[0].reason).toContain("connection refused");
    expect(db.prepare("SELECT status, last_error, last_error_code FROM accounts WHERE id = ?").get("account-1")).toMatchObject({
      status: "error",
      last_error_code: "connection_refused",
    });
  });

  it("skips messages with an unconfirmed pending move", async () => {
    insertMessage(db, {
      id: "message-1", accountId: "account-1", mailbox: "INBOX", uid: 11, subject: subjectA, sentAt: now,
      pendingMoveState: "intent", pendingMoveDestination: "Trash",
    });
    insertMessage(db, { id: "message-2", accountId: "account-1", mailbox: "INBOX", uid: 12, subject: subjectB, sentAt: "2026-08-09T23:00:00.000Z" });
    const client = makeClient({ 12: Buffer.from("ok") });
    imapClientForAccount.mockReturnValue(client);

    const report = await collectMailBackup(db, Buffer.alloc(32, 21));

    expect(report.exported).toBe(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].messageId).toBe("message-1");
    expect(client.fetch).not.toHaveBeenCalledWith(expect.arrayContaining([11]), expect.anything(), expect.anything());
  });

  it("splits very large folders into bounded batched fetches", async () => {
    const source = Buffer.from("From: one@example.com\r\n\r\nHi");
    for (let uid = 1; uid <= 101; uid += 1) {
      insertMessage(db, {
        id: `message-${uid}`, accountId: "account-1", mailbox: "INBOX", uid,
        subject: `Subject ${uid}`, sentAt: now,
      });
    }
    const client = makeClient(Object.fromEntries(Array.from({ length: 101 }, (_, offset) => [offset + 1, source])));
    imapClientForAccount.mockReturnValue(client);

    const report = await collectMailBackup(db, Buffer.alloc(32, 21));

    expect(report).toMatchObject({ exported: 101, failed: [] });
    expect(client.fetch).toHaveBeenCalledTimes(2);
    expect(client.fetch.mock.calls[0][0]).toHaveLength(100);
    expect(client.fetch.mock.calls[1][0]).toEqual([101]);
  });

  it("serves a streaming zip over /api/backup without flattening the server", async () => {
    insertMessage(db, { id: "message-1", accountId: "account-1", mailbox: "INBOX", uid: 11, subject: subjectA, sentAt: now });
    insertMessage(db, { id: "message-2", accountId: "account-2", mailbox: "INBOX", uid: 21, subject: subjectC, sentAt: now });
    const client = makeClient({ 11: Buffer.from("first"), 21: Buffer.from("second") });
    imapClientForAccount.mockReturnValue(client);

    const response = await app.inject({ method: "GET", url: "/api/backup" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.headers["content-disposition"]).toContain("nami-mail-backup-");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
    const payload = Buffer.from(response.rawPayload);
    expect(payload.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    // The end-of-central-directory record is a fixed 22 bytes at the tail.
    expect(payload.length - payload.indexOf(Buffer.from("PK\u0005\u0006"))).toBe(22);
    expect(payload.includes(Buffer.from("emails/0001_Quarterly  report 2026.eml"))).toBe(true);
    expect(payload.includes(Buffer.from("export-report.json"))).toBe(true);
  });
});

describe("yazl streaming", () => {
  it("produces a zip envelope that starts with a local header and ends with the central directory", async () => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve) => zip.outputStream.on("end", () => resolve()));
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.addBuffer(Buffer.from("content"), "emails/0001_message.eml");
    zip.end();
    await done;
    const output = Buffer.concat(chunks);
    expect(output.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    expect(output.length - output.indexOf(Buffer.from("PK\u0005\u0006"))).toBe(22);
  });
});