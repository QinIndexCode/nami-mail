import type { DatabaseHandle } from "./db.js";
import { decryptTextEnvelope, deriveEncryptionKey, encryptTextEnvelope } from "./crypto.js";

export const MESSAGE_PAYLOAD_VERSION = 1;
export const MAX_ENCRYPTED_SEARCH_CANDIDATES = 5_000;
export const PENDING_MOVE_RECONCILIATION_ERROR = "邮件正在同步移动后的新位置，请稍后重试。";
export const MOVE_LOCATION_UNVERIFIED_ERROR = "邮件已移动，但邮箱服务器未提供可验证的新位置。请刷新目标文件夹后再修改邮件或下载附件。";

const MESSAGE_MIGRATION_ID = "message-payload-v1";
const messageKeyPurpose = "message-payload-v1";

export type StoredAddress = { name: string; address: string };

export type StoredAttachmentMetadata = {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  related: boolean;
  disposition: "attachment" | "inline";
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

function withMessageKey<T>(masterKey: Buffer, callback: (key: Buffer) => T): T {
  const key = deriveEncryptionKey(masterKey, messageKeyPurpose);
  try {
    return callback(key);
  } finally {
    key.fill(0);
  }
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
    return [{
      partId: item.partId,
      filename: typeof item.filename === "string" ? item.filename : "",
      contentType: typeof item.contentType === "string" ? item.contentType : "application/octet-stream",
      size: typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : 0,
      related,
      disposition: item.disposition === "inline" || related ? "inline" : "attachment",
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
const PAYLOAD_CACHE_MAX_ENTRIES = 128;
const PAYLOAD_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const payloadCache = new Map<string, { payload: MessagePayload; bytes: number }>();
let payloadCacheBytes = 0;

function payloadByteEstimate(payload: MessagePayload): number {
  // The payload is a plain JSON-shaped object, so the UTF-8 byte length of
  // its serialized form bounds retained memory closely enough for eviction.
  // (A naive character-count sum would undercount CJK bodies by up to 2x and
  // ignore Map/entry overhead.)
  return Buffer.byteLength(JSON.stringify(payload), "utf8") + 64;
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

/**
 * Encrypts legacy rows transactionally. Missing completion markers cause the
 * physical cleanup to be retried after an interrupted migration.
 */
export function migrateMessageStorage(db: DatabaseHandle, masterKey: Buffer): { migrated: number; vacuumed: boolean } {
  const marker = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(MESSAGE_MIGRATION_ID);
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE encrypted_payload IS NULL OR encrypted_payload = '' OR payload_version <> ?
       OR message_id IS NOT NULL OR subject <> '' OR from_name <> '' OR from_address <> ''
       OR to_json <> '[]' OR COALESCE(cc_json, '[]') <> '[]' OR in_reply_to IS NOT NULL
       OR COALESCE(references_json, '[]') <> '[]' OR snippet <> '' OR text_body <> '' OR html_body <> ''
       OR COALESCE(attachments_json, '[]') <> '[]'
  `).all(MESSAGE_PAYLOAD_VERSION) as MessageStorageRow[];

  const migrate = db.transaction(() => {
    for (const row of rows) {
      const payload = messagePayloadForRow(row, masterKey);
      clearPlaintextColumns(db, row, encryptMessagePayload(masterKey, row.id, row.account_id, payload));
    }
  });
  migrate();

  const encryptedRows = db.prepare("SELECT id, account_id, encrypted_payload, payload_version FROM messages").all() as MessageStorageRow[];
  for (const row of encryptedRows) messagePayloadForRow(row, masterKey);

  let vacuumed = false;
  if (rows.length > 0 || (!marker && encryptedRows.length > 0)) {
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
  return { migrated: rows.length, vacuumed };
}
