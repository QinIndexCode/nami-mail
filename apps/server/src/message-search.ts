import type { DatabaseHandle } from "./db.js";
import { messagePayloadForRow, type MessagePayload, type MessageStorageRow } from "./message-storage.js";

export const MESSAGE_FTS_TABLE = "messages_fts";
const MESSAGE_FTS_MIGRATION_ID = "message-fts-v2";
// Column names introduced by the v2 schema. Older tables (built by the v1 build
// that only indexed subject/sender/body) are upgraded by recreating the table
// with the full schema (FTS5 cannot ALTER ADD COLUMN on a virtual table), then
// re-indexing every row.
const FTS_V2_EXTRA_COLUMNS = ["to", "cc", "attachment"] as const;

/**
 * Canonical DDL for the search table. Defined here so a migration that must
 * rebuild the table recreates it with the exact same schema a fresh install
 * uses; db.ts reuses it inside the startup schema block.
 */
export const MESSAGE_FTS_SCHEMA_SQL =
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${MESSAGE_FTS_TABLE} USING fts5(subject, from_name, from_address, "to", "cc", attachment, body, message_id UNINDEXED, tokenize = 'trigram');`;

/**
 * Text fields mirrored from the decrypted message payload. They intentionally
 * mirror the historical substring semantics over subject, sender, and body, and
 * additionally index recipient addresses/names and attachment filenames so a
 * search can locate "who was mailed at X" or "message with the report.pdf".
 */
export function ftsTextForPayload(payload: Pick<MessagePayload, "subject" | "fromName" | "fromAddress" | "to" | "cc" | "textBody" | "attachments">): {
  subject: string;
  fromName: string;
  fromAddress: string;
  to: string;
  cc: string;
  attachment: string;
  body: string;
} {
  const addressText = (addresses: Array<{ name?: string; address: string }> | null | undefined): string =>
    (addresses ?? []).map((entry) => `${entry.name ?? ""} ${entry.address ?? ""}`.trim()).filter(Boolean).join(" ");
  const attachmentText = (attachments: Array<{ filename?: string }> | null | undefined): string =>
    (attachments ?? []).map((entry) => entry.filename ?? "").filter(Boolean).join(" ");
  return {
    subject: payload.subject,
    fromName: payload.fromName,
    fromAddress: payload.fromAddress,
    to: addressText(payload.to),
    cc: addressText(payload.cc),
    attachment: attachmentText(payload.attachments),
    body: payload.textBody,
  };
}

/** Escapes LIKE wildcards so a user query is matched literally. */
export function ftsLikeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const deleteStatement = (db: DatabaseHandle) => db.prepare(`DELETE FROM ${MESSAGE_FTS_TABLE} WHERE message_id = ?`);
const insertStatement = (db: DatabaseHandle) => db.prepare(`
  INSERT INTO ${MESSAGE_FTS_TABLE} (message_id, subject, from_name, from_address, "to", "cc", "attachment", body)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

/** Adds the v2 columns to an older FTS table by recreating it with the full
 * schema, since FTS5 virtual tables cannot be altered in place. Columns are
 * read via PRAGMA table_info (which works on FTS5), so an untouched fresh table
 * is a no-op. Returns true when the table was rebuilt for re-indexing. */
export function ensureFtsSchemaColumns(db: DatabaseHandle): boolean {
  const columns = db.prepare(`PRAGMA table_info(${MESSAGE_FTS_TABLE})`).all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  const missing = FTS_V2_EXTRA_COLUMNS.some((column) => !existing.has(column));
  if (!missing) return false;
  db.exec(`DROP TABLE IF EXISTS ${MESSAGE_FTS_TABLE}`);
  db.exec(MESSAGE_FTS_SCHEMA_SQL);
  return true;
}

/** Deletes then re-inserts the index row so re-synced payload text stays current. */
export function indexMessageFts(db: DatabaseHandle, messageId: string, payload: Pick<MessagePayload, "subject" | "fromName" | "fromAddress" | "to" | "cc" | "textBody" | "attachments">): void {
  const text = ftsTextForPayload(payload);
  db.transaction(() => {
    deleteStatement(db).run(messageId);
    insertStatement(db).run(messageId, text.subject, text.fromName, text.fromAddress, text.to, text.cc, text.attachment, text.body);
  })();
}

export function deleteMessageFts(db: DatabaseHandle, messageId: string): void {
  deleteStatement(db).run(messageId);
}

export function ftsIndexedMessageCount(db: DatabaseHandle): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${MESSAGE_FTS_TABLE}`).get() as { count: number }).count);
}

/**
 * Rebuilds the search index for every message. Only rows that cannot be
 * decrypted are skipped (they were never readable for search either).
 * Returns the number of messages indexed.
 */
export function rebuildMessageFtsIndex(db: DatabaseHandle, masterKey: Buffer): number {
  const rows = db.prepare("SELECT * FROM messages ORDER BY created_at, id").all() as MessageStorageRow[];
  let indexed = 0;
  db.transaction(() => {
    db.prepare(`DELETE FROM ${MESSAGE_FTS_TABLE}`).run();
    const index = insertStatement(db);
    for (const row of rows) {
      let payload: MessagePayload;
      try {
        payload = messagePayloadForRow(row, masterKey);
      } catch {
        continue; // Unreadable payloads cannot be indexed or searched.
      }
      const text = ftsTextForPayload(payload);
      index.run(row.id, text.subject, text.fromName, text.fromAddress, text.to, text.cc, text.attachment, text.body);
      indexed += 1;
    }
  })();
  return indexed;
}

/**
 * One-time migration entry: after legacy payloads were encrypted
 * (`migrateMessageStorage`), build the FTS index for all rows. The marker
 * prevents a full decrypt-and-index pass on every startup; incremental writes
 * are maintained from the sync and draft paths. When the index was built by an
 * older schema, the v2 columns are added in place before the full rebuild, so
 * recipient and attachment searches work for pre-existing mail too.
 */
export function ensureMessageFtsIndex(db: DatabaseHandle, masterKey: Buffer): { indexed: number; rebuilt: boolean } {
  ensureFtsSchemaColumns(db);
  const marker = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(MESSAGE_FTS_MIGRATION_ID);
  if (marker) return { indexed: 0, rebuilt: false };
  const indexed = rebuildMessageFtsIndex(db, masterKey);
  db.prepare(`
    INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
  `).run(MESSAGE_FTS_MIGRATION_ID, new Date().toISOString());
  return { indexed, rebuilt: true };
}
