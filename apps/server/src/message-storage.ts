import type { DatabaseHandle } from "./db.js";
import { isVisibleAttachment } from "@nami/agent-contracts";
import { decryptTextEnvelope, deriveEncryptionKey, encryptTextEnvelope } from "./crypto.js";
import { attachmentKindsJson } from "./attachment-kind.js";

export const MESSAGE_PAYLOAD_VERSION = 1;
export const MAX_ENCRYPTED_SEARCH_CANDIDATES = 5_000;
export const PENDING_MOVE_RECONCILIATION_ERROR = "邮件正在同步移动后的新位置，请稍后重试。";
export const MOVE_LOCATION_UNVERIFIED_ERROR = "邮件已移动，但邮箱服务器未提供可验证的新位置。请刷新目标文件夹后再修改邮件或下载附件。";
/**
 * The account is busy (a mailbox sync pass or another move is in flight) and the
 * wait budget ran out. Deliberately distinct from the two messages above:
 * nothing is wrong with this message, the operation only has to wait its turn,
 * and a retry is expected to succeed.
 */
export const MAILBOX_SYNCING_ERROR = "邮箱正在同步，请稍后重试。";
/**
 * A previous move on the same account is still dispatching. Kept separate from
 * MAILBOX_SYNCING_ERROR so a report of "the delete failed" can be traced to the
 * right condition without re-deriving it from the database.
 */
export const MAIL_MOVE_IN_FLIGHT_ERROR = "上一条移动操作仍在处理中，请稍后重试。";

const MESSAGE_MIGRATION_ID = "message-payload-v1";
const ATTACHMENT_METADATA_MIGRATION_ID = "attachment-metadata-v1";
const messageKeyPurpose = "message-payload-v1";

export type StoredAddress = { name: string; address: string };

export type StoredAttachmentMetadata = {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  related: boolean;
  disposition: "attachment" | "inline";
  contentId?: string;
};

/**
 * Offline screening headers captured at sync time. `labels` are the IMAP
 * labels the server reported for the message (e.g. Gmail CATEGORY_*).
 * Optional fields are absent in payloads written before this extension and
 * read as empty defaults via `payloadHeaders`.
 */
export type StoredMessageHeaders = {
  autoSubmitted: string;
  listUnsubscribe: string;
  precedence: string;
  returnPath: string;
  labels: string[];
};

export const EMPTY_MESSAGE_HEADERS: StoredMessageHeaders = {
  autoSubmitted: "",
  listUnsubscribe: "",
  precedence: "",
  returnPath: "",
  labels: [],
};

export type MessagePayload = {
  messageId: string | null;
  subject: string;
  fromName: string;
  fromAddress: string;
  to: StoredAddress[];
  cc: StoredAddress[] | null;
  inReplyTo: string | null;
  references: string[] | null;
  snippet: string;
  textBody: string;
  htmlBody: string;
  attachments: StoredAttachmentMetadata[] | null;
  headers?: StoredMessageHeaders;
};

