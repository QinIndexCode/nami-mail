import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import type { AgentMailEventSink } from "../src/agent/mail-state-events.js";
import { deriveEncryptionKey } from "../src/crypto.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { syncAccount } from "../src/sync.js";
import {
  createRemoteDeletionProbeState,
  defaultRemoteDeletionProbeState,
  remoteDeletionProbeCursorKey,
} from "../src/sync-deletion-probe.js";
import { isAccountSyncing } from "../src/sync-locks.js";

const inbox = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };
const allMail = { path: "[Gmail]/All Mail", name: "All Mail", listed: true, flags: new Set<string>(), specialUse: "\\All" };

/** Inclusive UID range, for asserting which slice a probe pass verified. */
function uidRange(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

describe("remote deletion reconciliation", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    mailbox: { exists: 0, uidValidity: 10n },
    connect: vi.fn(async () => undefined),
    list: vi.fn(async () => [inbox]),
    status: vi.fn(async () => ({ messages: 0, unseen: 0 })),
    getMailboxLock: vi.fn(async () => lock),
    fetch: vi.fn(async function* () {}),
    logout: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    Object.assign(client, {
      usable: true,
      mailbox: { exists: 0, uidValidity: 10n },
      connect: vi.fn(async () => undefined),
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 0, unseen: 0 })),
      getMailboxLock: vi.fn(async () => lock),
      fetch: vi.fn(async function* () {}),
      logout: vi.fn(async () => undefined),
    });
    imapClientForAccount.mockReturnValue(client);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
        'smtp.example.test', 465, 1, 'email', 'connected', ?)
    `).run("account-1", "demo@example.test", now);
  });

  afterEach(() => {
    db.close();
  });

  function addCachedFolder(
    uidValidity: string | null,
    path = "INBOX",
    specialUse: string | null = "\\Inbox",
  ): void {
    db.prepare(`
      INSERT INTO folders (account_id, path, name, special_use, total, unseen, uid_validity)
      VALUES (?, ?, ?, ?, 1, 0, ?)
    `).run("account-1", path, path, specialUse, uidValidity);
  }

  function addCachedMessage(
    id: string,
    uid: number,
    options: {
      mailbox?: string;
      remoteIdLookup?: string;
      pendingMoveDestination?: string | null;
      pendingMoveState?: string | null;
    } = {},
  ): void {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, remote_id_lookup, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at,
        pending_move_destination, pending_move_state
      ) VALUES (?, 'account-1', ?, ?, ?, 'Cached message', 'Demo', 'demo@example.test', '[]',
        ?, '', '', '', '["\\\\Seen"]', 0, 0, ?, ?, ?)
    `).run(
      id,
      options.mailbox ?? "INBOX",
      uid,
      options.remoteIdLookup ?? "h1.cached",
      now,
      now,
      options.pendingMoveDestination ?? null,
      options.pendingMoveState ?? null,
    );
  }

  function remoteLookup(emailId: string): string {
    const key = deriveEncryptionKey(masterKey, "message-remote-id-lookup-v1");
    try {
      return `h1.${createHmac("sha256", key).update("account-1", "utf8").update("\0").update(emailId, "utf8").digest("base64url")}`;
    } finally {
      key.fill(0);
    }
  }

  function eventSink(): AgentMailEventSink & {
    readonly messageDeletedWithinTransaction: ReturnType<typeof vi.fn>;
  } {
    // R14: vitest's generic Mock does not structurally match a specific sink
    // method; the mock objects are correct at runtime, so the assembled sink
    // goes through one documented assertion.
    return {
      acquireLease: vi.fn(() => ({ accountId: "account-1", generation: 1 })),
      messageUpsertedWithinTransaction: vi.fn(),
      messageDeletedWithinTransaction: vi.fn(),
    } as unknown as AgentMailEventSink & { readonly messageDeletedWithinTransaction: ReturnType<typeof vi.fn> };
  }

  it("deletes an absent cached UID and emits its Agent tombstone in the same reconciliation path", async () => {
    addCachedFolder("10");
    addCachedMessage("remote-deleted", 42);
    const events = eventSink();

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events))
      .resolves.toMatchObject({ folders: 1, failedFolders: 0 });

    expect(client.fetch).toHaveBeenCalledWith([42], { uid: true }, { uid: true });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("remote-deleted")).toBeUndefined();
    expect(events.messageDeletedWithinTransaction).toHaveBeenCalledWith(
      { accountId: "account-1", generation: 1 },
      "remote-deleted",
      expect.objectContaining({
        reason: "remote-deletion-reconciled",
        mailbox: "INBOX",
        uid: 42,
        remoteIdLookup: "h1.cached",
      }),
    );
  });

  it("does not reconcile deletion when UIDVALIDITY is not proven unchanged", async () => {
    addCachedFolder(null);
    addCachedMessage("uidvalidity-uncertain", 42);
    Object.assign(client, { mailbox: { exists: 0 } });
    const events = eventSink();

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events))
      .resolves.toMatchObject({ folders: 1, failedFolders: 0 });

    expect(client.fetch).not.toHaveBeenCalled();
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("uidvalidity-uncertain"))
      .toEqual({ id: "uidvalidity-uncertain" });
    expect(events.messageDeletedWithinTransaction).not.toHaveBeenCalled();
  });

  it("removes messages from a folder that disappeared remotely and emits Agent tombstones", async () => {
    addCachedFolder("10", "Projects", null);
    addCachedMessage("removed-folder-message", 42, { mailbox: "Projects" });
    const events = eventSink();

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events))
      .resolves.toMatchObject({ folders: 1, failedFolders: 0 });

    expect(db.prepare("SELECT 1 FROM folders WHERE account_id = ? AND path = ?").get("account-1", "Projects"))
      .toBeUndefined();
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("removed-folder-message")).toBeUndefined();
    expect(events.messageDeletedWithinTransaction).toHaveBeenCalledWith(
      { accountId: "account-1", generation: 1 },
      "removed-folder-message",
      expect.objectContaining({ reason: "folder-removed", mailbox: "Projects", uid: 42 }),
    );
  });

  it("emits a tombstone when a pending All Mail duplicate is discarded", async () => {
    addCachedFolder("10", allMail.path, "\\All");
    const lookup = remoteLookup("mail-1");
    addCachedMessage("pending-move", 1, {
      mailbox: allMail.path,
      remoteIdLookup: lookup,
      pendingMoveDestination: allMail.path,
      pendingMoveState: "confirmed",
    });
    addCachedMessage("discarded-all-mail-copy", 2, {
      mailbox: allMail.path,
      remoteIdLookup: lookup,
    });
    Object.assign(client, {
      mailbox: { exists: 1, uidValidity: 10n },
      list: vi.fn(async () => [allMail]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch: vi.fn(async function* () {
        yield {
          uid: 2,
          emailId: "mail-1",
          flags: new Set<string>(),
          labels: new Set(["\\Inbox"]),
        };
      }),
    });
    const events = eventSink();

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events))
      .resolves.toMatchObject({ folders: 1, failedFolders: 0 });

    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("discarded-all-mail-copy")).toBeUndefined();
    expect(events.messageDeletedWithinTransaction).toHaveBeenCalledWith(
      { accountId: "account-1", generation: 1 },
      "discarded-all-mail-copy",
      expect.objectContaining({ reason: "pending-move-destination-duplicate", mailbox: allMail.path, uid: 2 }),
    );
  });

  it("does not delete cached rows when the bounded verification FETCH fails", async () => {
    addCachedFolder("10");
    addCachedMessage("fetch-failure", 42);
    const failure = new Error("socket closed while probing cached UIDs");
    Object.assign(client, {
      fetch: vi.fn(async function* () {
        throw failure;
      }),
    });
    const events = eventSink();

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events)).rejects.toBe(failure);

    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("fetch-failure"))
      .toEqual({ id: "fetch-failure" });
    expect(events.messageDeletedWithinTransaction).not.toHaveBeenCalled();
  });

  it("completes a probe pass unchanged when the signal is present but never aborted", async () => {
    // The pass reads the signal at every FETCH but must behave exactly as it
    // did before the signal existed: one verification FETCH, the same deletion
    // decision, the same Agent tombstone, and a healthy account at the end.
    addCachedFolder("10");
    addCachedMessage("remote-deleted", 42);
    addCachedMessage("still-present", 43);
    Object.assign(client, {
      fetch: vi.fn(async function* (uids: number[] | string) {
        if (Array.isArray(uids)) yield { uid: 43 };
      }),
    });
    const events = eventSink();
    const controller = new AbortController();
    // An injected probe state: the shared process rotation still carries a
    // cursor from the case above, and this pass must start from the oldest UID.
    const probe = createRemoteDeletionProbeState();

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events, controller.signal, undefined, probe))
      .resolves.toMatchObject({ synced: 0, folders: 1, failedFolders: 0 });

    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch).toHaveBeenCalledWith([42, 43], { uid: true }, { uid: true });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("remote-deleted")).toBeUndefined();
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("still-present")).toEqual({ id: "still-present" });
    expect(events.messageDeletedWithinTransaction).toHaveBeenCalledTimes(1);
    expect(events.messageDeletedWithinTransaction).toHaveBeenCalledWith(
      { accountId: "account-1", generation: 1 },
      "remote-deleted",
      expect.objectContaining({ reason: "remote-deletion-reconciled", uid: 42 }),
    );
    const account = db.prepare("SELECT status, last_error, last_error_code, last_synced_at FROM accounts WHERE id = ?")
      .get("account-1") as { status: string; last_error: string | null; last_error_code: string | null; last_synced_at: string | null };
    expect(account.status).toBe("connected");
    expect(account.last_error).toBeNull();
    expect(account.last_error_code).toBeNull();
    expect(account.last_synced_at).toEqual(expect.any(String));
  });
});

