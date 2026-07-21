import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeAttachmentContentType, sanitizeAttachmentFilename } from "./attachments.js";
import { config } from "./config.js";
import {
  decryptBufferEnvelope,
  decryptTextEnvelope,
  deriveEncryptionKey,
  encryptBufferEnvelope,
  encryptedBufferEnvelopeOverhead,
  encryptTextEnvelope,
  isEncryptedBufferEnvelope,
} from "./crypto.js";
import type { DatabaseHandle } from "./db.js";
import type { RuntimeContext } from "./types.js";

export const MAX_OUTBOUND_ATTACHMENT_COUNT = 10;
export const MAX_OUTBOUND_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_OUTBOUND_ATTACHMENTS_BYTES = 25 * 1024 * 1024;
export const OUTBOUND_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

const tokenPattern = /^out_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const storageNamePattern = /^outbound-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/;
const temporaryStorageNamePattern = /^outbound-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin\.tmp$/;
const backupStorageNamePattern = /^outbound-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin\.migration-backup$/;
const dangerousExtensionPattern = /\.(?:ade|adp|appx|appxbundle|bat|cab|cmd|com|cpl|dll|exe|gadget|hta|inf|ins|iso|jar|js|jse|lib|lnk|mde|msc|msi|msix|msixbundle|msp|mst|nsh|pif|ps1|reg|scr|sct|sys|url|vb|vbe|vbs|vxd|wsc|wsf|wsh)$/i;
const dangerousContentTypes = new Set([
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/vnd.microsoft.portable-executable",
  "application/vnd.ms-cab-compressed",
  "application/x-bat",
  "application/x-dosexec",
  "application/x-executable",
  "application/x-msdownload",
  "application/x-ms-installer",
  "application/x-msi",
  "application/x-sh",
  "application/x-iso9660-image",
  "application/x-windows-installer",
  "text/javascript",
  "text/vbscript",
]);

type StoredOutboundAttachment = {
  token: string;
  account_id: string;
  filename: string;
  content_type: string;
  size: number;
  storage_name: string;
  encrypted_metadata: string | null;
  crypto_version: number;
  created_at: string;
};

export type OutboundAttachment = {
  token: string;
  filename: string;
  contentType: string;
  size: number;
};

export type ResolvedOutboundAttachment = OutboundAttachment & {
  content: Buffer;
};

export class OutboundAttachmentError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "OutboundAttachmentError";
  }
}

type OutboundAttachmentMetadata = { filename: string; contentType: string };

function attachmentAad(row: Pick<StoredOutboundAttachment, "token" | "account_id">, domain: "file" | "metadata"): string {
  return `outbound-attachment\0${row.account_id}\0${row.token}\0${domain}-v1`;
}

function withAttachmentKey<T>(masterKey: Buffer, purpose: "file" | "metadata", callback: (key: Buffer) => T): T {
  const key = deriveEncryptionKey(masterKey, `outbound-attachment-${purpose}-v1`);
  try {
    return callback(key);
  } finally {
    key.fill(0);
  }
}

function attachmentMetadata(row: StoredOutboundAttachment, masterKey: Buffer): OutboundAttachmentMetadata {
  if (!row.encrypted_metadata) return { filename: row.filename, contentType: row.content_type };
  return withAttachmentKey(masterKey, "metadata", (key) => {
    const plaintext = decryptTextEnvelope(row.encrypted_metadata as string, key, attachmentAad(row, "metadata"));
    const parsed = JSON.parse(plaintext) as Partial<OutboundAttachmentMetadata>;
    if (typeof parsed.filename !== "string" || typeof parsed.contentType !== "string") {
      throw new Error("Encrypted attachment metadata is invalid.");
    }
    return { filename: parsed.filename, contentType: parsed.contentType };
  });
}

function encryptAttachmentMetadata(row: StoredOutboundAttachment, masterKey: Buffer, metadata: OutboundAttachmentMetadata): string {
  return withAttachmentKey(masterKey, "metadata", (key) =>
    encryptTextEnvelope(JSON.stringify(metadata), key, attachmentAad(row, "metadata")));
}

