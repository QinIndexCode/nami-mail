import { randomUUID } from "node:crypto";
import { attachmentKindsJson } from "./attachment-kind.js";
import type { DatabaseHandle } from "./db.js";
import { redactUrls } from "./message-links.js";
import { remoteIdLookup } from "./message-remote-id.js";
import { indexMessageFts } from "./message-search.js";
import {
  protectedMessageColumns,
  type MessagePayload,
  type StoredAttachmentMetadata,
} from "./message-storage.js";
import type { OutboundAttachment } from "./outbound-attachments.js";
import type { OutboundSubmissionRequest } from "./outbox.js";
import type { AccountRecord } from "./types.js";

/**
 * The optimistic Sent row: the local half of a send the provider has not stored
 * yet, and the three operations that own its whole life.
 *
 * A send accepted at time T is visible in Sent at time T, because the user was
 * told it was sent -- the provider's copy arrives one sync later, and a Sent
 * folder that stays empty for those seconds reads as a failed send. So the
 * acceptance writes a row locally, and the first sync pass that sees the
 * provider's copy **claims** that row instead of inserting a second one.
 *
 * The row is deliberately invisible to the Agent: nothing here emits a
 * `message-upserted` event, so the RAG layer never indexes a mail that has not
 * left the machine. It does not need to -- the claim keeps the row's `id`, and
 * the sync upsert that fills it emits the event the Agent indexes, with the
 * provider's own bytes (agent-rag-worker.ts's `upsertMessage` re-reads the row
 * by id). One event per sent mail, and never for an unconfirmed one.
 *
 * Four invariants hold this together, and each one is why a piece below looks
 * the way it does:
 *
 *   1. **The row's lifetime is the task's.** `pending_send` holds the submission
 *      id from acceptance until the send settles; the settle hook is the only
 *      remover (`tasks/wiring.ts`), and a `completed` send keeps its row, which
 *      is exactly the row the claim lands on.
 *   2. **The id never changes.** `id` is the AAD of the sealed payload
 *      (`message-storage.ts`'s `payloadAad`), so a row rewritten under a
 *      different id can no longer be decrypted. The claim re-keys `uid` and
 *      nothing else.
 *   3. **The uid is negative.** Real provider uids are positive, so a
 *      placeholder can never collide with a synced row, never becomes a
 *      remote-deletion candidate (`sync.ts` requires `uid > 0`), and is
 *      recognisable as "not from the provider" by anyone reading the table.
 *   4. **The row proves nothing.** It is our own writing, so no reader may take
 *      it as evidence that the provider stored the mail: `confirmSubmissionsInSent`
 *      would otherwise let a send confirm itself, and for `unknown_delivery` --
 *      whose whole point is to send the user to Sent to check -- the answer
 *      would be a row we wrote. The claim clearing `pending_send` is the moment
 *      the row becomes a provider copy, so every reader that treats "a Sent row"
 *      as evidence filters on that marker.
 */

/**
 * The Sent mailbox's special-use flag, bound as a parameter rather than written
 * into the SQL text: `'\Sent'` inside a TS string literal loses its backslash
 * (it is a JS escape, not a SQL one), which would silently search for a mailbox
 * named `Sent`.
 */
const SENT_SPECIAL_USE = "\\Sent";

/** The snippet bound `sync.ts` and `drafts.ts` both apply. */
const SNIPPET_MAX_LENGTH = 150;

export type PendingSentInput = {
  account: AccountRecord;
  /** The ledger row this placeholder stands for; stored in `pending_send`. */
  submissionId: string;
  /**
   * The RFC Message-ID minted for this send, brackets included
   * (`generatedMessageId`, `outbox.ts`).
   *
   * It keys the row twice: it is the payload's `messageId` -- which is how
   * `confirmSubmissionsInSent` recognises the Sent copy -- and it is what the
   * claim's probe is derived from. Both use this exact string, and the sync side
   * derives its probe from the same spelling (`messageIdValues` keeps the
   * brackets), so neither side may re-normalise it.
   */
  rfcMessageId: string;
  request: OutboundSubmissionRequest;
  attachments: readonly OutboundAttachment[];
};

/** The account's Sent mailbox path, or undefined when the server has none. */
function sentMailbox(db: DatabaseHandle, accountId: string): string | undefined {
  return (db.prepare(`
    SELECT path FROM folders
    WHERE account_id = ? AND special_use = ?
    ORDER BY path
    LIMIT 1
  `).get(accountId, SENT_SPECIAL_USE) as { path: string } | undefined)?.path;
}

