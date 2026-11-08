import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decryptTextEnvelope, encryptTextEnvelope, deriveEncryptionKey } from "./crypto.js";
import { databaseKeyLiteral } from "./database-encryption.js";
import { loadDatabaseConstructor } from "./native-sqlite.js";
import { SCHEMA_VERSION, type DatabaseHandle } from "./db.js";
import { markSubmissionUnknownDelivery } from "./outbox.js";
import { BackupError } from "./portable-backup-format.js";

export const restoreIdSchema = z.uuid();
const pointerFile = "active-restore.enc";
const pointerSchema = z.object({ id: restoreIdSchema, masterKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict();
export function restoreDirectory(originalDatabasePath: string, id: string): string {
  const root = path.resolve(path.dirname(originalDatabasePath), "restored-data");
  const directory = path.resolve(root, restoreIdSchema.parse(id));
  if (path.dirname(directory) !== root) throw new BackupError("Invalid restore directory.");
  return directory;
}
function withHostKey<T>(key: Buffer, action: (derived: Buffer) => T): T {
  const derived = deriveEncryptionKey(key, "portable-restore-pointer-v1");
  try { return action(derived); } finally { derived.fill(0); }
}
export function resolveBackupStorage(originalDatabasePath: string, hostKey: Buffer): { databasePath: string; masterKey: Buffer } {
  const pointer = path.join(path.dirname(originalDatabasePath), pointerFile);
  if (!fs.existsSync(pointer)) return { databasePath: originalDatabasePath, masterKey: Buffer.from(hostKey) };
  const parsed = withHostKey(hostKey, (key) => pointerSchema.parse(JSON.parse(decryptTextEnvelope(fs.readFileSync(pointer, "utf8"), key, "active-restore-v1"))));
  const databasePath = path.join(restoreDirectory(originalDatabasePath, parsed.id), "database.sqlite");
  if (!fs.existsSync(databasePath)) throw new BackupError("Activated restore is missing. The original data is preserved; repair the restore pointer before continuing.");
  return { databasePath, masterKey: Buffer.from(parsed.masterKey, "base64url") };
}
export function activateBackupStorage(originalDatabasePath: string, hostKey: Buffer, id: string, masterKey: Buffer): void {
  const pointer = path.join(path.dirname(originalDatabasePath), pointerFile);
  const payload = withHostKey(hostKey, (key) => encryptTextEnvelope(JSON.stringify({ id, masterKey: masterKey.toString("base64url") }), key, "active-restore-v1"));
  const temporary = `${pointer}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, payload, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, pointer); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function openBackupDatabase(filename: string, masterKey: Buffer, readonly = true): DatabaseHandle {
  const db = new (loadDatabaseConstructor())(filename, { readonly, fileMustExist: true });
  try {
    db.prepare(`PRAGMA key = ${databaseKeyLiteral(masterKey)}`).run();
    if (db.pragma("quick_check", { simple: true }) !== "ok") throw new BackupError("Backup database integrity check failed.");
    const version = Number(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").pluck().get());
    if (!Number.isInteger(version) || version < 5 || version > SCHEMA_VERSION) throw new BackupError("Backup schema is not supported by this build.");
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new BackupError("Backup database has broken references.");
    return db;
  } catch (error) { db.close(); throw error; }
}
export function pauseRestoredWork(db: DatabaseHandle, key: Buffer): void {
  db.transaction(() => {
    const pending = db.prepare("SELECT id FROM outbound_submissions WHERE status IN ('pending','submitting')").all() as Array<{ id: string }>;
    for (const row of pending) markSubmissionUnknownDelivery(db, key, row.id, "backup_restored", "Restored from a backup. Check the provider Sent folder before creating another send.");
    const now = Date.now();
    db.prepare("UPDATE tasks SET status='cancelled',completed_at=?,updated_at=?,error_code='backup_restored',error_message='Stopped after restoring a backup; review before repeating.' WHERE completed_at IS NULL").run(now, now);
    db.prepare("UPDATE messages SET pending_move_destination=NULL,pending_move_state=NULL").run();
    db.prepare("DELETE FROM auto_reply_queue").run();
    const settings = db.prepare("SELECT auto_reply_config FROM app_settings WHERE id=1").get() as { auto_reply_config: string | null } | undefined;
    if (settings?.auto_reply_config) {
      const value = JSON.parse(settings.auto_reply_config) as Record<string, unknown>;
      db.prepare("UPDATE app_settings SET auto_reply_config=? WHERE id=1").run(JSON.stringify({ ...value, enabled: false }));
    }
    db.prepare("UPDATE filter_rules SET enabled=0").run();
  })();
}