function publicAttachment(row: StoredOutboundAttachment, masterKey: Buffer): OutboundAttachment {
  const metadata = attachmentMetadata(row, masterKey);
  return {
    token: row.token,
    filename: metadata.filename,
    contentType: metadata.contentType,
    size: row.size,
  };
}

function storagePath(directory: string, storageName: string): string {
  if (!storageNamePattern.test(storageName)) throw new OutboundAttachmentError("附件存储记录无效。", 409);
  const root = path.resolve(directory);
  const candidate = path.resolve(root, storageName);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OutboundAttachmentError("附件存储记录无效。", 409);
  }
  return candidate;
}

function ensureStorageDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function accountExists(db: DatabaseHandle, accountId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(accountId));
}

function sanitizeUploadFilename(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 768) {
    throw new OutboundAttachmentError("附件文件名无效。", 400);
  }
  const filename = sanitizeAttachmentFilename(value, 0);
  if (dangerousExtensionPattern.test(filename)) {
    throw new OutboundAttachmentError("不允许添加可执行或脚本文件。", 400);
  }
  return filename;
}

function sanitizeUploadContentType(value: unknown): string {
  if (typeof value !== "string" || value.length > 255) {
    throw new OutboundAttachmentError("附件类型无效。", 400);
  }
  const contentType = sanitizeAttachmentContentType(value);
  if (dangerousContentTypes.has(contentType)) {
    throw new OutboundAttachmentError("不允许添加可执行或脚本文件。", 400);
  }
  return contentType;
}

function assertUploadContent(content: unknown): asserts content is Buffer {
  if (!Buffer.isBuffer(content) || !content.length) {
    throw new OutboundAttachmentError("附件内容不能为空。", 400);
  }
  if (content.length > MAX_OUTBOUND_ATTACHMENT_BYTES) {
    throw new OutboundAttachmentError("单个附件不能超过 10 MB。", 413);
  }
}

export function validateOutboundAttachmentTokens(tokens: readonly string[]): void {
  if (tokens.length > MAX_OUTBOUND_ATTACHMENT_COUNT) {
    throw new OutboundAttachmentError(`每封邮件最多添加 ${MAX_OUTBOUND_ATTACHMENT_COUNT} 个附件。`, 400);
  }
  const uniqueTokens = new Set<string>();
  for (const token of tokens) {
    if (!tokenPattern.test(token)) throw new OutboundAttachmentError("附件令牌无效。", 400);
    if (uniqueTokens.has(token)) throw new OutboundAttachmentError("附件不能重复添加。", 400);
    uniqueTokens.add(token);
  }
}

function rowForToken(db: DatabaseHandle, token: string): StoredOutboundAttachment | undefined {
  return db.prepare(`
    SELECT token, account_id, filename, content_type, size, storage_name, encrypted_metadata, crypto_version, created_at
    FROM outbound_attachments WHERE token = ?
  `).get(token) as StoredOutboundAttachment | undefined;
}