// The probe FETCH is the one IMAP read in a sync pass that had no abort check,
// so a shutdown or a client disconnect had to wait for it to finish. These
// cases pin the check and its consequences together: the pass unwinds, the
// iterator is closed rather than drained, and no decision is taken from a
// partially-consumed probe.
describe("remote deletion probe abort", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    mailbox: { exists: 0, uidValidity: 10n },
    connect: vi.fn(async () => undefined),
    list: vi.fn(async () => [inbox]),
    status: vi.fn(async () => ({ messages: 0, unseen: 0 })),
    getMailboxLock: vi.fn(async () => lock),
    fetch: vi.fn(async function* () {}),
    logout: vi.fn(async () => undefined),
  };
  const probeKey = remoteDeletionProbeCursorKey("account-1", "INBOX", "10");

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    Object.assign(client, {
      usable: true,
      mailbox: { exists: 0, uidValidity: 10n },
      connect: vi.fn(async () => undefined),
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 0, unseen: 0 })),
      getMailboxLock: vi.fn(async () => lock),
      fetch: vi.fn(async function* () {}),
      logout: vi.fn(async () => undefined),
    });
    imapClientForAccount.mockReturnValue(client);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES ('account-1', 'demo@example.test', 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
        'smtp.example.test', 465, 1, 'email', 'connected', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO folders (account_id, path, name, special_use, total, unseen, uid_validity)
      VALUES ('account-1', 'INBOX', 'INBOX', '\\Inbox', 0, 0, '10')
    `).run();
    for (let uid = 1; uid <= 3; uid += 1) {
      db.prepare(`
        INSERT INTO messages (
          id, account_id, mailbox, uid, remote_id_lookup, subject, from_name, from_address, to_json,
          sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
        ) VALUES (?, 'account-1', 'INBOX', ?, 'h1.cached', 'Cached message', 'Demo', 'demo@example.test', '[]',
          ?, '', '', '', '["\\Seen"]', 0, 0, ?)
      `).run(`cached-${uid}`, uid, now, now);
    }
  });

  afterEach(() => {
    db.close();
  });

  it("stops the probe FETCH at the abort instead of draining it, and takes no deletion decision", async () => {
    const controller = new AbortController();
    const served: number[] = [];
    let iteratorClosed = false;
    Object.assign(client, {
      fetch: vi.fn(async function* (uids: number[] | string) {
        if (!Array.isArray(uids)) return;
        try {
          for (const uid of uids) {
            // The abort lands mid-iterator: the first UID is observed normally,
            // the second arrives already cancelled, the third is never produced.
            if (uid === 2) controller.abort();
            served.push(uid);
            yield { uid };
          }
        } finally {
          iteratorClosed = true;
        }
      }),
    });
    const probe = createRemoteDeletionProbeState();

    await expect(
      syncAccount(db, masterKey, "account-1", 20, undefined, undefined, controller.signal, undefined, probe),
    ).rejects.toMatchObject({ name: "SyncAbortedError" });

    // The pass stopped at the abort: the remaining candidate was never produced
    // and the iterator was closed rather than read to completion.
    expect(served).toEqual([1, 2]);
    expect(iteratorClosed).toBe(true);
    // One probe round only — the aborted pass never issued a follow-up FETCH.
    expect(client.fetch).toHaveBeenCalledTimes(1);
    // A partially-consumed probe is not evidence of anything: no row is deleted
    // and the cursor does not move.
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE account_id = 'account-1'").get())
      .toEqual({ count: 3 });
    expect(probe.get(probeKey)).toBeUndefined();
    // An aborted pass is not a provider failure: the account keeps its state.
    expect(db.prepare("SELECT status, last_error, last_error_code, last_synced_at FROM accounts WHERE id = 'account-1'").get())
      .toEqual({ status: "connected", last_error: null, last_error_code: null, last_synced_at: null });
    // The mailbox lock is released and the IMAP client is disconnected.
    expect(lock.release).toHaveBeenCalled();
    expect(client.logout).toHaveBeenCalledTimes(1);
    expect(isAccountSyncing("account-1")).toBe(false);
  });

  it("leaves a pass that finished before the abort untouched", async () => {
    const controller = new AbortController();
    Object.assign(client, {
      fetch: vi.fn(async function* (uids: number[] | string) {
        if (Array.isArray(uids)) yield* uids.map((uid) => ({ uid }));
      }),
    });
    const probe = createRemoteDeletionProbeState();

    await expect(
      syncAccount(db, masterKey, "account-1", 20, undefined, undefined, controller.signal, undefined, probe),
    ).resolves.toMatchObject({ synced: 0, folders: 1, failedFolders: 0 });

    // The signal is never consulted after the pass is done, so an abort that
    // arrives later cannot retroactively change what the pass decided.
    controller.abort();
    expect(probe.get(probeKey)).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE account_id = 'account-1'").get())
      .toEqual({ count: 3 });
  });
});

// These cases own the deletion-probe cursor explicitly. The shared process
// default is only reachable by callers that inject nothing, which is what keeps
// each case independent of the ones above it.
describe("remote deletion probe cursor ownership", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    mailbox: { exists: 0, uidValidity: 10n },
    connect: vi.fn(async () => undefined),
    list: vi.fn(async () => [inbox]),
    status: vi.fn(async () => ({ messages: 0, unseen: 0 })),
    getMailboxLock: vi.fn(async () => lock),
    fetch: vi.fn(async function* () {}),
    logout: vi.fn(async () => undefined),
  };
  const probeKey = remoteDeletionProbeCursorKey("account-1", "INBOX", "10");

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    Object.assign(client, {
      usable: true,
      mailbox: { exists: 0, uidValidity: 10n },
      connect: vi.fn(async () => undefined),
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 0, unseen: 0 })),
      getMailboxLock: vi.fn(async () => lock),
      fetch: vi.fn(async function* () {}),
      logout: vi.fn(async () => undefined),
    });
    imapClientForAccount.mockReturnValue(client);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
        'smtp.example.test', 465, 1, 'email', 'connected', ?)
    `).run("account-1", "demo@example.test", now);
    db.prepare(`
      INSERT INTO folders (account_id, path, name, special_use, total, unseen, uid_validity)
      VALUES ('account-1', 'INBOX', 'INBOX', '\\Inbox', 0, 0, '10')
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  function addCachedMessage(id: string, uid: number): void {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, remote_id_lookup, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, 'account-1', 'INBOX', ?, 'h1.cached', 'Cached message', 'Demo', 'demo@example.test', '[]',
        ?, '', '', '', '["\\Seen"]', 0, 0, ?)
    `).run(id, uid, now, now);
  }

  function addCachedUids(count: number): void {
    for (let uid = 1; uid <= count; uid += 1) addCachedMessage(`cached-${uid}`, uid);
  }

  /** Answers a probe FETCH with every UID it asked for; deletes nothing. */
  function confirmEveryProbe(): ReturnType<typeof vi.fn> {
    return vi.fn(async function* (uids: number[] | string) {
      if (Array.isArray(uids)) yield* uids.map((uid) => ({ uid }));
    });
  }

  /** One full sync pass over the injected probe state. */
  function syncWith(probe: ReturnType<typeof createRemoteDeletionProbeState>): Promise<unknown> {
    return syncAccount(db, masterKey, "account-1", 20, undefined, undefined, undefined, undefined, probe);
  }

  it("advances the injected cursor to the last verified UID and forgets it once nothing is left", async () => {
    addCachedMessage("only-cached", 42);
    const probe = createRemoteDeletionProbeState();

    await syncWith(probe);

    expect(client.fetch).toHaveBeenCalledWith([42], { uid: true }, { uid: true });
    expect(probe.get(probeKey)).toBe(42);

    // The next pass finds nothing above the cursor and nothing from the start,
    // so the cursor is dropped and a later re-cached UID is probed from the top.
    await syncWith(probe);

    expect(probe.get(probeKey)).toBeUndefined();
  });

  it("rotates one folder sweep across passes that share a probe state", async () => {
    addCachedUids(70);
    Object.assign(client, { fetch: confirmEveryProbe() });
    const probe = createRemoteDeletionProbeState();

    await syncWith(probe);
    expect(client.fetch).toHaveBeenLastCalledWith(uidRange(1, 64), { uid: true }, { uid: true });
    expect(probe.get(probeKey)).toBe(64);

    await syncWith(probe);
    expect(client.fetch).toHaveBeenLastCalledWith(uidRange(65, 70), { uid: true }, { uid: true });
    expect(probe.get(probeKey)).toBe(70);

    // Running off the end wraps back to the oldest UID instead of giving up.
    await syncWith(probe);
    expect(client.fetch).toHaveBeenLastCalledWith(uidRange(1, 64), { uid: true }, { uid: true });
    expect(probe.get(probeKey)).toBe(64);
  });

  it("keeps the shared process rotation for callers that inject no probe state", async () => {
    addCachedUids(70);
    Object.assign(client, { fetch: confirmEveryProbe() });
    const shared = defaultRemoteDeletionProbeState();
    shared.delete(probeKey);

    try {
      await syncAccount(db, masterKey, "account-1", 20);
      expect(shared.get(probeKey)).toBe(64);

      await syncAccount(db, masterKey, "account-1", 20);
      expect(client.fetch).toHaveBeenLastCalledWith(uidRange(65, 70), { uid: true }, { uid: true });
      expect(shared.get(probeKey)).toBe(70);
    } finally {
      shared.delete(probeKey);
    }
  });

  it("does not share cursors between callers that own separate probe states", async () => {
    addCachedUids(70);
    Object.assign(client, { fetch: confirmEveryProbe() });
    const first = createRemoteDeletionProbeState();
    const second = createRemoteDeletionProbeState();
    const shared = defaultRemoteDeletionProbeState();
    shared.delete(probeKey);

    await syncWith(first);
    expect(first.get(probeKey)).toBe(64);

    await syncWith(second);

    // A caller that owns its own state starts from the oldest cached UID again
    // instead of inheriting the first caller's sweep position.
    expect(second.get(probeKey)).toBe(64);
    expect(client.fetch).toHaveBeenLastCalledWith(uidRange(1, 64), { uid: true }, { uid: true });
    // ...and the process-wide state is never touched on an injected path.
    expect(shared.get(probeKey)).toBeUndefined();
  });
});