export function payloadHeaders(payload: MessagePayload): StoredMessageHeaders {
  const value = payload.headers;
  if (!value || typeof value !== "object") return EMPTY_MESSAGE_HEADERS;
  const item = value as Record<string, unknown>;
  return {
    autoSubmitted: typeof item.autoSubmitted === "string" ? item.autoSubmitted : "",
    listUnsubscribe: typeof item.listUnsubscribe === "string" ? item.listUnsubscribe : "",
    precedence: typeof item.precedence === "string" ? item.precedence : "",
    returnPath: typeof item.returnPath === "string" ? item.returnPath : "",
    labels: Array.isArray(item.labels)
      ? item.labels.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

export type MessageStorageRow = Record<string, unknown> & {
  id: string;
  account_id: string;
  mailbox: string;
  uid: number;
  encrypted_payload?: string | null;
  payload_version?: number | null;
  payload_metadata_ready?: number | null;
};

/** A message row paired with the generation its mailbox carried in the same read. */
export type GenerationStampedMessageRow = MessageStorageRow & {
  snapshot_uid_validity: string | null;
};

/**
 * Reads a message row and its mailbox generation as one snapshot.
 *
 * Downloads read the row and then spend an arbitrary time opening a connection.
 * A separate sync can rebuild the mailbox -- atomically rewriting `folders` and
 * resetting the folder's rows -- while that wait is in progress, so a generation
 * read *after* the wait would describe the provider's new epoch while the row
 * still names the old message (and its attachments). SQLite serves one
 * statement from one snapshot, so this pair always describes the same moment;
 * the caller compares the stamped value with the live `UIDVALIDITY` after the
 * mailbox lock and refuses on a mismatch.
 */
export function generationStampedMessage(db: DatabaseHandle, messageId: string): GenerationStampedMessageRow | undefined {
  return db.prepare(`
    SELECT m.*, f.uid_validity AS snapshot_uid_validity
    FROM messages AS m
    LEFT JOIN folders AS f ON f.account_id = m.account_id AND f.path = m.mailbox
    WHERE m.id = ?
  `).get(messageId) as GenerationStampedMessageRow | undefined;
}

function pendingMoveDestinationValue(row: unknown): string | null {
  const destination = row && typeof row === "object"
    ? (row as Record<string, unknown>).pending_move_destination
    : undefined;
  return typeof destination === "string" && destination.length > 0 ? destination : null;
}

/** A persisted intent exists before a MOVE command reaches the provider. */
export function pendingMoveIsIntent(row: unknown): boolean {
  if (!pendingMoveDestinationValue(row) || !row || typeof row !== "object") return false;
  return (row as Record<string, unknown>).pending_move_state === "intent";
}

/** A confirmed move without UIDPLUS or a provider-scoped stable message ID. */
export function hasUnverifiedMoveLocation(row: unknown): boolean {
  if (!pendingMoveDestinationValue(row) || !row || typeof row !== "object") return false;
  const value = row as Record<string, unknown>;
  if (value.pending_move_state !== "confirmed") return false;
  return typeof value.remote_id_lookup !== "string" || value.remote_id_lookup.length === 0;
}

export function hasPendingMove(row: unknown): boolean {
  return pendingMoveDestinationValue(row) !== null && !hasUnverifiedMoveLocation(row);
}

/** Returns the precise user-safe reason when a cached row cannot address a remote message. */
export function moveActionBlockedError(row: unknown): string | null {
  if (hasPendingMove(row)) return PENDING_MOVE_RECONCILIATION_ERROR;
  if (hasUnverifiedMoveLocation(row)) return MOVE_LOCATION_UNVERIFIED_ERROR;
  return null;
}

/** Returns the effective destination only after the provider has confirmed the move. */
export function pendingMoveDestination(row: unknown): string | null {
  return pendingMoveIsIntent(row) ? null : pendingMoveDestinationValue(row);
}

function payloadAad(id: string, accountId: string): string {
  return `messages\0${accountId}\0${id}\0payload-v1`;
}

// The HKDF derivation dominates bulk decrypt cost and its output depends only
// on (masterKey, purpose) — crypto.ts mixes in a compile-time-constant salt —
// so memoize it per master-key object (same pattern as message-remote-id.ts's
// remoteIdLookupKeyCache). The cached key shares the master key's own lifetime
// (both live for the whole process), which is why it is not zeroed after each
// use unlike a single-shot key. Callers never mutate the key.
const messageKeyCache = new WeakMap<Buffer, Buffer>();

function withMessageKey<T>(masterKey: Buffer, callback: (key: Buffer) => T): T {
  let key = messageKeyCache.get(masterKey);
  if (!key) {
    key = deriveEncryptionKey(masterKey, messageKeyPurpose);
    messageKeyCache.set(masterKey, key);
  }
  return callback(key);
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function addresses(value: unknown): StoredAddress[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    return [{
      name: typeof item.name === "string" ? item.name : "",
      address: typeof item.address === "string" ? item.address : "",
    }];
  });
}

function references(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function attachments(value: unknown): StoredAttachmentMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.partId !== "string") return [];
    const related = item.related === true;
    // `contentId` is the whole mechanism behind inline images: the wire layer
    // (message-wire.ts) builds the `cid:` rewrite map from it, and without an
    // entry the reader gets a `cid:xxx` URL no browser can resolve — a broken
    // image on every message that embeds one. Rebuilding the object
    // field-by-field silently dropped it, so the reader never rendered inline
    // images at all.
    //
    // Carried through verbatim (never trimmed or bracket-stripped) under the
    // write path's own "present or absent" contract: attachmentMetadataFromParsedMail
    // is the only producer of this field and already removes the `<>` that
    // mailparser hands over, so no value this function can be given needs
    // re-normalizing. Rows predating the encrypted payload carry the same
    // producer's output in `attachments_json`, and rows older still predate the
    // field entirely — an unbracketed value is therefore the only shape to
    // expect, here or on the legacy path below.
    const contentId = typeof item.contentId === "string" && item.contentId !== "" ? item.contentId : undefined;
    return [{
      partId: item.partId,
      filename: typeof item.filename === "string" ? item.filename : "",
      contentType: typeof item.contentType === "string" ? item.contentType : "application/octet-stream",
      size: typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : 0,
      related,
      disposition: item.disposition === "inline" || related ? "inline" : "attachment",
      ...(contentId ? { contentId } : {}),
    }];
  });
}

