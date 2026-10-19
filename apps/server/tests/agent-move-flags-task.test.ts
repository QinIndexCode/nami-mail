import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallerContext } from "@nami/agent-contracts";
import type { MailApplicationContext } from "../src/agent/mail-application-service.js";
import { SqliteMailApplicationService } from "../src/agent/sqlite-mail-application-service.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { MOVE_FOLDER_UNAVAILABLE_ERROR } from "../src/move-destinations.js";
import { PENDING_MOVE_RECONCILIATION_ERROR } from "../src/message-storage.js";
import { acceptFlagsTask, type FlagsTaskAcceptance } from "../src/tasks/kinds/flags.js";
import { acceptMoveTask, type MoveTaskAcceptance, type MoveTaskDestination } from "../src/tasks/kinds/move.js";
import { openTaskPayload, taskRow } from "../src/tasks/store.js";

/**
 * The Agent's two remaining write paths: flags and moves.
 *
 * Both used to call the sync modules directly, which meant an Agent write could
 * block on IMAP and leave no durable record of what it owed. The contract's
 * batch 5 makes them take the same shape as every other user-visible write --
 * local target state plus a task in one transaction -- so these tests pin the
 * seam (the acceptance is called, and with what) and the observable result (the
 * row's local state and the task row), not the transport.
 *
 * The acceptances are the real ones wired to a no-op starter. A fake would let
 * the service and the task layer drift: the service could answer success while
 * nothing was committed, which is exactly the failure this port removes.
 */

const ACCOUNT = "account-1";
const MESSAGE = "message-1";
const SOURCE = "INBOX";
const ARCHIVE = "Archive";
const PROJECTS = "Projects";
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

function insertFolder(db: DatabaseHandle, path: string, specialUse: string): void {
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
    .run(ACCOUNT, path, path, specialUse);
}

function insertMessage(db: DatabaseHandle, flags: string[] = ["\\Unseen"]): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(MESSAGE, ACCOUNT, SOURCE, 1, "Subject", "Demo", "demo@example.com", "[]", new Date().toISOString(), "", "", "", JSON.stringify(flags), 0, 0, new Date().toISOString());
}

function caller(): CallerContext {
  return {
    callerId: "test-user",
    kind: "test" as const,
    entryPoint: "test" as const,
    accessLevel: "full-access" as const,
    scopes: ["send:mail"] as const,
    accountScope: { mode: "selected" as const, accountIds: [ACCOUNT] },
    interactive: true,
    canRequestConfirmation: true,
  };
}

function context(accountIds: string[] = [ACCOUNT]): MailApplicationContext {
  return {
    requestId: "5ac1cf6b-64f3-4c4f-8e0e-7a6b3f5b5f1f",
    caller: caller(),
    accountIds,
  };
}

type AcceptFlags = (input: { messageIds: readonly string[]; patch: { seen?: boolean; flagged?: boolean } }) => FlagsTaskAcceptance;
type AcceptMove = (input: { messageIds: readonly string[]; destination: MoveTaskDestination }) => MoveTaskAcceptance;

function serviceWith(
  db: DatabaseHandle,
  acceptFlags?: AcceptFlags,
  acceptMove?: AcceptMove,
): SqliteMailApplicationService {
  return new SqliteMailApplicationService({
    db,
    masterKey: MASTER_KEY,
    syncMessageLimit: 20,
    outboundAttachmentDirectory: "outbound-attachments-agent-writes-test",
    ...(acceptFlags ? { acceptFlags } : {}),
    ...(acceptMove ? { acceptMove } : {}),
  });
}

/** The real acceptances against a scheduler that only records a start. */
function realAcceptFlags(db: DatabaseHandle): AcceptFlags {
  return (input) => acceptFlagsTask({ db, masterKey: MASTER_KEY, scheduler: { start: () => undefined } }, input);
}

function realAcceptMove(db: DatabaseHandle): AcceptMove {
  return (input) => acceptMoveTask({ db, masterKey: MASTER_KEY, scheduler: { start: () => undefined } }, input);
}

function flagsOf(db: DatabaseHandle): string[] {
  const row = db.prepare("SELECT flags_json FROM messages WHERE id = ?").get(MESSAGE) as { flags_json: string };
  return JSON.parse(row.flags_json) as string[];
}

function goalOf(db: DatabaseHandle): { destination: string | null; state: string | null } {
  return db.prepare("SELECT pending_move_destination AS destination, pending_move_state AS state FROM messages WHERE id = ?").get(MESSAGE) as {
    destination: string | null;
    state: string | null;
  };
}

let db: DatabaseHandle;

