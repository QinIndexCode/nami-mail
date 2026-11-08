import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type DatabaseHandle, SCHEMA_VERSION } from "./db.js";
import { decryptTextEnvelope, encryptTextEnvelope } from "./crypto.js";
import { customBackgroundPattern, openCustomBackground } from "./background-image.js";
import { resolveOutboundAttachments } from "./outbound-attachments.js";
import { messagePayloadForRow, type MessageStorageRow } from "./message-storage.js";
import { BackupError, decodeBackup, encodeBackup, MAX_BACKUP_BYTES, type BackupFrame } from "./portable-backup-format.js";
import { activateBackupStorage, openBackupDatabase, pauseRestoredWork, resolveBackupStorage, restoreDirectory, restoreIdSchema } from "./portable-backup-storage.js";

const metadataSchema = z.object({ version: z.literal(1), schemaVersion: z.literal(SCHEMA_VERSION), createdAt: z.iso.datetime(), masterKey: z.string().regex(/^[\w-]{43}$/u) }).strict();
type Metadata = z.infer<typeof metadataSchema>;
export type RestorePreview = { id: string; createdAt: string; schemaVersion: number; counts: Record<string, number>; bytes: number; files: number };
const CHUNK_BYTES = 256 * 1024;
function safePath(value: unknown): value is string {
  return typeof value === "string" && (value === "database.sqlite" || /^outbound-attachments\/outbound-[a-f0-9-]{36}\.bin$/u.test(value)
    || (value.startsWith("backgrounds/") && customBackgroundPattern.test(value.slice(12))));
}
function restoreCounts(db: DatabaseHandle): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ["accounts", "messages", "contacts", "calendar_events", "filter_rules", "mail_templates", "agent_conversations"]) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) counts[table] = db.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get() as number;
  }
  return counts;
}
function verifyRestoredFiles(db: DatabaseHandle, key: Buffer, directory: string, files: Set<string>): void {
  const rows = db.prepare("SELECT token,account_id,storage_name FROM outbound_attachments").all() as Array<{ token: string; account_id: string; storage_name: string }>;
  for (const row of rows) {
    if (!files.has(`outbound-attachments/${row.storage_name}`)) throw new BackupError("Backup is missing a referenced attachment.");
    resolveOutboundAttachments(db, path.join(directory, "outbound-attachments"), key, row.account_id, [row.token]);
  }
  const background = db.prepare("SELECT custom_background_filename AS name FROM app_settings WHERE id=1").get() as { name: string | null } | undefined;
  if (background?.name) {
    if (!files.has(`backgrounds/${background.name}`) || !openCustomBackground(key, background.name, fs.readFileSync(path.join(directory, "backgrounds", background.name)))) throw new BackupError("Backup is missing a valid custom background.");
  }
  for (const row of db.prepare("SELECT * FROM messages").iterate() as Iterable<MessageStorageRow>) messagePayloadForRow(row, key);
}
export class PortableBackupService {
  private busy = false;
  constructor(private readonly options: { db: DatabaseHandle; masterKey: Buffer; hostKey: Buffer; originalDatabasePath: string; backgroundDirectory: string; outboundDirectory: string }) {}

  async *export(password: string): AsyncGenerator<Buffer> {
    if (this.busy) throw new BackupError("Another backup operation is running.");
    this.busy = true;
    const temporary = path.join(path.dirname(this.options.originalDatabasePath), `.backup-${randomUUID()}`);
    try {
      await fsp.mkdir(temporary, { recursive: true, mode: 0o700 });
      const databasePath = path.join(temporary, "database.sqlite");
      // SQLite3MultipleCiphers propagates the file codec to VACUUM INTO.
      // Its backup() API opens an unkeyed destination and refuses encrypted sources.
      this.options.db.prepare("VACUUM INTO ?").run(databasePath);
      const snapshot = openBackupDatabase(databasePath, this.options.masterKey);
      const files = [{ source: databasePath, name: "database.sqlite" }];
      try {
        const rows = snapshot.prepare("SELECT storage_name FROM outbound_attachments").all() as Array<{ storage_name: string }>;
        for (const row of rows) files.push({ source: path.join(this.options.outboundDirectory, row.storage_name), name: `outbound-attachments/${row.storage_name}` });
        const background = snapshot.prepare("SELECT custom_background_filename AS name FROM app_settings WHERE id=1").get() as { name: string | null } | undefined;
        if (background?.name) files.push({ source: path.join(this.options.backgroundDirectory, background.name), name: `backgrounds/${background.name}` });
      } finally { snapshot.close(); }
      if (files.length > 20_000) throw new BackupError("Backup exceeds the 20,000-file limit.");
      const metadata: Metadata = { version: 1, schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString(), masterKey: this.options.masterKey.toString("base64url") };
      async function* frames(): AsyncGenerator<BackupFrame> {
        yield { type: "metadata", value: metadata };
        for (const file of files) {
          if (!safePath(file.name)) throw new BackupError("Backup contains an invalid stored file name.");
          const stat = await fsp.lstat(file.source);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new BackupError("A referenced backup file is unavailable.");
          yield { type: "file", path: file.name, size: stat.size };
          let bytes = 0;
          for await (const chunk of fs.createReadStream(file.source, { highWaterMark: CHUNK_BYTES })) {
            bytes += chunk.length;
            yield { type: "chunk", data: (chunk as Buffer).toString("base64") };
          }
          if (bytes !== stat.size) throw new BackupError("A file changed while creating the backup. Retry after mail operations finish.");
          yield { type: "file-end" };
        }
        yield { type: "end" };
      }
      yield* encodeBackup(frames(), password);
    } finally { this.busy = false; await fsp.rm(temporary, { recursive: true, force: true }); }
  }