function legacyPayload(row: MessageStorageRow): MessagePayload {
  return {
    messageId: asNullableString(row.message_id),
    subject: typeof row.subject === "string" ? row.subject : "",
    fromName: typeof row.from_name === "string" ? row.from_name : "",
    fromAddress: typeof row.from_address === "string" ? row.from_address : "",
    to: addresses(parseJson(row.to_json)),
    cc: row.cc_json === null || row.cc_json === undefined ? null : addresses(parseJson(row.cc_json)),
    inReplyTo: asNullableString(row.in_reply_to),
    references: row.references_json === null || row.references_json === undefined
      ? null
      : references(parseJson(row.references_json)),
    snippet: typeof row.snippet === "string" ? row.snippet : "",
    textBody: typeof row.text_body === "string" ? row.text_body : "",
    htmlBody: typeof row.html_body === "string" ? row.html_body : "",
    attachments: row.attachments_json === null || row.attachments_json === undefined
      ? null
      : attachments(parseJson(row.attachments_json)),
  };
}

function normalizePayload(value: unknown): MessagePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Encrypted message payload is invalid.");
  }
  const item = value as Record<string, unknown>;
  return {
    messageId: asNullableString(item.messageId),
    subject: typeof item.subject === "string" ? item.subject : "",
    fromName: typeof item.fromName === "string" ? item.fromName : "",
    fromAddress: typeof item.fromAddress === "string" ? item.fromAddress : "",
    to: addresses(item.to),
    cc: item.cc === null ? null : addresses(item.cc),
    inReplyTo: asNullableString(item.inReplyTo),
    references: item.references === null ? null : references(item.references),
    snippet: typeof item.snippet === "string" ? item.snippet : "",
    textBody: typeof item.textBody === "string" ? item.textBody : "",
    htmlBody: typeof item.htmlBody === "string" ? item.htmlBody : "",
    attachments: item.attachments === null ? null : attachments(item.attachments),
    headers: item.headers === undefined ? undefined : payloadHeaders(item as MessagePayload),
  };
}

export function encryptMessagePayload(masterKey: Buffer, id: string, accountId: string, payload: MessagePayload): string {
  return withMessageKey(masterKey, (key) =>
    encryptTextEnvelope(JSON.stringify(payload), key, payloadAad(id, accountId)));
}

// Decrypting a row is cheap for a small message but dominates the cost of
// listing folders full of large bodies (newsletters, receipts), where the
// same page is re-read on every folder open. A payload is immutable once
// written: any re-encryption (metadata hydration, migration) or tampering
// changes the ciphertext, and the full ciphertext in the key forces a fresh
// authenticated decrypt instead of a stale hit. Callers treat payloads as
// read-only, so the cached object is shared.
// Sizing against a real 2400-message mailbox (avg payload ~48KB): the old
// 128-entry/16MB bounds held only ~340 rows, so every silent refresh
// re-decrypted the visible page inside the Electron main process (measured
// 258-426ms per GET /api/messages). 512/64MB keeps several views' pages hot;
// the cache is plaintext and stays in process memory only.
const PAYLOAD_CACHE_MAX_ENTRIES = 512;
const PAYLOAD_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const payloadCache = new Map<string, { payload: MessagePayload; bytes: number }>();
let payloadCacheBytes = 0;

