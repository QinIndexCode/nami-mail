import type { DatabaseHandle } from "./db.js";

/**
 * The mailbox generation (IMAP `UIDVALIDITY`), and the one comparison that makes
 * a cached UID trustworthy.
 *
 * A local message row stores `(mailbox, uid)`. That pair only identifies the
 * message inside one generation: when a provider rebuilds a mailbox, UIDs start
 * over and the same number can belong to a different message. Sync has always
 * handled this for its own writes (`sync.ts` resets the folder's rows when the
 * generation changes), but the paths a user drives -- a flag push, a move, an
 * attachment download -- resolved `(mailbox, uid)` from the cache and wrote to
 * the provider without checking that the cache still described the same
 * generation.
 *
 * The generation is captured when the work is accepted (`folders.uid_validity`,
 * written by the last sync of that folder) and compared against the live value
 * carried by the opened mailbox, under the same lock that guards the command.
 * That ordering is what makes the check meaningful: two "current" values
 * compared at execution time can already agree on the new generation while the
 * queued task still holds an old UID.
 */

/** The wire value of `UIDVALIDITY` as text, or `undefined` when absent/invalid. */
export function uidValidityValue(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  // ImapFlow exposes a bigint in production. Accepting an integer here keeps
  // the cache boundary easy to exercise with small test doubles.
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

/** The generation the cache recorded for `(account, mailbox)`, if it ever did. */
export function cachedUidValidity(db: DatabaseHandle, accountId: string, mailbox: string): string | null {
  const row = db
    .prepare("SELECT uid_validity FROM folders WHERE account_id = ? AND path = ?")
    .get(accountId, mailbox) as { uid_validity: string | null } | undefined;
  return row?.uid_validity ?? null;
}

/**
 * Whether `(mailbox, uid)` still means what the cache says it means.
 *
 * Both sides must be present: an unknown generation is not evidence of the same
 * one. A folder the cache never recorded (a first sync of a folder, or a row
 * written before this check existed) therefore fails closed -- the write is
 * refused and a sync fills the value in, which costs one refused attempt and
 * never risks touching another message.
 */
export function sameUidGeneration(expected: string | null | undefined, live: string | undefined): boolean {
  return Boolean(expected) && Boolean(live) && expected === live;
}

/**
 * The generation of the mailbox a client currently has selected, or `undefined`
 * when it reports none.
 *
 * Every SELECT response carries UIDVALIDITY (RFC 3501) and ImapFlow exposes it
 * as a bigint, so production always answers. `undefined` therefore means "this
 * transport does not answer the question" -- an in-process double, or a server
 * that omitted the field -- rather than "a different generation".
 */
export function liveUidValidity(client: { mailbox?: { uidValidity?: unknown } | false | null }): string | undefined {
  const mailbox = client.mailbox;
  if (!mailbox) return undefined;
  return uidValidityValue(mailbox.uidValidity);
}

/**
 * The policy every user-driven command applies once it holds the mailbox lock.
 *
 * A live value that disagrees with the expected one refuses the command, and so
 * does a live value next to a missing expectation (nothing proves which epoch the
 * UID belongs to). A transport that exposes no generation at all cannot prove a
 * rebuild either way, and refusing there would make every command on such a
 * transport fail forever, so it is allowed through -- the same reading `sync.ts`
 * has always used for an absent `UIDVALIDITY`.
 */
export function uidGenerationAllowsWrite(expected: string | null | undefined, live: string | undefined): boolean {
  if (!live) return true;
  return sameUidGeneration(expected, live);
}

/** The fields of a selection entry the removal below needs. */
export type GenerationGuardedEntry = {
  id: string;
  /** The row's cached generation, used when no acceptance-time value is known. */
  origin_uid_validity?: string | null;
};

/**
 * Removes, in place, every entry whose UID generation cannot be proven, and
 * returns them.
 *
 * The acceptance-time generation wins (it is the only value a rebuild cannot have
 * re-written in the meantime); an entry without one falls back to the generation
 * its row carries, which is what an immediate command has. Callers are expected to
 * settle the returned entries as refused and to ask for the sync that gives them a
 * current position.
 */
export function partitionRefusedByGeneration<E extends GenerationGuardedEntry>(
  entries: E[],
  live: string | undefined,
  acceptedGenerations?: ReadonlyMap<string, string>,
): E[] {
  const refused = entries.filter((entry) =>
    !uidGenerationAllowsWrite(acceptedGenerations?.get(entry.id) ?? entry.origin_uid_validity, live));
  if (refused.length === 0) return refused;
  const allowed = entries.filter((entry) => !refused.includes(entry));
  entries.length = 0;
  entries.push(...allowed);
  return refused;
}

/**
 * Throws unless the opened mailbox still carries the generation the caller
 * expected. The throw is the whole effect: callers that claimed an intent clear
 * it first, because nothing has been sent.
 */
export function refuseRebuiltMailbox(
  db: DatabaseHandle,
  accountId: string,
  mailbox: string,
  client: { mailbox?: { uidValidity?: unknown } | false | null },
  expected?: string | null,
): void {
  if (uidGenerationAllowsWrite(expected ?? cachedUidValidity(db, accountId, mailbox), liveUidValidity(client))) return;
  throw new Error(UID_GENERATION_CHANGED_ERROR);
}

/** Refusal text for a command whose mailbox was rebuilt since it was accepted.
 *
 * Retryable from the user's point of view, not from the scheduler's: the task
 * that carried this write gives the selection back and a sync re-learns the
 * folder, so acting again is the fix rather than the same failure repeating.
 * The write paths kick that sync themselves; a download cannot, so the wording
 * asks for it without claiming one has started. */
export const UID_GENERATION_CHANGED_ERROR =
  "邮箱已被服务器重建，邮件位置可能已变化，请同步该邮箱后重试。";