  async preview(source: AsyncIterable<Buffer>, password: string): Promise<RestorePreview> {
    if (this.busy) throw new BackupError("Another backup operation is running.");
    this.busy = true;
    const id = randomUUID();
    const directory = restoreDirectory(this.options.originalDatabasePath, id);
    let metadata: Metadata | undefined;
    let current: { file: fsp.FileHandle; size: number; written: number } | undefined;
    let bytes = 0;
    const seen = new Set<string>();
    let complete = false;
    try {
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      for await (const frame of decodeBackup(source, password)) {
        if (!metadata) {
          if (frame.type !== "metadata") throw new BackupError("Backup metadata must be first.");
          metadata = metadataSchema.parse(frame.value); continue;
        }
        if (frame.type === "file") {
          if (current || !safePath(frame.path) || seen.has(frame.path) || seen.size >= 20_000
            || !Number.isSafeInteger(frame.size) || frame.size < 0 || frame.size > MAX_BACKUP_BYTES) throw new BackupError("Invalid backup file entry.");
          seen.add(frame.path);
          const target = path.join(directory, frame.path);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          current = { file: await fsp.open(target, "wx", 0o600), size: frame.size, written: 0 };
        } else if (frame.type === "chunk") {
          if (!current || typeof frame.data !== "string" || frame.data.length > CHUNK_BYTES * 2 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data)) throw new BackupError("Invalid backup file data.");
          const data = Buffer.from(frame.data, "base64");
          current.written += data.length; bytes += data.length;
          if (current.written > current.size || bytes > MAX_BACKUP_BYTES) throw new BackupError("Backup exceeds its declared size.");
          await current.file.writeFile(data);
        } else if (frame.type === "file-end") {
          if (!current || current.written !== current.size) throw new BackupError("Incomplete backup file.");
          await current.file.sync(); await current.file.close(); current = undefined;
        } else if (frame.type !== "end" || current) throw new BackupError("Invalid backup sequence.");
      }
      if (!metadata || !seen.has("database.sqlite") || current) throw new BackupError("Backup has no complete database.");
      const key = Buffer.from(metadata.masterKey, "base64url");
      let counts: Record<string, number>;
      try {
        const db = openBackupDatabase(path.join(directory, "database.sqlite"), key, false);
        try { verifyRestoredFiles(db, key, directory, seen); counts = restoreCounts(db); pauseRestoredWork(db, key); }
        finally { db.close(); }
        const preview = { id, createdAt: metadata.createdAt, schemaVersion: metadata.schemaVersion, counts, bytes, files: seen.size };
        const sealed = encryptTextEnvelope(JSON.stringify({ metadata, preview }), this.options.hostKey, `restore-preview:${id}`);
        await fsp.writeFile(path.join(directory, "preview.enc"), sealed, { mode: 0o600 });
        complete = true;
        return preview;
      } finally { key.fill(0); }
    } finally {
      await current?.file.close();
      if (!complete) await fsp.rm(directory, { recursive: true, force: true });
      this.busy = false;
    }
  }

  activate(id: string): void {
    const directory = restoreDirectory(this.options.originalDatabasePath, restoreIdSchema.parse(id));
    const data = JSON.parse(decryptTextEnvelope(fs.readFileSync(path.join(directory, "preview.enc"), "utf8"), this.options.hostKey, `restore-preview:${id}`)) as { metadata: Metadata };
    const metadata = metadataSchema.parse(data.metadata);
    const key = Buffer.from(metadata.masterKey, "base64url");
    try {
      const db = openBackupDatabase(path.join(directory, "database.sqlite"), key); db.close();
      activateBackupStorage(this.options.originalDatabasePath, this.options.hostKey, id, key);
    } finally { key.fill(0); }
  }
  async discard(id: string): Promise<void> {
    const directory = restoreDirectory(this.options.originalDatabasePath, id);
    const active = resolveBackupStorage(this.options.originalDatabasePath, this.options.hostKey);
    try {
      if (path.dirname(active.databasePath) === directory) throw new BackupError("An activated restore cannot be discarded.");
      await fsp.rm(directory, { recursive: true, force: true });
    } finally { active.masterKey.fill(0); }
  }
}