// Per-entry allowances cover the JS object/array wrappers the estimate cannot
// see: a V8 map slot plus the property names, ~64 bytes for an address entry
// and ~192 for an attachment (part id, filename, content type, content id).
// They are deliberately generous so the budget errs toward evicting.
const PAYLOAD_STRUCTURE_BYTES = 256;
const ADDRESS_METADATA_BYTES = 64;
const ATTACHMENT_METADATA_BYTES = 192;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function addressBytes(list: StoredAddress[]): number {
  let total = 0;
  for (const entry of list) total += ADDRESS_METADATA_BYTES + utf8Bytes(entry.name) + utf8Bytes(entry.address);
  return total;
}

function attachmentBytes(list: StoredAttachmentMetadata[] | null): number {
  let total = 0;
  for (const entry of list ?? []) {
    // `contentId` is a real retained string on the payload object, so it is
    // counted like every other field. It used to be under-counted (the reader
    // dropped it on the way out of storage, so the estimate matched what was
    // handed back); now that the read path carries it, counting it is the
    // accurate answer rather than a new cost.
    total += ATTACHMENT_METADATA_BYTES
      + utf8Bytes(entry.partId) + utf8Bytes(entry.filename) + utf8Bytes(entry.contentType)
      + (entry.contentId ? utf8Bytes(entry.contentId) : 0);
  }
  return total;
}

/**
 * Retained-memory estimate for one cached payload, measured from the fields
 * the payload already holds instead of serializing it again.
 *
 * The whole point is to cost nothing on a big body: the previous
 * `JSON.stringify` allocated a full serialized twin of every message being
 * listed (a second multi-megabyte string per row on a page of oversized mail)
 * purely to throw it away. Measuring each field with `Buffer.byteLength` is a
 * native scan that copies nothing, so the cost is linear in bytes the row
 * already occupies instead of linear in bytes allocated.
 *
 * Accuracy: the UTF-8 length of the raw fields closely tracks the retained
 * strings — exact for Latin-1 (V8 one-byte strings) and ~1.5x conservative for
 * CJK, which V8 keeps as two-byte code units. The only systematic deviation
 * from the old exact number is JSON escaping, which can inflate the serialized
 * form (every control byte becomes `\u00XX`); real mail escapes far less than
 * the allowances above add back. A body made entirely of control bytes is
 * therefore the one input the cache can under-count, and the consequence is
 * bounded: a too-large entry evicts slightly late, never past the process's
 * real budget by more than that row's own size.
 */
export function payloadByteEstimate(payload: MessagePayload): number {
  return PAYLOAD_STRUCTURE_BYTES
    + utf8Bytes(payload.subject)
    + utf8Bytes(payload.fromName)
    + utf8Bytes(payload.fromAddress)
    + utf8Bytes(payload.snippet)
    + utf8Bytes(payload.textBody)
    + utf8Bytes(payload.htmlBody)
    + (payload.messageId ? utf8Bytes(payload.messageId) : 0)
    + (payload.inReplyTo ? utf8Bytes(payload.inReplyTo) : 0)
    + (payload.references ?? []).reduce((total, value) => total + utf8Bytes(value), 0)
    + addressBytes(payload.to)
    + addressBytes(payload.cc ?? [])
    + attachmentBytes(payload.attachments);
}