function assertStoredFile(directory: string, row: StoredOutboundAttachment): string {
  const filePath = storagePath(directory, row.storage_name);
  const backupPath = `${filePath}.migration-backup`;
  if (!fs.existsSync(filePath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, filePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new OutboundAttachmentError("附件文件已不可用，请重新添加。", 409);
  }
  const validSize = stat.size === row.size || stat.size === row.size + encryptedBufferEnvelopeOverhead;
  if (!stat.isFile() || stat.isSymbolicLink() || !validSize) {
    throw new OutboundAttachmentError("附件文件已不可用，请重新添加。", 409);
  }
  return filePath;
}

function decryptAttachmentContent(row: StoredOutboundAttachment, payload: Buffer, masterKey: Buffer): Buffer {
  if (!isEncryptedBufferEnvelope(payload)) {
    if (row.crypto_version > 0 || payload.length !== row.size) throw new Error("Encrypted attachment content is invalid.");
    return payload;
  }
  const plaintext = withAttachmentKey(masterKey, "file", (key) =>
    decryptBufferEnvelope(payload, key, attachmentAad(row, "file")));
  if (plaintext.length !== row.size) throw new Error("Encrypted attachment size does not match its record.");
  return plaintext;
}

function encryptAttachmentContent(row: StoredOutboundAttachment, plaintext: Buffer, masterKey: Buffer): Buffer {
  return withAttachmentKey(masterKey, "file", (key) =>
    encryptBufferEnvelope(plaintext, key, attachmentAad(row, "file")));
}

function writeFileAtomically(filePath: string, payload: Buffer): void {
  const temporary = `${filePath}.tmp`;
  const backup = `${filePath}.migration-backup`;
  fs.rmSync(temporary, { force: true });
  if (fs.existsSync(backup)) {
    if (!fs.existsSync(filePath)) fs.renameSync(backup, filePath);
    else fs.rmSync(backup, { force: true });
  }
  try {
    fs.writeFileSync(temporary, payload, { flag: "wx", mode: 0o600 });
    // Windows requires a writable handle for FlushFileBuffers, which backs
    // Node's fsync implementation even though the payload is already written.
    const handle = fs.openSync(temporary, "r+");
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(filePath, backup);
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (!fs.existsSync(filePath) && fs.existsSync(backup)) fs.renameSync(backup, filePath);
      throw error;
    }
    fs.rmSync(backup, { force: true });
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function storedAttachmentContent(row: StoredOutboundAttachment, directory: string, masterKey: Buffer): Buffer {
  const filePath = assertStoredFile(directory, row);
  return decryptAttachmentContent(row, fs.readFileSync(filePath), masterKey);
}

function migrateStoredAttachment(db: DatabaseHandle, directory: string, row: StoredOutboundAttachment, masterKey: Buffer): boolean {
  let filePath: string;
  let encryptedMetadata: string;
  let changed = false;
  try {
    filePath = assertStoredFile(directory, row);
    const persisted = fs.readFileSync(filePath);
    const plaintext = decryptAttachmentContent(row, persisted, masterKey);
    if (!isEncryptedBufferEnvelope(persisted)) {
      const encrypted = encryptAttachmentContent(row, plaintext, masterKey);
      const verified = decryptAttachmentContent({ ...row, crypto_version: 1 }, encrypted, masterKey);
      if (!verified.equals(plaintext)) throw new Error("Encrypted attachment verification failed.");
      writeFileAtomically(filePath, encrypted);
      changed = true;
    } else {
      // A process can stop after installing the verified encrypted file but
      // before removing the migration backup. The current file is now the
      // authoritative copy, so the stale backup can be discarded.
      fs.rmSync(`${filePath}.migration-backup`, { force: true });
    }

    const metadata = attachmentMetadata(row, masterKey);
    encryptedMetadata = row.encrypted_metadata ?? encryptAttachmentMetadata(row, masterKey, metadata);
  } catch (error) {
    if (error instanceof OutboundAttachmentError) throw error;
    throw new OutboundAttachmentError("附件文件已不可用，请重新添加。", 409);
  }
  if (!row.encrypted_metadata || row.crypto_version !== 1 || row.filename || row.content_type !== "application/octet-stream") {
    db.prepare(`
      UPDATE outbound_attachments
      SET filename = '', content_type = 'application/octet-stream', encrypted_metadata = ?, crypto_version = 1
      WHERE token = ?
    `).run(encryptedMetadata, row.token);
    changed = true;
  }
  return changed;
}

/** Encrypts legacy outbound files and metadata before the local API starts. */
export function migrateOutboundAttachments(
  db: DatabaseHandle,
  directory: string,
  masterKey: Buffer,
): number {
  ensureStorageDirectory(directory);
  const rows = db.prepare(`
    SELECT token, account_id, filename, content_type, size, storage_name, encrypted_metadata, crypto_version, created_at
    FROM outbound_attachments ORDER BY created_at, token
  `).all() as StoredOutboundAttachment[];
  let migrated = 0;
  for (const row of rows) {
    try {
      if (migrateStoredAttachment(db, directory, row, masterKey)) migrated += 1;
    } catch (error) {
      // A single stale or damaged upload must not prevent mail, account
      // recovery, or settings from starting. Keep its row so the send path can
      // return the existing actionable "re-add attachment" error.
      if (!(error instanceof OutboundAttachmentError)) throw error;
    }
  }
  return migrated;
}

function removeFile(directory: string, storageName: string): void {
  try {
    fs.rmSync(storagePath(directory, storageName), { force: true });
  } catch {
    // Database rows remain the source of truth. A later stale-file cleanup can
    // remove a file that could not be unlinked during an interrupted cleanup.
  }
}

function removeUnlinkedAttachments(db: DatabaseHandle, directory: string, tokens: readonly string[]): number {
  let removed = 0;
  for (const token of tokens) {
    const row = rowForToken(db, token);
    if (!row) continue;
    const linked = db.prepare(`
      SELECT 1 FROM outbound_attachment_drafts WHERE attachment_token = ?
      UNION ALL
      SELECT 1 FROM outbound_attachment_submissions WHERE attachment_token = ?
      LIMIT 1
    `).get(token, token);
    if (linked) continue;
    const result = db.prepare("DELETE FROM outbound_attachments WHERE token = ?").run(token);
    if (result.changes) {
      removeFile(directory, row.storage_name);
      removed += 1;
    }
  }
  return removed;
}

export function outboundAttachmentDirectory(context: Pick<RuntimeContext, "outboundAttachmentDirectory">): string {
  return context.outboundAttachmentDirectory ?? path.join(path.dirname(config.databasePath), "outbound-attachments");
}

export function createOutboundAttachment(
  db: DatabaseHandle,
  directory: string,
  masterKey: Buffer,
  input: { accountId: string; filename: unknown; contentType: unknown; content: unknown },
): OutboundAttachment {
  if (!accountExists(db, input.accountId)) throw new OutboundAttachmentError("发件邮箱不存在。", 404);
  assertUploadContent(input.content);
  const filename = sanitizeUploadFilename(input.filename);
  const contentType = sanitizeUploadContentType(input.contentType);
  ensureStorageDirectory(directory);

  const token = `out_${randomUUID()}`;
  const storageName = `outbound-${randomUUID()}.bin`;
  const destination = storagePath(directory, storageName);
  const temporary = `${destination}.tmp`;
  const row: StoredOutboundAttachment = {
    token,
    account_id: input.accountId,
    filename: "",
    content_type: "application/octet-stream",
    size: input.content.length,
    storage_name: storageName,
    encrypted_metadata: null,
    crypto_version: 1,
    created_at: new Date().toISOString(),
  };
  row.encrypted_metadata = encryptAttachmentMetadata(row, masterKey, { filename, contentType });
  const encryptedContent = encryptAttachmentContent(row, input.content, masterKey);
  try {
    fs.writeFileSync(temporary, encryptedContent, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
    db.prepare(`
      INSERT INTO outbound_attachments (
        token, account_id, filename, content_type, size, storage_name, encrypted_metadata, crypto_version, created_at
      ) VALUES (
        @token, @account_id, @filename, @content_type, @size, @storage_name, @encrypted_metadata, @crypto_version, @created_at
      )
    `).run(row);
    return publicAttachment(row, masterKey);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    fs.rmSync(destination, { force: true });
    throw error;
  }
}

/** Resolves opaque tokens into bounded in-memory attachment payloads for Nodemailer. */
export function resolveOutboundAttachments(
  db: DatabaseHandle,
  directory: string,
  masterKey: Buffer,
  accountId: string,
  tokens: readonly string[],
): ResolvedOutboundAttachment[] {
  validateOutboundAttachmentTokens(tokens);
  let totalBytes = 0;
  const attachments: ResolvedOutboundAttachment[] = [];
  for (const token of tokens) {
    const row = rowForToken(db, token);
    // Deliberately use the same response for absent tokens and tokens owned by
    // a different account. A renderer must never use a token as a file path.
    if (!row || row.account_id !== accountId) throw new OutboundAttachmentError("附件不存在或不属于当前发件邮箱。", 404);
    totalBytes += row.size;
    if (totalBytes > MAX_OUTBOUND_ATTACHMENTS_BYTES) {
      throw new OutboundAttachmentError("所有附件合计不能超过 25 MB。", 413);
    }
    attachments.push({ ...publicAttachment(row, masterKey), content: storedAttachmentContent(row, directory, masterKey) });
  }
  return attachments;
}

export function linkOutboundAttachmentsToDraft(
  db: DatabaseHandle,
  accountId: string,
  generatedMessageId: string,
  tokens: readonly string[],
): void {
  validateOutboundAttachmentTokens(tokens);
  if (!tokens.length) return;
  if (!generatedMessageId || generatedMessageId.length > 998 || /[\u0000-\u001F\u007F]/.test(generatedMessageId)) {
    throw new OutboundAttachmentError("草稿标识无效。", 409);
  }
  const attach = db.transaction(() => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO outbound_attachment_drafts (attachment_token, account_id, message_id, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const token of tokens) {
      const row = rowForToken(db, token);
      if (!row || row.account_id !== accountId) throw new OutboundAttachmentError("附件不存在或不属于当前发件邮箱。", 404);
      insert.run(token, accountId, generatedMessageId, new Date().toISOString());
    }
  });
  attach();
}

/** Holds uploaded files while a persisted SMTP submission is not yet terminal. */
export function linkOutboundAttachmentsToSubmission(
  db: DatabaseHandle,
  accountId: string,
  submissionId: string,
  tokens: readonly string[],
): void {
  validateOutboundAttachmentTokens(tokens);
  if (!tokens.length) return;
  const attach = db.transaction(() => {
    const submission = db.prepare(`
      SELECT 1 FROM outbound_submissions WHERE id = ? AND account_id = ?
    `).get(submissionId, accountId);
    if (!submission) throw new OutboundAttachmentError("Outbound submission is no longer available.", 409);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO outbound_attachment_submissions (attachment_token, account_id, submission_id, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const token of tokens) {
      const row = rowForToken(db, token);
      if (!row || row.account_id !== accountId) {
        throw new OutboundAttachmentError("Attachment does not belong to the selected account.", 404);
      }
      insert.run(token, accountId, submissionId, new Date().toISOString());
    }
  });
  attach();
}

/** Releases a successful submission's temporary files unless another draft or submission still owns them. */
export function releaseSubmissionOutboundAttachments(
  db: DatabaseHandle,
  directory: string,
  accountId: string,
  submissionId: string,
): number {
  const rows = db.prepare(`
    SELECT attachment_token FROM outbound_attachment_submissions
    WHERE account_id = ? AND submission_id = ?
  `).all(accountId, submissionId) as Array<{ attachment_token: string }>;
  const tokens = rows.map((row) => row.attachment_token);
  if (!tokens.length) return 0;
  db.prepare(`
    DELETE FROM outbound_attachment_submissions WHERE account_id = ? AND submission_id = ?
  `).run(accountId, submissionId);
  return removeUnlinkedAttachments(db, directory, tokens);
}

export function listDraftOutboundAttachments(
  db: DatabaseHandle,
  directory: string,
  masterKey: Buffer,
  accountId: string,
  generatedMessageId: string | null | undefined,
): OutboundAttachment[] {
  if (!generatedMessageId) return [];
  const rows = db.prepare(`
    SELECT oa.token, oa.account_id, oa.filename, oa.content_type, oa.size, oa.storage_name,
           oa.encrypted_metadata, oa.crypto_version, oa.created_at
    FROM outbound_attachments oa
    JOIN outbound_attachment_drafts od ON od.attachment_token = oa.token
    WHERE od.account_id = ? AND od.message_id = ? AND oa.account_id = ?
    ORDER BY oa.created_at, oa.token
  `).all(accountId, generatedMessageId, accountId) as StoredOutboundAttachment[];
  const brokenTokens: string[] = [];
  const usable = rows.flatMap((row) => {
    try {
      assertStoredFile(directory, row);
      storedAttachmentContent(row, directory, masterKey);
      return [publicAttachment(row, masterKey)];
    } catch {
      brokenTokens.push(row.token);
      return [];
    }
  });
  if (brokenTokens.length) {
    db.transaction(() => {
      for (const token of brokenTokens) db.prepare("DELETE FROM outbound_attachments WHERE token = ?").run(token);
    })();
  }
  return usable;
}

export function discardPendingOutboundAttachments(
  db: DatabaseHandle,
  directory: string,
  accountId: string,
  tokens: readonly string[],
): number {
  validateOutboundAttachmentTokens(tokens);
  for (const token of tokens) {
    const row = rowForToken(db, token);
    if (!row || row.account_id !== accountId) throw new OutboundAttachmentError("附件不存在或不属于当前发件邮箱。", 404);
  }
  return removeUnlinkedAttachments(db, directory, tokens);
}

export function discardDraftOutboundAttachments(
  db: DatabaseHandle,
  directory: string,
  accountId: string,
  generatedMessageId: string | null | undefined,
): number {
  if (!generatedMessageId) return 0;
  const rows = db.prepare(`
    SELECT attachment_token FROM outbound_attachment_drafts WHERE account_id = ? AND message_id = ?
  `).all(accountId, generatedMessageId) as Array<{ attachment_token: string }>;
  const tokens = rows.map((row) => row.attachment_token);
  if (!tokens.length) return 0;
  db.transaction(() => {
    db.prepare("DELETE FROM outbound_attachment_drafts WHERE account_id = ? AND message_id = ?").run(accountId, generatedMessageId);
  })();
  return removeUnlinkedAttachments(db, directory, tokens);
}

export function discardOutboundAttachmentsForAccount(db: DatabaseHandle, directory: string, accountId: string): number {
  const rows = db.prepare(`
    SELECT token, account_id, filename, content_type, size, storage_name, encrypted_metadata, crypto_version, created_at
    FROM outbound_attachments WHERE account_id = ?
  `).all(accountId) as StoredOutboundAttachment[];
  if (!rows.length) return 0;
  db.transaction(() => {
    db.prepare("DELETE FROM outbound_attachments WHERE account_id = ?").run(accountId);
  })();
  for (const row of rows) removeFile(directory, row.storage_name);
  return rows.length;
}

/** Removes abandoned, unlinked uploads and any unreferenced runtime files. */
export function cleanupExpiredOutboundAttachments(
  db: DatabaseHandle,
  directory: string,
  now = new Date(),
): number {
  ensureStorageDirectory(directory);
  const cutoff = new Date(now.getTime() - OUTBOUND_ATTACHMENT_TTL_MS).toISOString();
  const stale = db.prepare(`
    SELECT oa.token
    FROM outbound_attachments oa
    WHERE oa.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM outbound_attachment_drafts od WHERE od.attachment_token = oa.token)
      AND NOT EXISTS (SELECT 1 FROM outbound_attachment_submissions os WHERE os.attachment_token = oa.token)
  `).all(cutoff) as Array<{ token: string }>;
  const removed = removeUnlinkedAttachments(db, directory, stale.map((row) => row.token));

  const referenced = new Set(
    (db.prepare("SELECT storage_name FROM outbound_attachments").all() as Array<{ storage_name: string }>)
      .map((row) => row.storage_name),
  );
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (temporaryStorageNamePattern.test(entry.name) || backupStorageNamePattern.test(entry.name)) {
      fs.rmSync(path.join(directory, entry.name), { force: true });
      continue;
    }
    if (storageNamePattern.test(entry.name) && !referenced.has(entry.name)) {
      fs.rmSync(storagePath(directory, entry.name), { force: true });
    }
  }
  return removed;
}
