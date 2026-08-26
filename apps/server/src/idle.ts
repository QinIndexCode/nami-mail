import type { ImapFlow } from "imapflow";
import type { DatabaseHandle } from "./db.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import type { AccountRecord } from "./types.js";

/**
 * Live IMAP watcher. Keeps one long-lived connection per account parked in
 * IDLE on the INBOX; when the server reports a change (new mail, expunge,
 * flag update) it hands the account to the caller's sync callback immediately
 * instead of waiting for the next poll.
 *
 * imapflow semantics (verified against the upstream source): `idle()` blocks
 * for the whole IDLE session and does NOT resolve when the server pushes an
 * untagged update — those only surface as `exists` / `expunge` / `flags`
 * events on the client instance. `maxIdleTime` is handled internally
 * (imapflow sends DONE and re-enters IDLE itself), as are socket-timeout
 * recoveries (NOOP + re-IDLE), so a pending `idle()` stays parked until the
 * connection dies or `stop()` breaks it via logout. This watcher therefore
 * reacts to events directly and only uses `idle()` to keep the connection
 * parked. Only the INBOX is watched — IMAP can IDLE one mailbox at a time —
 * so other folders keep being covered by the regular poll; the INBOX is
 * where verification codes and other time-sensitive mail land.
 */

/** 30 minutes, long enough to cover the 28-minute idle re-entry window. */
const IDLE_SOCKET_TIMEOUT = 30 * 60 * 1000;
/** Re-enter IDLE before providers (Gmail ~29 min) drop the session. */
const MAX_IDLE_MILLIS = 28 * 60 * 1000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export type IdleWatcherOptions = {
  db: DatabaseHandle;
  masterKey: Buffer;
  accessTokenProvider?: AccountAccessTokenProvider;
  /**
   * Called when the INBOX reported a change. The host runs its sync pipeline
   * (which is re-entrancy guarded), so a flood of IMAP notifications simply
   * collapses into "already synchronizing".
   */
  onChange: (accountId: string) => void;
  log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
};

export type IdleWatcher = {
  /** Starts watchers for newly-seen accounts and stops ones that were removed. Safe to call repeatedly. */
  ensureAccounts(): Promise<void>;
  stopAccount(accountId: string): Promise<void>;
  /** Stops every watcher and waits for their loops to unwind. */
  close(): Promise<void>;
};

function nextDelay(attempt: number): number {
  return Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
}

function sleep(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

export function createIdleWatcher(options: IdleWatcherOptions): IdleWatcher {
  const { db, masterKey } = options;
  const active = new Map<string, { stop(): void; finished: Promise<void> }>();

  /** Fires-and-forgets one account's watch loop; the loop owns reconnect/backoff. */
  const startAccount = (account: AccountRecord): void => {
    if (active.has(account.id)) return;
    let closed = false;
    let currentClient: ImapFlow | undefined;
    const finished = (async () => {
      let attempt = 0;
      while (!closed) {
        let client: ImapFlow | undefined;
        try {
          // Reconnect picks up a fresh OAuth access token on every attempt.
          client = await imapClientForAccount(account, masterKey, options.accessTokenProvider, {
            socketTimeout: IDLE_SOCKET_TIMEOUT,
            maxIdleTime: MAX_IDLE_MILLIS,
          });
          currentClient = client;
          await client.connect();
          attempt = 0;
          await client.mailboxOpen("INBOX");
          // Returns only when the connection died or the watcher was
          // stopped; fall through to reconnect (or exit) below.
          await watchInbox(client, account.id, () => closed);
        } catch (error) {
          options.log?.warn?.(`IDLE watcher for ${account.email} failed`, { error });
        } finally {
          if (currentClient === client) currentClient = undefined;
          if (client?.usable) {
            await client.logout().catch(() => undefined);
          }
        }
        if (!closed) {
          const delay = nextDelay(attempt);
          attempt += 1;
          await sleep(delay);
        }
      }
    })();
    void finished.catch((error) => options.log?.warn?.("IDLE watcher loop crashed", { error }));
    active.set(account.id, {
      stop: () => {
        closed = true;
        // Breaking the pending IDLE wait is what lets the loop unwind; a
        // logout is safe from any state and is the only public handle into
        // imapflow's blocked idle call.
        const client = currentClient;
        if (client) void client.logout().catch(() => undefined);
      },
      finished,
    });
  };

  /**
   * Official imapflow usage (upstream source / README): attach mailbox
   * listeners, then park the connection with `idle()`. Untagged updates do
   * not resolve `idle()` — they only fire `exists`/`expunge`/`flags` events
   * on the client — so each event hands the account to onChange right away.
   * `maxIdleTime` re-entry and socket-timeout recovery happen inside
   * imapflow; `idle()` settles only when the connection dies or `stop()`
   * breaks the park via logout, which unwinds into the reconnect path.
   */
  const watchInbox = async (client: ImapFlow, accountId: string, isStopped: () => boolean): Promise<void> => {
    const fire = () => {
      if (!isStopped() && client.usable) options.onChange(accountId);
    };
    client.on("exists", fire);
    client.on("expunge", fire);
    client.on("flags", fire);
    try {
      while (!isStopped() && client.usable) {
        try {
          await client.idle();
        } catch {
          // Connection-level failure; reconnect from the outer loop.
          return;
        }
        if (isStopped() || !client.usable) return;
        // Settled while the connection still stands (e.g. imapflow broke
        // IDLE for its own socket-timeout recovery). Give that session a
        // beat before re-parking — `idle()` resolves right away when another
        // session already holds the IDLE flag, and re-calling it in a tight
        // loop would starve the event loop.
        await sleep(500);
      }
    } finally {
      client.off("exists", fire);
      client.off("expunge", fire);
      client.off("flags", fire);
    }
  };

  return {
    ensureAccounts: async () => {
      const accounts = db.prepare("SELECT * FROM accounts ORDER BY created_at").all() as AccountRecord[];
      const seen = new Set<string>();
      for (const account of accounts) {
        seen.add(account.id);
        startAccount(account);
      }
      for (const accountId of [...active.keys()]) {
        if (!seen.has(accountId)) {
          const watcher = active.get(accountId)!;
          watcher.stop();
          active.delete(accountId);
          await watcher.finished.catch(() => undefined);
        }
      }
    },
    stopAccount: async (accountId: string) => {
      const watcher = active.get(accountId);
      if (!watcher) return;
      watcher.stop();
      active.delete(accountId);
      await watcher.finished.catch(() => undefined);
    },
    close: async () => {
      const watchers = [...active.values()];
      for (const watcher of watchers) watcher.stop();
      active.clear();
      await Promise.allSettled(watchers.map((watcher) => watcher.finished));
    },
  };
}