function cachePayload(key: string, payload: MessagePayload): void {
  const bytes = payloadByteEstimate(payload);
  // A single payload larger than the whole budget would evict the entire
  // cache on every fill; keep it uncached instead (a cache miss decrypts the
  // same way a fresh read would).
  if (bytes > PAYLOAD_CACHE_MAX_BYTES) return;
  while (payloadCache.size >= PAYLOAD_CACHE_MAX_ENTRIES || payloadCacheBytes + bytes > PAYLOAD_CACHE_MAX_BYTES) {
    const oldestKey = payloadCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = payloadCache.get(oldestKey);
    if (oldest) payloadCacheBytes -= oldest.bytes;
    payloadCache.delete(oldestKey);
  }
  payloadCache.set(key, { payload, bytes });
  payloadCacheBytes += bytes;
}

export function messagePayloadForRow(row: MessageStorageRow, masterKey: Buffer): MessagePayload {
  if (typeof row.encrypted_payload !== "string" || !row.encrypted_payload) return legacyPayload(row);
  const cacheKey = `${masterKey.toString("hex")}\0${row.id}\0${row.encrypted_payload}`;
  const cached = payloadCache.get(cacheKey);
  if (cached) {
    // Refresh LRU recency without re-decrypting.
    payloadCache.delete(cacheKey);
    payloadCache.set(cacheKey, cached);
    return cached.payload;
  }
  return withMessageKey(masterKey, (key) => {
    const plaintext = decryptTextEnvelope(row.encrypted_payload as string, key, payloadAad(row.id, row.account_id));
    try {
      const payload = normalizePayload(JSON.parse(plaintext) as unknown);
      cachePayload(cacheKey, payload);
      return payload;
    } catch (error) {
      if (error instanceof Error && error.message === "Encrypted message payload is invalid.") throw error;
      throw new Error("Encrypted message payload is invalid.");
    }
  });
}

export function protectedMessageColumns(
  masterKey: Buffer,
  id: string,
  accountId: string,
  payload: MessagePayload,
): Record<string, unknown> {
  return {
    messageId: null,
    subject: "",
    fromName: "",
    fromAddress: "",
    toJson: "[]",
    ccJson: "[]",
    inReplyTo: null,
    referencesJson: "[]",
    snippet: "",
    textBody: "",
    htmlBody: "",
    attachmentsJson: "[]",
    encryptedPayload: encryptMessagePayload(masterKey, id, accountId, payload),
    payloadVersion: MESSAGE_PAYLOAD_VERSION,
  };
}

function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** Mirrors SQLite's default LIKE behavior for literal substring search. */
export function messagePayloadMatchesQuery(payload: MessagePayload, query: string): boolean {
  const needle = asciiFold(query);
  return [payload.subject, payload.fromName, payload.fromAddress, payload.textBody]
    .some((value) => asciiFold(value).includes(needle));
}

export function messagePayloadById(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
): { row: MessageStorageRow; payload: MessagePayload } | undefined {
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageStorageRow | undefined;
  return row ? { row, payload: messagePayloadForRow(row, masterKey) } : undefined;
}

function clearPlaintextColumns(db: DatabaseHandle, row: MessageStorageRow, encryptedPayload: string): void {
  db.prepare(`
    UPDATE messages
    SET message_id = NULL,
        subject = '',
        from_name = '',
        from_address = '',
        to_json = '[]',
        cc_json = '[]',
        in_reply_to = NULL,
        references_json = '[]',
        snippet = '',
        text_body = '',
        html_body = '',
        attachments_json = '[]',
        encrypted_payload = ?,
        payload_version = ?
    WHERE id = ?
  `).run(encryptedPayload, MESSAGE_PAYLOAD_VERSION, row.id);
}

// Pages of payloads verified per statement while streaming; sized so peak
// memory stays at one page of ciphertext instead of the whole mailbox
// (~115MB for 2400 x 48KB rows before this was paginated).
const VERIFICATION_PAGE_SIZE = 200;

