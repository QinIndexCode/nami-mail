/**
 * Fire-and-forget sync start, shared by the runners that can end an attempt with
 * work a pass still has to reconcile.
 *
 * A runner has three reasons to ask for one: a move whose outcome the transport
 * left ambiguous, a move whose UID generation no longer matches the one it was
 * accepted under, and a flags push refused for the same reason. In every case the
 * runner has already settled its rows and cannot fix the cache itself -- only a
 * sync reads the provider again. The call is deliberately not awaited: the
 * attempt's exit path must not wait for a whole pass, and the pass refuses to run
 * while the account's write slot is held anyway, so awaiting it here would
 * deadlock (`sync.ts`'s account guard, `sync-locks.ts`'s write slots).
 */
import type { DatabaseHandle } from "../db.js";
import type { AgentMailEventSink } from "../agent/mail-state-events.js";
import type { AccountAccessTokenProvider } from "../mail.js";
import type { ServerEventBus } from "../events.js";
import { emitAccountSynced } from "../events.js";
import { serverLog } from "../logging.js";
import { getSyncMessageLimit } from "../settings.js";
import { syncAccount } from "../sync.js";

export type SyncKickDeps = {
  db: DatabaseHandle;
  masterKey: Buffer;
  accessTokenProvider?: AccountAccessTokenProvider;
  agentEvents?: AgentMailEventSink;
  serverEvents?: ServerEventBus;
  syncAbortSignal?: AbortSignal;
};

export function kickAccountSync(deps: SyncKickDeps, accountId: string, reason: string): void {
  void syncAccount(
    deps.db,
    deps.masterKey,
    accountId,
    getSyncMessageLimit(deps.db),
    deps.accessTokenProvider,
    deps.agentEvents,
    deps.syncAbortSignal,
  )
    .then(() => emitAccountSynced(deps.db, deps.serverEvents, accountId))
    .catch((error) => {
      serverLog.warn({ accountId }, reason, error);
    });
}
