import { createHmac } from "node:crypto";
import { deriveEncryptionKey } from "./crypto.js";

/**
 * The HMAC purpose for `messages.remote_id_lookup`.
 *
 * Exported because two writers now have to agree on it to the character: the
 * sync pass derives a lookup value from the provider's message id, and the
 * optimistic Sent row derives the same value from the RFC Message-ID it just
 * minted, so that the first sync after a send can *claim* that row instead of
 * inserting a second copy. A drift here fails silently — the row simply waits
 * in Sent for a claim that never comes.
 *
 * Note this is deliberately NOT the outbound ledger's purpose
 * (`outbound-submission-message-id-v1`, `outbox.ts`): the ledger keys its own
 * `rfc_message_id` column and the two derivations are not comparable.
 */
export const MESSAGE_REMOTE_ID_LOOKUP_PURPOSE = "message-remote-id-lookup-v1";

// The HKDF derivation dominates remoteIdLookup's cost and its output depends
// only on (masterKey, purpose), so memoize it per master-key object. The
// cached key shares the master key's own lifetime (both live for the whole
// process), which is why it is not zeroed after each use unlike the
// single-shot keys elsewhere.
const remoteIdLookupKeyCache = new WeakMap<Buffer, Buffer>();

/**
 * The indexable lookup value for one provider message id, or `null` when there
 * is no id to key on.
 *
 * Both the sync pass and the optimistic Sent row go through this one function:
 * the column is only ever compared to itself, so a second implementation of the
 * same derivation would be a second, silently different key.
 */
export function remoteIdLookup(masterKey: Buffer, accountId: string, remoteId: string | undefined): string | null {
  if (!remoteId) return null;
  let key = remoteIdLookupKeyCache.get(masterKey);
  if (!key) {
    key = deriveEncryptionKey(masterKey, MESSAGE_REMOTE_ID_LOOKUP_PURPOSE);
    remoteIdLookupKeyCache.set(masterKey, key);
  }
  return `h1.${createHmac("sha256", key).update(accountId, "utf8").update("\0").update(remoteId, "utf8").digest("base64url")}`;
}