beforeEach(() => {
  db = openDatabase(":memory:");
  insertAccount(db);
  insertFolder(db, SOURCE, "\\Inbox");
  insertFolder(db, ARCHIVE, "\\Archive");
  insertFolder(db, PROJECTS, "");
  insertMessage(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("Agent updateMessageFlags", () => {
  it("commits the requested state locally and a push task, then returns", async () => {
    const service = serviceWith(db, realAcceptFlags(db));

    await service.updateMessageFlags(context(), MESSAGE, { seen: true });

    expect(flagsOf(db)).toContain("\\Seen");
    const tasks = db.prepare("SELECT id, kind, status, total FROM tasks").all() as Array<{ id: string; kind: string; status: string; total: number }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "flags", status: "pending", total: 1 });
    expect(openTaskPayload(MASTER_KEY, taskRow(db, tasks[0]!.id)!)).toMatchObject({
      accountId: ACCOUNT,
      entries: [{ id: MESSAGE }],
    });
  });

  it("hands the acceptance exactly the one id and the patch", async () => {
    const acceptFlags = vi.fn(() => ({ handles: [], updated: 1, failed: 0, changedIds: [MESSAGE] }));
    const service = serviceWith(db, acceptFlags);

    await service.updateMessageFlags(context(), MESSAGE, { flagged: true });

    expect(acceptFlags).toHaveBeenCalledTimes(1);
    expect(acceptFlags).toHaveBeenCalledWith({ messageIds: [MESSAGE], patch: { flagged: true } });
  });

  it("refuses instead of writing inline when no scheduler is attached", async () => {
    const service = serviceWith(db);

    await expect(service.updateMessageFlags(context(), MESSAGE, { seen: true })).rejects.toMatchObject({
      code: "not_supported",
      message: "This host cannot update message flags: no task scheduler is attached.",
    });
    expect(flagsOf(db)).not.toContain("\\Seen");
  });

  it("answers a row another move owns with the reconciliation refusal", async () => {
    db.prepare("UPDATE messages SET pending_move_destination = ? WHERE id = ?").run(ARCHIVE, MESSAGE);
    const service = serviceWith(db, realAcceptFlags(db));

    await expect(service.updateMessageFlags(context(), MESSAGE, { seen: true })).rejects.toThrow(PENDING_MOVE_RECONCILIATION_ERROR);
    expect(flagsOf(db)).not.toContain("\\Seen");
  });

  it("fails closed before the acceptance when the account is out of scope", async () => {
    const acceptFlags = vi.fn();
    const service = serviceWith(db, acceptFlags);

    await expect(service.updateMessageFlags(context([]), MESSAGE, { seen: true })).rejects.toMatchObject({ code: "scope_denied" });
    expect(acceptFlags).not.toHaveBeenCalled();
  });
});

describe("Agent moveMessage", () => {
  it("commits a named target through the task layer", async () => {
    const service = serviceWith(db, undefined, realAcceptMove(db));

    await service.moveMessage(context(), MESSAGE, { target: "archive" });

    expect(goalOf(db)).toEqual({ destination: ARCHIVE, state: null });
    const tasks = db.prepare("SELECT id, kind, status, total FROM tasks").all() as Array<{ id: string; kind: string; status: string; total: number }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "move", status: "pending", total: 1 });
    expect(openTaskPayload(MASTER_KEY, taskRow(db, tasks[0]!.id)!)).toEqual({ target: "archive" });
  });

  it("commits an explicit folder as a folder selection, validated in the message's own account", async () => {
    const acceptMove = vi.fn((input: { messageIds: readonly string[]; destination: MoveTaskDestination }) =>
      acceptMoveTask({ db, masterKey: MASTER_KEY, scheduler: { start: () => undefined } }, input));
    const service = serviceWith(db, undefined, acceptMove);

    await service.moveMessage(context(), MESSAGE, { folder: PROJECTS });

    expect(acceptMove).toHaveBeenCalledWith({ messageIds: [MESSAGE], destination: { folderPath: PROJECTS } });
    expect(goalOf(db)).toEqual({ destination: PROJECTS, state: null });
    const task = db.prepare("SELECT id FROM tasks").get() as { id: string };
    expect(openTaskPayload(MASTER_KEY, taskRow(db, task.id)!)).toEqual({ folderPath: PROJECTS });
  });

  it("answers a folder the account does not have with the folder refusal", async () => {
    const service = serviceWith(db, undefined, realAcceptMove(db));

    await expect(service.moveMessage(context(), MESSAGE, { folder: "Missing" })).rejects.toThrow(MOVE_FOLDER_UNAVAILABLE_ERROR);
    expect(goalOf(db)).toEqual({ destination: null, state: null });
  });

  it("refuses instead of moving inline when no scheduler is attached", async () => {
    const service = serviceWith(db);

    await expect(service.moveMessage(context(), MESSAGE, { target: "archive" })).rejects.toMatchObject({
      code: "not_supported",
      message: "This host cannot move messages: no task scheduler is attached.",
    });
    expect(goalOf(db)).toEqual({ destination: null, state: null });
  });

  it("fails closed before the acceptance when the account is out of scope", async () => {
    const acceptMove = vi.fn();
    const service = serviceWith(db, undefined, acceptMove);

    await expect(service.moveMessage(context([]), MESSAGE, { target: "archive" })).rejects.toMatchObject({ code: "scope_denied" });
    expect(acceptMove).not.toHaveBeenCalled();
  });
});