/**
 * Decrypts every stored payload in rowid-keyset pages and throws once the sweep
 * is done if any row could not be decrypted. Rows are collected first, so the
 * error can name the affected ids: the previous "throw on the first bad row"
 * gave the operator a stack trace with no idea which message was damaged or how
 * many others were, and the marker is only written after a clean sweep, so every
 * following start failed the same way with the same silence.
 *
 * Runs only when the encryption migration's proof of decryptability can be
 * stale: when the marker is still missing (first startup after the migration, or
 * a marker cleared by an interrupted retry — a crash mid-migration can leave rows
 * in either form) and whenever rows were re-encrypted during this pass. Routine
 * startups (marker present, nothing migrated) skip the sweep entirely: re-proving
 * every row costs a full decrypt of the mailbox plus seconds of main-process
 * block before listen, for a property the next real decrypt re-establishes
 * anyway — a row corrupted after the sweep is skipped surfaces there instead. A
 * fingerprint/sample hybrid was rejected because a sampled scheme still passes a
 * corrupted row a full pass would catch, and the stored ciphertext length carries
 * no authenticated fingerprint to compare against.
 */
function verifyEncryptedPayloads(
  db: DatabaseHandle,
  masterKey: Buffer,
): { verified: number; unreadable: string[] } {
  // Keyset pagination over rowid (the physical scan order, never NULL): each
  // page reads only its own ciphertexts, so peak memory is one page instead
  // of the whole mailbox.
  const page = db.prepare(`
    SELECT rowid, id, account_id, encrypted_payload, payload_version FROM messages
    WHERE rowid > ? ORDER BY rowid LIMIT ?
  `);
  let cursor = 0;
  let verified = 0;
  let total = 0;
  // Bounded: a store where everything is unreadable must not build a list of
  // every id before failing closed.
  const unreadable: string[] = [];
  const UNREADABLE_ID_SAMPLE = 50;
  for (;;) {
    const batch = page.all(cursor, VERIFICATION_PAGE_SIZE) as Array<MessageStorageRow & { rowid: number }>;
    if (batch.length === 0) break;
    for (const row of batch) {
      total += 1;
      try {
        messagePayloadForRow(row, masterKey);
        verified += 1;
      } catch {
        if (unreadable.length < UNREADABLE_ID_SAMPLE) unreadable.push(row.id);
      }
    }
    cursor = batch[batch.length - 1]!.rowid;
    if (batch.length < VERIFICATION_PAGE_SIZE) break;
  }
  if (unreadable.length > 0) {
    // Fail closed on purpose: a payload that cannot be decrypted means the file
    // no longer matches what was written, and starting up would hide that. The
    // error names the rows because a stack trace alone left the operator with no
    // way to tell one damaged message from a key problem.
    throw new Error(
      `${unreadable.length} of ${total} stored message payload(s) could not be decrypted after migration. `
      + `The file was left untouched. First affected ids: ${unreadable.join(", ")}`,
    );
  }
  return { verified, unreadable };
}

/**
 * Encrypts legacy rows transactionally in rowid-keyset pages. Missing completion
 * markers cause the physical cleanup to be retried after an interrupted
 * migration.
 */
export function migrateMessageStorage(
  db: DatabaseHandle,
  masterKey: Buffer,
): { migrated: number; vacuumed: boolean; unreadable: string[] } {
  const marker = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(MESSAGE_MIGRATION_ID);
  // Paged like the verification sweep: a first start after the encryption
  // migration matches every row, and reading them all at once was measured at
  // hundreds of MB of JS heap for a large mailbox before listen.
  const selectPage = db.prepare(`
    SELECT rowid, * FROM messages
    WHERE rowid > ? AND (
      encrypted_payload IS NULL OR encrypted_payload = '' OR payload_version <> ?
         OR message_id IS NOT NULL OR subject <> '' OR from_name <> '' OR from_address <> ''
         OR to_json <> '[]' OR COALESCE(cc_json, '[]') <> '[]' OR in_reply_to IS NOT NULL
         OR COALESCE(references_json, '[]') <> '[]' OR snippet <> '' OR text_body <> '' OR html_body <> ''
         OR COALESCE(attachments_json, '[]') <> '[]'
    )
    ORDER BY rowid LIMIT ?
  `);

  let migrated = 0;
  db.transaction(() => {
    let cursor = 0;
    for (;;) {
      const rows = selectPage.all(cursor, MESSAGE_PAYLOAD_VERSION, VERIFICATION_PAGE_SIZE) as Array<
        MessageStorageRow & { rowid: number }
      >;
      if (rows.length === 0) break;
      for (const row of rows) {
        const payload = messagePayloadForRow(row, masterKey);
        clearPlaintextColumns(db, row, encryptMessagePayload(masterKey, row.id, row.account_id, payload));
      }
      migrated += rows.length;
      cursor = rows[rows.length - 1]!.rowid;
      if (rows.length < VERIFICATION_PAGE_SIZE) break;
    }
  })();

  // Previously this sweep decrypted the whole mailbox on every startup,
  // before listen. It is now owed only when the decryptability proof can be
  // stale: no marker yet (first startup after the migration, or a marker
  // cleared by an interrupted retry) or rows migrated in this pass.
  const verification = !marker || migrated > 0
    ? verifyEncryptedPayloads(db, masterKey)
    : { verified: 0, unreadable: [] };

  let vacuumed = false;
  if (migrated > 0 || (!marker && verification.verified > 0)) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.pragma("wal_checkpoint(TRUNCATE)");
    vacuumed = true;
  }
  db.prepare(`
    INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
  `).run(MESSAGE_MIGRATION_ID, new Date().toISOString());
  if (vacuumed) db.pragma("wal_checkpoint(TRUNCATE)");
  // Unreadable rows are reported rather than thrown: the sweep now distinguishes
  // "one damaged message" from "nothing readable at all" (which still throws).
  return { migrated, vacuumed, unreadable: verification.unreadable };
}

