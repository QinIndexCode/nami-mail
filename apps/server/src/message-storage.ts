import type { DatabaseHandle } from "./db.js";
import { decryptTextEnvelope, deriveEncryptionKey, encryptTextEnvelope } from "./crypto.js";

export const MESSAGE_PAYLOAD_VERSION = 1;
export const MAX_ENCRYPTED_SEARCH_CANDIDATES = 5_000;

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
};

export type MessageStorageRow = Record<string, unknown> & {
  id: string;
  account_id: string;
  mailbox: string;
  uid: number;
  encrypted_payload?: string | null;
  payload_version?: number | null;
};

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
  };
}

export function encryptMessagePayload(masterKey: Buffer, id: string, accountId: string, payload: MessagePayload): string {
  return withMessageKey(masterKey, (key) =>
    encryptTextEnvelope(JSON.stringify(payload), key, payloadAad(id, accountId)));
}

export function messagePayloadForRow(row: MessageStorageRow, masterKey: Buffer): MessagePayload {
  if (typeof row.encrypted_payload !== "string" || !row.encrypted_payload) return legacyPayload(row);
  return withMessageKey(masterKey, (key) => {
    const plaintext = decryptTextEnvelope(row.encrypted_payload as string, key, payloadAad(row.id, row.account_id));
    try {
      return normalizePayload(JSON.parse(plaintext) as unknown);
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
