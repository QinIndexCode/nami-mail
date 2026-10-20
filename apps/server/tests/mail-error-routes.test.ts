import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as attachmentsModule from "../src/attachments.js";
import type * as draftsModule from "../src/drafts.js";
import type * as mailModule from "../src/mail.js";
import type * as syncFlagsModule from "../src/sync-flags.js";
import type * as syncModule from "../src/sync.js";

const { sendMail, testAccountConnection } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  testAccountConnection: vi.fn(),
}));
const { syncAccount, updateMessageFlags } = vi.hoisted(() => ({
  syncAccount: vi.fn(),
  updateMessageFlags: vi.fn(),
}));
const { saveDraft } = vi.hoisted(() => ({ saveDraft: vi.fn() }));
const { downloadMessageAttachment } = vi.hoisted(() => ({ downloadMessageAttachment: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, sendMail, testAccountConnection };
});

vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof syncModule>();
  return { ...actual, syncAccount };
});

vi.mock("../src/sync-flags.js", async (importOriginal) => {
  const actual = await importOriginal<typeof syncFlagsModule>();
  return { ...actual, updateMessageFlags };
});

vi.mock("../src/drafts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof draftsModule>();
  return { ...actual, saveDraft };
});

vi.mock("../src/attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof attachmentsModule>();
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
    insertAccount(db, "00000000-0000-4000-8000-000000000001");
    const secret = "do-not-return-this-secret";
    syncAccount.mockRejectedValueOnce(Object.assign(new Error(`certificate has expired ${secret}`), { code: "CERT_HAS_EXPIRED" }));

    const response = await app.inject({ method: "POST", url: "/api/accounts/00000000-0000-4000-8000-000000000001/sync" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ ok: false, code: "tls_certificate_failed" });
    expect(response.body).not.toContain(secret);
  });

  it("keeps a send's transport failure off the response, which is the task's business now", async () => {
    insertAccount(db);
    const secret = "do-not-return-this-secret";
    sendMail.mockRejectedValue(Object.assign(new Error(`connect ECONNREFUSED password=${secret}`), { code: "ECONNREFUSED" }));

    const accepted = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: { accountId: "account-1", to: ["recipient@example.com"], subject: "Test", text: "Body" },
    });

    // The acceptance: the answer carries no classification, no error code and no
    // room for a transport failure -- the previous shape answered this request
    // with a 503 the moment SMTP refused the connection.
    expect(accepted.statusCode).toBe(202);
    const acceptedBody = accepted.json() as { deliveryStatus: string; taskId?: string; submission: { id: string } };
    expect(acceptedBody).toMatchObject({ ok: true, deliveryStatus: "pending", status: "pending" });
    expect(accepted.body).not.toContain(secret);
    expect(accepted.body).not.toContain("ECONNREFUSED");
    expect(acceptedBody.taskId).toBeTruthy();

    // The exit: `connection_refused` is on the known pre-acceptance list, so
    // nothing was transferred and the correct attitude is a retry rather than a
    // verdict the user has to act on. The classification lands on the ledger and
    // the retry ladder belongs to the scheduler (pinned by its own test); what
    // this route no longer does is put either on the wire.
    //
    // The retryable arm writes two renderable places, so both are checked. The
    // ledger's message is not a column -- it lives encrypted in the details
    // envelope and is only legible through the API -- so the ledger is read back
    // the way a user would (`GET /api/submissions/:id`), while the task row's
    // `error_message` is a genuine column the release-for-retry writes and
    // `taskProgress` shows. On both, the code has to survive while the text is
    // replaced: neither half alone would catch a regression, because a raw
    // message still carries the code and a dropped code still has safe text.
    await vi.waitFor(() => {
      const ledger = db.prepare("SELECT status, error_code FROM outbound_submissions WHERE id = ?").get(acceptedBody.submission.id);
      expect(ledger).toMatchObject({ status: "failed", error_code: "connection_refused" });

      // The task row is written a moment later, when the retryable throw has
      // reached the scheduler and it releases the row for another attempt.
      const task = db.prepare("SELECT error_code, error_message FROM tasks WHERE id = ?").get(acceptedBody.taskId) as
        | { error_code: string | null; error_message: string | null } | undefined;
      expect(task?.error_code).toBe("connection_refused");
      // The empty string satisfies both `not.toContain` claims below, so the
      // non-emptiness has to be asserted: without this line a build that recorded
      // no message at all would pass the pair that exists to catch a leak.
      const errorMessage = task?.error_message ?? "";
      expect(errorMessage).not.toBe("");
      expect(errorMessage).not.toContain(secret);
      expect(errorMessage).not.toContain("ECONNREFUSED");
      // Vitest's default is 1s, which is a wall-clock budget for the whole
      // acceptance path -- the scheduler's claim, the SMTP attempt and the
      // release. Wide on purpose: this test has no interest in how fast the
      // machine is, and a timeout here is a false red.
    }, { timeout: 10_000 });

    const lookup = await app.inject({ method: "GET", url: `/api/submissions/${acceptedBody.submission.id}` });
    expect(lookup.statusCode).toBe(200);
    const reported = (lookup.json() as { submission: { errorCode: string | null; errorMessage: string | null } }).submission;
    expect(reported.errorCode).toBe("connection_refused");
    expect(reported.errorMessage).toBeTruthy();
    expect(lookup.body).not.toContain(secret);
    expect(lookup.body).not.toContain("ECONNREFUSED");
  });

  it("keeps a flag write local-first, so the transport failure is the outbox's and not the response's", async () => {
    // The move route left this table with the task switch (contract §0.4 十五):
    // it no longer dials the provider, so there is no transport failure left for
    // it to classify. A move's provider failure is now the runner's -- retried,
    // and reported through the task's own status -- while the classification
    // itself is still pinned in `mail-error-taxonomy.test.ts`.
    insertAccount(db);
    db.prepare(`
      INSERT INTO messages (id, account_id, mailbox, uid, flags_json, has_attachments, attachments_json, size, created_at)
      VALUES ('message-1', 'account-1', 'INBOX', 1, '[]', 0, '[]', 0, ?)
    `).run(new Date().toISOString());

    const flagResponse = await app.inject({
      method: "PATCH",
      url: "/api/messages/message-1",
      payload: { seen: true },
    });

    // Write-behind: the flag action commits locally and succeeds immediately;
    // a transport failure surfaces later as a retried flags-push row, never
    // as an error response to the user.
    expect(flagResponse.statusCode).toBe(200);
    expect(flagResponse.json()).toMatchObject({ ok: true });
    const marker = db.prepare("SELECT pending_flags_push FROM messages WHERE id = ?").get("message-1") as { pending_flags_push: number };
    expect(marker.pending_flags_push).toBe(1);
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
      url: "/api/messages/2f1c6a3e4b7d4c8e9f101a2b3c4d5e6f/attachments/part-1",
    });

    expect(draftResponse.statusCode).toBe(503);
    expect(draftResponse.json()).toMatchObject({ ok: false, code: "connection_refused" });
    expect(draftResponse.body).not.toContain(secret);
    expect(attachmentResponse.statusCode).toBe(503);
    expect(attachmentResponse.json()).toMatchObject({ ok: false, code: "server_not_found" });
    expect(attachmentResponse.body).not.toContain(secret);
  });
});