/**
 * Writes the optimistic Sent row for one accepted send, and returns its id.
 *
 * Returns `null` when the account has no Sent mailbox: a server without one
 * cannot be given a row that claims a folder exists, and refusing the send over
 * it would be the local cache's problem becoming the user's. The send goes out;
 * the Sent view fills in when the provider's copy syncs.
 *
 * Must be called inside the acceptance's transaction: the placeholder uid is
 * read (`MIN(uid) - 1`) and then inserted, so two acceptances that interleaved
 * there would both take the same negative uid and the second insert would break
 * the UNIQUE(account_id, mailbox, uid) constraint.
 *
 * Nothing is read from disk and nothing is decrypted: the attachment metadata
 * comes from the ledger's tokens, and the body comes from the request the
 * caller already holds.
 */
export function writePendingSentRow(
  db: DatabaseHandle,
  masterKey: Buffer,
  input: PendingSentInput,
): string | null {
  const mailbox = sentMailbox(db, input.account.id);
  if (!mailbox) return null;
  const uid = db.prepare(`
    SELECT COALESCE(MIN(uid), 0) - 1 FROM messages
    WHERE account_id = ? AND mailbox = ? AND uid < 0
  `).pluck().get(input.account.id, mailbox) as number;
  const id = randomUUID();
  const now = new Date().toISOString();
  // No MIME part ids exist yet: the parts are assigned by the MIME builder at
  // send time. The attachment token is the one stable identity this row's
  // attachments have, and the sync that claims the row replaces this whole
  // metadata set with the provider's own.
  const attachments: StoredAttachmentMetadata[] = input.attachments.map((attachment) => ({
    partId: attachment.token,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    related: false,
    disposition: "attachment",
  }));
  const payload: MessagePayload = {
    messageId: input.rfcMessageId,
    subject: input.request.subject,
    fromName: input.account.display_name ?? "",
    fromAddress: input.account.email,
    to: input.request.to.map((address) => ({ name: "", address })),
    cc: input.request.cc?.map((address) => ({ name: "", address })) ?? [],
    inReplyTo: input.request.inReplyTo ?? null,
    references: input.request.references ? [...input.request.references] : [],
    // The same redaction the synced path applies: a raw URL must not reach a
    // stored snippet, and this one is rendered before any sync has run.
    snippet: redactUrls(input.request.text.replace(/\s+/g, " ").trim()).slice(0, SNIPPET_MAX_LENGTH),
    textBody: input.request.text,
    htmlBody: input.request.html ?? "",
    attachments: attachments.length ? attachments : null,
  };
  const insert = db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, remote_id_lookup, message_id,
      subject, from_name, from_address, to_json, cc_json, in_reply_to, references_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments,
      attachments_json, attachment_kinds_json, payload_metadata_ready,
      encrypted_payload, payload_version, created_at, pending_send
    ) VALUES (
      @id, @accountId, @mailbox, @uid, @remoteIdLookup, @messageId,
      @subject, @fromName, @fromAddress, @toJson, @ccJson, @inReplyTo, @referencesJson,
      @sentAt, @snippet, @textBody, @htmlBody, @flagsJson, @hasAttachments,
      @attachmentsJson, @attachmentKindsJson, @payloadMetadataReady,
      @encryptedPayload, @payloadVersion, @createdAt, @pendingSend
    )
  `);
  insert.run({
    id,
    accountId: input.account.id,
    mailbox,
    uid,
    // The probe's key, from the same RFC Message-ID the sync side will derive
    // its own probe from. `size` is left at the column default: the RFC822 byte
    // count is the provider's answer, and this payload is replaced by the
    // provider's copy on the next sync.
    remoteIdLookup: remoteIdLookup(masterKey, input.account.id, input.rfcMessageId),
    ...protectedMessageColumns(masterKey, id, input.account.id, payload),
    sentAt: now,
    // What a provider stores for an accepted send. The synced copy replaces
    // this with the server's own flag set (Gmail may add labels).
    flagsJson: JSON.stringify(["\\Seen"]),
    hasAttachments: attachments.length ? 1 : 0,
    // The one plaintext projection of the attachment metadata, and the one the
    // Attachments view and its sidebar count read: the payload's copy is sealed.
    attachmentKindsJson: attachmentKindsJson(attachments),
    payloadMetadataReady: 1,
    createdAt: now,
    pendingSend: input.submissionId,
  });
  indexMessageFts(db, id, {
    subject: payload.subject,
    fromName: payload.fromName,
    fromAddress: payload.fromAddress,
    to: payload.to,
    cc: payload.cc ?? [],
    textBody: payload.textBody,
    attachments,
  });
  return id;
}

/**
 * Removes the placeholder a submission stands for, and reports how many rows
 * that was (0 or 1).
 *
 * The predicate is the submission id, not the message id: every caller knows
 * which send ended, none of them knows which row was written for it, and the
 * marker column is the only thing tying the two together. It is also the
 * predicate a *claim* uses when it finds the target uid already taken -- one
 * deletion rule, two reasons to run it.
 */
export function retractPendingSentRow(db: DatabaseHandle, submissionId: string): number {
  return db.prepare("DELETE FROM messages WHERE pending_send = ?").run(submissionId).changes;
}

export type SentClaimInput = {
  accountId: string;
  mailbox: string;
  /** The remote message's RFC Message-ID, as `sync.ts` normalises it. */
  messageId: string | null;
  /** The uid the remote message will be written under. */
  uid: number;
};

/**
 * Claims the local Sent placeholder for a message the provider has now stored,
 * and returns the row id it must be written under; `null` means "nothing was
 * claimed, use your own derivation".
 *
 * The probe is the RFC Message-ID, not `message.emailId`. That distinction is
 * the whole design and was the contract's first hard correction: `remoteIdLookup`
 * is fed `emailId` everywhere in `sync.ts`, and `emailId` is `undefined` on
 * every server without OBJECTID or X-GM-EXT-1 (imapflow's own types say it is
 * "always included **if** the server supports" them) -- so on a Dovecot or
 * self-hosted mailbox *every* `remote_id_lookup` is NULL and a probe keyed on
 * that column would never match anything. The ENVELOPE Message-ID exists on
 * every server and needs no decryption, so the probe is derived from it.
 *
 * The three outcomes, all of them decided here:
 *
 *   - **no row matches** -> `null`, and the caller keeps the id it derived.
 *   - **a row matches and the target uid is free** -> the row is re-keyed to
 *     that uid and its marker cleared, and its id is returned so the caller
 *     writes the provider's copy *into it*. The marker goes in the same
 *     statement because the row stops being a placeholder at that moment: it is
 *     now the provider's own copy, so the settle hook's retraction must no
 *     longer match it and sync's delete exemptions must no longer shield it.
 *     Its `remote_id_lookup` is upgraded by the caller's standard upsert
 *     afterwards, which is how a server with OBJECTID swaps the RFC-derived
 *     value for the provider's own.
 *   - **a row matches but the target uid is taken** -> the placeholder is
 *     retired (the authoritative row is already there) and `null` is returned.
 *
 * Not an `ON CONFLICT`: the unique key is `(account_id, mailbox, uid)` and a
 * negative placeholder uid never meets a real one, so the re-key has to be an
 * explicit statement *before* the upsert rather than a conflict branch inside it.
 *
 * The re-key and the upsert that fills the row are two statements, not one
 * transaction -- the row id is the payload's AAD, so it has to be settled
 * before the payload is sealed, which is before the upsert. A crash between
 * them therefore leaves the placeholder under the real uid, and that window is
 * left recoverable on purpose: the re-key also clears `payload_metadata_ready`,
 * so the next pass re-fetches this uid and rewrites the row with the provider's
 * own bytes (sealed under the unchanged id). What the row holds in the meantime
 * is the locally composed mail -- readable and searchable, but its attachment
 * part ids are still attachment tokens, which is why it must not be left that
 * way. There is no state the pair can reach that a later pass cannot finish.
 *
 * The three outcomes above *are* one transaction: the probe, the occupied-slot
 * check and the re-key decide together, or two sync passes could claim the same
 * row and one of them would write a uid the other already took.
 *
 * Callers gate this on the Sent mailbox: it is the only folder a placeholder can
 * be in, and the inbox hot path should not pay for a probe that cannot match.
 */
export function claimPendingSentRow(
  db: DatabaseHandle,
  masterKey: Buffer,
  input: SentClaimInput,
): string | null {
  const probe = remoteIdLookup(masterKey, input.accountId, input.messageId ?? undefined);
  if (!probe) return null;
  return db.transaction(() => {
    const placeholder = db.prepare(`
      SELECT id, pending_send FROM messages
      WHERE account_id = ? AND mailbox = ? AND remote_id_lookup = ? AND pending_send IS NOT NULL
      ORDER BY uid ASC, rowid ASC
      LIMIT 1
    `).get(input.accountId, input.mailbox, probe) as { id: string; pending_send: string } | undefined;
    if (!placeholder) return null;
    const occupied = db.prepare(`
      SELECT 1 FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?
    `).get(input.accountId, input.mailbox, input.uid);
    if (occupied) {
      retractPendingSentRow(db, placeholder.pending_send);
      return null;
    }
    db.prepare(`
      UPDATE messages SET uid = ?, pending_send = NULL, payload_metadata_ready = 0
      WHERE id = ? AND account_id = ? AND mailbox = ? AND pending_send IS NOT NULL
    `).run(input.uid, placeholder.id, input.accountId, input.mailbox);
    return placeholder.id;
  })();
}
