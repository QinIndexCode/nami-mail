import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallerContext } from "@nami/agent-contracts";
import type { MailApplicationContext } from "../src/agent/mail-application-service.js";
import { SqliteMailApplicationService } from "../src/agent/sqlite-mail-application-service.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { prepareSubmission, submissionForId } from "../src/outbox.js";
import { acceptPreparedSendTask, type SendAcceptance } from "../src/tasks/kinds/send.js";
import { taskRow } from "../src/tasks/store.js";
import type { AccountRecord } from "../src/types.js";

/**
 * The Agent's submit half: it must hand an already-prepared ledger row to the
 * task layer and report the state that was persisted, not a transport outcome.
 *
 * The acceptance is the real one, wired to a no-op starter. A fake would let the
 * two halves drift -- the service could keep returning `submitted` while the
 * acceptance parked a task -- which is the exact shape this port replaced.
 */

const ACCOUNT = "account-1";
const MASTER_KEY = randomBytes(32);

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ACCOUNT, "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", new Date().toISOString());
}

function caller(accountIds: string[] = [ACCOUNT]): CallerContext {
  return {
    callerId: "test-user",
    kind: "test" as const,
    entryPoint: "test" as const,
    accessLevel: "full-access" as const,
    scopes: ["send:mail"] as const,
    accountScope: accountIds.length ? { mode: "selected" as const, accountIds } : { mode: "none" as const },
    interactive: true,
    canRequestConfirmation: true,
  };
}

function context(accountIds: string[] = [ACCOUNT]): MailApplicationContext {
  return {
    requestId: "5ac1cf6b-64f3-4c4f-8e0e-7a6b3f5b5f1f",
    caller: caller(accountIds),
    accountIds,
  };
}

function serviceWith(
  db: DatabaseHandle,
  acceptPreparedSend?: (input: { account: AccountRecord; submissionId: string }) => SendAcceptance,
) {
  return new SqliteMailApplicationService({
    db,
    masterKey: MASTER_KEY,
    syncMessageLimit: 20,
    outboundAttachmentDirectory: "outbound-attachments-agent-submit-test",
    ...(acceptPreparedSend ? { acceptPreparedSend } : {}),
  });
}

let db: DatabaseHandle;

beforeEach(() => {
  db = openDatabase(":memory:");
  insertAccount(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("Agent submitPreparedMail", () => {
  it("accepts the prepared ledger row through the task layer and reports its durable status", async () => {
    const { submission } = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: "demo@example.com",
      request: { to: ["friend@example.com"], subject: "Hello", text: "Body", attachmentTokens: [] },
    });
    const accept = vi.fn((input: { account: AccountRecord; submissionId: string }) =>
      acceptPreparedSendTask({ db, masterKey: MASTER_KEY, scheduler: { start: () => undefined } }, input));
    const service = serviceWith(db, accept);

    const result = await service.submitPreparedMail(context(), submission.id);

    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0]![0]).toMatchObject({ account: { id: ACCOUNT, email: "demo@example.com" }, submissionId: submission.id });
    // The answer is the ledger's own status -- `pending` because the runner owns
    // the socket now -- and a task exists under the submission id.
    expect(result).toEqual({ submissionId: submission.id, accountId: ACCOUNT, status: "pending" });
    expect(taskRow(db, submission.id)).toMatchObject({ kind: "send", status: "pending", total: 1 });
    expect(submissionForId(db, MASTER_KEY, submission.id)?.deliveryStatus).toBe("pending");
  });

  it("reports not_found for a submission that no longer exists", async () => {
    const service = serviceWith(db, vi.fn());

    await expect(service.submitPreparedMail(context(), "missing-submission")).rejects.toMatchObject({
      code: "not_found",
      message: "The prepared mail submission is no longer available.",
    });
  });

  it("refuses instead of falling back to an inline send when no scheduler is attached", async () => {
    const { submission } = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: "demo@example.com",
      request: { to: ["friend@example.com"], subject: "Hello", text: "Body", attachmentTokens: [] },
    });
    const service = serviceWith(db);

    await expect(service.submitPreparedMail(context(), submission.id)).rejects.toMatchObject({
      code: "not_supported",
      message: "This host cannot dispatch mail: no task scheduler is attached.",
    });
  });

  it("fails closed before the acceptance when the account is out of scope", async () => {
    const { submission } = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: "demo@example.com",
      request: { to: ["friend@example.com"], subject: "Hello", text: "Body", attachmentTokens: [] },
    });
    const accept = vi.fn();
    const service = serviceWith(db, accept);

    await expect(service.submitPreparedMail(context([]), submission.id)).rejects.toMatchObject({ code: "scope_denied" });
    expect(accept).not.toHaveBeenCalled();
  });
});
