import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { createIdleWatcher, type IdleWatcher } from "../src/idle.js";

/**
 * Programmable stand-in for an ImapFlow client. `idle()` parks on a deferred
 * promise the test resolves (mailbox change) or rejects (connection died);
 * `logout()` breaks a parked IDLE exactly like imapflow does when closing.
 */
class FakeImapClient extends EventEmitter {
  usable = true;
  connect = vi.fn(async () => undefined);
  mailboxOpen = vi.fn(async () => ({ path: "INBOX" }));
  logout = vi.fn(async () => {
    this.usable = false;
    this.failPendingIdle(new Error("connection closed"));
  });
  private pendingIdle: { resolve: (value: boolean) => void; reject: (reason: Error) => void } | undefined;

  idle = vi.fn(() => {
    this.usable = true;
    return new Promise<boolean>((resolve, reject) => {
      this.pendingIdle = { resolve, reject };
    });
  });

  releasePendingIdle(value = true): void {
    const pending = this.pendingIdle;
    this.pendingIdle = undefined;
    pending?.resolve(value);
  }

  failPendingIdle(error: Error): void {
    const pending = this.pendingIdle;
    this.pendingIdle = undefined;
    pending?.reject(error);
  }
}

function insertAccount(db: DatabaseHandle, id: string, email: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", now);
}

describe("IMAP IDLE watcher", () => {
  let db: DatabaseHandle;
  let watcher: IdleWatcher | undefined;
  let clients: FakeImapClient[];
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    clients = [];
    onChange = vi.fn();
    vi.clearAllMocks();
    imapClientForAccount.mockImplementation(async () => {
      const client = new FakeImapClient();
      clients.push(client);
      return client;
    });
    watcher = createIdleWatcher({ db, masterKey: Buffer.alloc(32, 7), onChange });
    insertAccount(db, "account-1", "demo@example.com");
  });

  afterEach(async () => {
    await watcher?.close();
    db.close();
  });

  it("parks on INBOX idle with long-lived socket options", async () => {
    await watcher!.ensureAccounts();
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    await vi.waitFor(() => expect(clients[0].connect).toHaveBeenCalledTimes(1));
    expect(clients[0].mailboxOpen).toHaveBeenCalledWith("INBOX");
    await vi.waitFor(() => expect(clients[0].idle).toHaveBeenCalledTimes(1));
    expect(imapClientForAccount.mock.calls[0]![3]).toEqual({
      socketTimeout: 30 * 60 * 1000,
      maxIdleTime: 28 * 60 * 1000,
    });
  });

  it("reacts to mailbox events while parked (official event-driven semantics)", async () => {
    await watcher!.ensureAccounts();
    const client = clients[0];
    await vi.waitFor(() => expect(client.idle).toHaveBeenCalledTimes(1));
    expect(onChange).not.toHaveBeenCalled();

    // Untagged updates fire events on the client while `idle()` stays parked
    // (imapflow does not resolve idle() on updates). The watcher must hand the
    // account to onChange directly — realtime push must not wait for the
    // parked promise to settle.
    client.emit("exists");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(client.idle).toHaveBeenCalledTimes(1); // still parked underneath

    client.emit("expunge");
    expect(onChange).toHaveBeenCalledTimes(2);
    client.emit("flags");
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(client.idle).toHaveBeenCalledTimes(1);
  });

  it("re-parks when idle() settles while the connection is still usable, without hot-looping", async () => {
    await watcher!.ensureAccounts();
    const client = clients[0];
    await vi.waitFor(() => expect(client.idle).toHaveBeenCalledTimes(1));

    // Settle without a mailbox change (e.g. imapflow's own socket-timeout
    // recovery broke and re-entered IDLE), leaving the connection usable.
    client.releasePendingIdle(true);
    await vi.waitFor(() => expect(client.idle).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    expect(onChange).not.toHaveBeenCalled();

    // The loop backs off 500ms per re-park cycle instead of spinning the
    // microtask queue; a hot loop would rack up thousands of calls here.
    const calls = client.idle.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client.idle.mock.calls.length).toBe(calls);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reconnects with backoff after a dropped connection", async () => {
    await watcher!.ensureAccounts();
    await vi.waitFor(() => expect(clients[0].idle).toHaveBeenCalledTimes(1));
    expect(onChange).not.toHaveBeenCalled();

    clients[0].usable = false;
    clients[0].failPendingIdle(new Error("socket closed"));
    await vi.waitFor(() => expect(clients).toHaveLength(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(clients[1].connect).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    await vi.waitFor(() => expect(clients[1].idle).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("close() breaks a parked IDLE and lets the loop unwind without reconnecting", async () => {
    await watcher!.ensureAccounts();
    const client = clients[0];
    await vi.waitFor(() => expect(client.idle).toHaveBeenCalledTimes(1));

    await watcher!.close();
    expect(client.logout).toHaveBeenCalledTimes(1);
    const parkedCalls = client.idle.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client.idle.mock.calls.length).toBe(parkedCalls);
    expect(imapClientForAccount).toHaveBeenCalledTimes(1);
  });

  it("ensureAccounts takes over new accounts and stops removed ones", async () => {
    insertAccount(db, "account-2", "other@example.com");
    await watcher!.ensureAccounts();
    await vi.waitFor(() => expect(clients).toHaveLength(2));

    // Calling again must not double-start existing watchers.
    await watcher!.ensureAccounts();
    expect(imapClientForAccount).toHaveBeenCalledTimes(2);

    db.prepare("DELETE FROM accounts WHERE id = ?").run("account-2");
    await watcher!.ensureAccounts();
    await vi.waitFor(() => expect(clients[1].logout).toHaveBeenCalledTimes(1));

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(imapClientForAccount).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(clients[0].idle).toHaveBeenCalledTimes(1));
  });
});