/**
 * Shared IMAP connection teardown.
 *
 * Deliberately a leaf module (no imports at all) so every caller — mail,
 * sync, drafts, attachments, idle, backup — can reach for it without pulling
 * in, or creating a cycle through, the connection factory in `mail.ts`.
 */

/**
 * The structural slice of an IMAP client this module needs. Declared
 * structurally rather than as `ImapFlow` so callers keep their own client
 * types and tests can pass a stub.
 */
export type LogoutCapableClient = {
  /** False once the connection is gone; logout would then throw for no gain. */
  usable: boolean;
  logout(): Promise<unknown>;
};

/**
 * Closes an IMAP connection without letting teardown failures surface.
 *
 * A logout runs on the failure path of whatever operation opened the
 * connection, so its rejection must never replace the error the caller is
 * already reporting. Callers that must not block on the round trip write
 * `void safeLogout(client)`; callers that need the connection fully closed
 * before continuing (releasing a lock, reusing a cached client) await it.
 */
export async function safeLogout(client: LogoutCapableClient | null | undefined): Promise<void> {
  if (!client?.usable) return;
  await client.logout().catch(() => undefined);
}