/**
 * Recomputes both derived attachment columns for rows written before the
 * visible-attachment rule existed: `has_attachments` used to count every part
 * the parser listed, including `multipart/related` inline images, so a message
 * whose only "attachment" was a signature logo or tracking pixel carried a
 * paperclip that the reader — which lists only non-related parts — could not
 * explain. `attachment_kinds_json` had the same bias: its kinds could name an
 * attachment the reader never shows.
 *
 * One decrypt sweep for both columns (the same cost profile as the FTS
 * rebuild), in rowid-keyset pages so a large mailbox is not read into memory at
 * once. Runs after `migrateMessageStorage`, which guarantees every row holds a
 * decryptable payload. A row whose payload cannot be read keeps its previous
 * values: nothing can be derived from it, and inventing zeros would trade one
 * inconsistency for another.
 *
 * That exception is counted rather than dropped. The sweep still records its
 * marker — a permanently unreadable row must not cost a full-table decrypt on
 * every start — so the returned `unclassified` count is the only trace that the
 * columns and the derived metadata disagree somewhere, and callers that gain a
 * diagnostics surface should report it.
 */
export function ensureAttachmentMetadata(
  db: DatabaseHandle,
  masterKey: Buffer,
): { backfilled: number; unclassified: number } {
  const marker = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(ATTACHMENT_METADATA_MIGRATION_ID);
  if (marker) return { backfilled: 0, unclassified: 0 };
  const selectPage = db.prepare(`
    SELECT rowid, * FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?
  `);
  const update = db.prepare("UPDATE messages SET has_attachments = ?, attachment_kinds_json = ? WHERE id = ?");
  let backfilled = 0;
  let unclassified = 0;
  db.transaction(() => {
    let cursor = 0;
    for (;;) {
      const rows = selectPage.all(cursor, VERIFICATION_PAGE_SIZE) as Array<MessageStorageRow & { rowid: number }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        let payload: MessagePayload;
        try {
          payload = messagePayloadForRow(row, masterKey);
        } catch {
          // Unreadable payloads cannot be classified either; the row keeps the
          // flag it had, and the count below is what says so.
          unclassified += 1;
          continue;
        }
        const visible = (payload.attachments ?? []).filter(isVisibleAttachment);
        update.run(visible.length ? 1 : 0, attachmentKindsJson(visible), row.id);
        backfilled += 1;
      }
      cursor = rows[rows.length - 1]!.rowid;
      if (rows.length < VERIFICATION_PAGE_SIZE) break;
    }
    db.prepare(`
      INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
    `).run(ATTACHMENT_METADATA_MIGRATION_ID, new Date().toISOString());
  })();
  return { backfilled, unclassified };
}
