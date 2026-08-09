import type { DatabaseHandle } from "./db.js";
import { messagePayloadForRow, type MessagePayload, type MessageStorageRow } from "./message-storage.js";

export const MESSAGE_FTS_TABLE = "messages_fts";
const MESSAGE_FTS_MIGRATION_ID = "message-fts-v1";

/**
 * Text fields mirrored from the decrypted message payload. They intentionally
 * match `messagePayloadMatchesQuery` so an FTS hit set stays aligned with the
 * historical substring semantics over subject, sender, and body.
 */
export function ftsTextForPayload(payload: Pick<MessagePayload, "subject" | "fromName" | "fromAddress" | "textBody">): {
  subject: string;
  fromName: string;
  fromAddress: string;
  body: string;
} {
  return {
    subject: payload.subject,
    fromName: payload.fromName,
    fromAddress: payload.fromAddress,
    body: payload.textBody,
  };
}

/** Escapes LIKE wildcards so a user query is matched literally. */
export function ftsLikeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const deleteStatement = (db: DatabaseHandle) => db.prepare(`DELETE FROM ${MESSAGE_FTS_TABLE} WHERE message_id = ?`);
const insertStatement = (db: DatabaseHandle) => db.prepare(`
  INSERT INTO ${MESSAGE_FTS_TABLE} (message_id, subject, from_name, from_address, body)
  VALUES (?, ?, ?, ?, ?)
`);

/** Deletes then re-inserts the index row so re-synced payload text stays current. */
export function indexMessageFts(db: DatabaseHandle, messageId: string, payload: Pick<MessagePayload, "subject" | "fromName" | "fromAddress" | "textBody">): void {
  const text = ftsTextForPayload(payload);
  db.transaction(() => {
    deleteStatement(db).run(messageId);
    insertStatement(db).run(messageId, text.subject, text.fromName, text.fromAddress, text.body);
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
      index.run(row.id, text.subject, text.fromName, text.fromAddress, text.body);
      indexed += 1;
    }
  })();
  return indexed;
}

/**
 * One-time migration entry: after legacy payloads were encrypted
 * (`migrateMessageStorage`), build the FTS index for all rows. The marker
 * prevents a full decrypt-and-index pass on every startup; incremental writes
 * are maintained from the sync and draft paths.
 */
export function ensureMessageFtsIndex(db: DatabaseHandle, masterKey: Buffer): { indexed: number; rebuilt: boolean } {
  const marker = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(MESSAGE_FTS_MIGRATION_ID);
  if (marker) return { indexed: 0, rebuilt: false };
  const indexed = rebuildMessageFtsIndex(db, masterKey);
  db.prepare(`
    INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
  `).run(MESSAGE_FTS_MIGRATION_ID, new Date().toISOString());
  return { indexed, rebuilt: true };
}
