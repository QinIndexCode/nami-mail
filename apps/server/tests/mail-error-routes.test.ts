import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail, testAccountConnection } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  testAccountConnection: vi.fn(),
}));
const { syncAccount, updateMessageFlags, moveMessage } = vi.hoisted(() => ({
  syncAccount: vi.fn(),
  updateMessageFlags: vi.fn(),
  moveMessage: vi.fn(),
}));
const { saveDraft } = vi.hoisted(() => ({ saveDraft: vi.fn() }));
const { downloadMessageAttachment } = vi.hoisted(() => ({ downloadMessageAttachment: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, sendMail, testAccountConnection };
});

vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync.js")>();
  return { ...actual, syncAccount, updateMessageFlags, moveMessage };
});

vi.mock("../src/drafts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/drafts.js")>();
  return { ...actual, saveDraft };
});

vi.mock("../src/attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/attachments.js")>();
  return { ...actual, downloadMessageAttachment };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
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

describe("mail transport error API responses", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 9) });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) db.close();
  });

  it("returns a retryable network code for account verification without exposing raw details", async () => {
    const secret = "do-not-return-this-secret";
    testAccountConnection.mockRejectedValueOnce(Object.assign(new Error(`connect ENETUNREACH password=${secret}`), { code: "ENETUNREACH" }));

    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/test",
      payload: { email: "person@qq.com", password: "not-a-real-password" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, code: "network_unavailable" });
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain("ENETUNREACH");
  });

  it("returns the same safe code when a saved account sync cannot verify TLS", async () => {
    insertAccount(db);
    const secret = "do-not-return-this-secret";
    syncAccount.mockRejectedValueOnce(Object.assign(new Error(`certificate has expired ${secret}`), { code: "CERT_HAS_EXPIRED" }));

    const response = await app.inject({ method: "POST", url: "/api/accounts/account-1/sync" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ ok: false, code: "tls_certificate_failed" });
    expect(response.body).not.toContain(secret);
  });

  it("returns a connection-refused code when sending fails before SMTP accepts the message", async () => {
    insertAccount(db);
    sendMail.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));

    const response = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: { accountId: "account-1", to: ["recipient@example.com"], subject: "Test", text: "Body" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, code: "connection_refused" });
  });

  it("keeps flag and move transport failures classified and redacted", async () => {
    const secret = "do-not-return-this-secret";
    updateMessageFlags.mockRejectedValueOnce(Object.assign(new Error(`connect ENETUNREACH password=${secret}`), { code: "ENETUNREACH" }));
    moveMessage.mockRejectedValueOnce(Object.assign(new Error(`write EPROTO ${secret}`), { code: "EPROTO" }));

    const flagResponse = await app.inject({
      method: "PATCH",
      url: "/api/messages/message-1",
      payload: { seen: true },
    });
    const moveResponse = await app.inject({
      method: "POST",
      url: "/api/messages/message-1/move",
      payload: { target: "archive" },
    });

    expect(flagResponse.statusCode).toBe(503);
    expect(flagResponse.json()).toMatchObject({ ok: false, code: "network_unavailable" });
    expect(flagResponse.body).not.toContain(secret);
    expect(moveResponse.statusCode).toBe(422);
    expect(moveResponse.json()).toMatchObject({ ok: false, code: "tls_handshake_failed" });
    expect(moveResponse.body).not.toContain(secret);
  });

  it("keeps a confirmed move successful while scheduling a best-effort cache refresh", async () => {
    moveMessage.mockResolvedValueOnce({ accountId: "account-1", destination: "[Gmail]/All Mail", refreshPending: true });
    syncAccount.mockRejectedValueOnce(new Error("refresh unavailable"));

    const response = await app.inject({
      method: "POST",
      url: "/api/messages/message-1/move",
      payload: { target: "archive" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, destination: "[Gmail]/All Mail", refreshPending: true });
    await vi.waitFor(() => {
      expect(syncAccount).toHaveBeenCalledWith(db, expect.any(Buffer), "account-1", expect.any(Number), undefined);
    });
  });

  it("keeps draft-save and attachment-download transport failures classified and redacted", async () => {
    insertAccount(db);
    const secret = "do-not-return-this-secret";
    saveDraft.mockRejectedValueOnce(Object.assign(new Error(`connect ECONNREFUSED token=${secret}`), { code: "ECONNREFUSED" }));
    downloadMessageAttachment.mockRejectedValueOnce(Object.assign(new Error(`getaddrinfo ENOTFOUND ${secret}`), { code: "ENOTFOUND" }));

    const draftResponse = await app.inject({
      method: "POST",
      url: "/api/messages/drafts",
      payload: { accountId: "account-1", subject: "Draft", text: "Body" },
    });
    const attachmentResponse = await app.inject({
      method: "GET",
      url: "/api/messages/message-1/attachments/part-1",
    });

    expect(draftResponse.statusCode).toBe(503);
    expect(draftResponse.json()).toMatchObject({ ok: false, code: "connection_refused" });
    expect(draftResponse.body).not.toContain(secret);
    expect(attachmentResponse.statusCode).toBe(503);
    expect(attachmentResponse.json()).toMatchObject({ ok: false, code: "server_not_found" });
    expect(attachmentResponse.body).not.toContain(secret);
  });
});
