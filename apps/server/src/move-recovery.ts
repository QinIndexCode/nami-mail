/**
 * Proving what a stale move intent means before retrying it.
 *
 * A 'intent' row is durable before the provider command, so an exit between the
 * command and its response leaves the row behind. Whether it may be retried
 * depends on a fact only the provider can answer -- whether the source UID is
 * still live -- and that probe is the whole subject of this module.
 */
import { accountById } from "./account-store.js";
import type { DatabaseHandle } from "./db.js";
import { safeLogout } from "./imap-logout.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { moveStatements } from "./sync-move-statements.js";

/**
 * Only an 'intent' left behind by an interrupted transfer can be re-probed
 * against the source mailbox and retried. A 'confirmed' move and an
 * unverified location stay blocked until a sync reconciles the target.
 */
export function isRecoverableStaleMove(message: { pending_move_state: string | null; uid: number }): boolean {
  return message.pending_move_state === "intent" && message.uid > 0;
}

/**
 * Proves whether the source UID of a stale 'intent' is still live. Present:
 * the interrupted MOVE never executed, so the intent is discarded for a fresh
 * attempt (true). Absent: the MOVE did happen and reconciliation owns the
 * outcome (false).
 */
export async function recoverStaleMoveIntent(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  message: { account_id: string; mailbox: string; uid: number },
  accessTokenProvider?: AccountAccessTokenProvider,
  sharedClient?: Awaited<ReturnType<typeof imapClientForAccount>>,
): Promise<boolean> {
  const account = accountById(db, message.account_id);
  if (!account) return false;
  const client = sharedClient ?? (await imapClientForAccount(account, masterKey, accessTokenProvider));
  const ownsClient = !sharedClient;
  try {
    if (ownsClient) await client.connect();
    const lock = await client.getMailboxLock(message.mailbox);
    try {
      for await (const item of client.fetch([message.uid], { uid: true }, { uid: true })) {
        if (item.uid === message.uid) {
          moveStatements(db).clearMoveIntent.run(messageId);
          return true;
        }
      }
    } finally {
      lock.release();
    }
    return false;
  } finally {
    if (ownsClient) await safeLogout(client);
  }
}
