import type { Readable } from "node:stream";
import type { MessageStructureObject } from "imapflow";
import type { Attachment } from "mailparser";
import type { DatabaseHandle } from "./db.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { messagePayloadForRow, type MessageStorageRow } from "./message-storage.js";
import type { AccountRecord } from "./types.js";

const attachmentPartIdPattern = /^(?:[1-9]\d*)(?:\.[1-9]\d*)*$/;
const maxAttachmentPartIdLength = 128;
const safeMimeTypePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const reservedWindowsFilenamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type MessageAttachmentMetadata = {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  related: boolean;
  disposition: "attachment" | "inline";
};

export type MessageAttachmentDownload = {
  attachment: MessageAttachmentMetadata;
  content: Readable;
};

type MailParserAttachment = Attachment & { partId?: unknown };

function accountById(db: DatabaseHandle, id: string): AccountRecord | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord | undefined;
}

export function isValidAttachmentPartId(value: unknown): value is string {
  return typeof value === "string" && value.length <= maxAttachmentPartIdLength && attachmentPartIdPattern.test(value);
}

export function sanitizeAttachmentFilename(value: unknown, index = 0): string {
  const fallback = `attachment-${index + 1}`;
  if (typeof value !== "string") return fallback;
  const sanitized = value
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  const filename = Array.from(sanitized).slice(0, 180).join("");
  return filename && !reservedWindowsFilenamePattern.test(filename) ? filename : fallback;
}

export function sanitizeAttachmentContentType(value: unknown): string {
  if (typeof value !== "string") return "application/octet-stream";
  const contentType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return safeMimeTypePattern.test(contentType) ? contentType : "application/octet-stream";
}

function safeSize(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeDisposition(value: unknown, related: boolean): "attachment" | "inline" {
  return related || (typeof value === "string" && value.toLowerCase() === "inline") ? "inline" : "attachment";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStoredAttachment(value: unknown, index: number): MessageAttachmentMetadata | undefined {
  if (!isRecord(value) || !isValidAttachmentPartId(value.partId)) return undefined;
  const related = value.related === true;
  return {
    partId: value.partId,
    filename: sanitizeAttachmentFilename(value.filename, index),
    contentType: sanitizeAttachmentContentType(value.contentType),
    size: safeSize(value.size),
    related,
    disposition: safeDisposition(value.disposition, related),
  };
}

export function parseAttachmentMetadata(value: unknown): MessageAttachmentMetadata[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const seenPartIds = new Set<string>();
    return parsed.flatMap((entry, index) => {
      const attachment = normalizeStoredAttachment(entry, index);
      if (!attachment || seenPartIds.has(attachment.partId)) return [];
      seenPartIds.add(attachment.partId);
      return [attachment];
    });
  } catch {
    return [];
  }
}

export function attachmentMetadataFromParsedMail(attachments: readonly Attachment[]): MessageAttachmentMetadata[] {
  const seenPartIds = new Set<string>();
  return attachments.flatMap((attachment, index) => {
    const parsedAttachment = attachment as MailParserAttachment;
    if (!isValidAttachmentPartId(parsedAttachment.partId) || seenPartIds.has(parsedAttachment.partId)) return [];
    seenPartIds.add(parsedAttachment.partId);
    const related = parsedAttachment.related === true;
    return [{
      partId: parsedAttachment.partId,
      filename: sanitizeAttachmentFilename(parsedAttachment.filename, index),
      contentType: sanitizeAttachmentContentType(parsedAttachment.contentType),
      size: safeSize(parsedAttachment.size),
      related,
      disposition: safeDisposition(parsedAttachment.contentDisposition, related),
    }];
  });
}

function findBodyPart(node: MessageStructureObject | undefined, partId: string): MessageStructureObject | undefined {
  if (!node) return undefined;
  if (node.part === partId) return node;
  for (const child of node.childNodes ?? []) {
    const matched = findBodyPart(child, partId);
    if (matched) return matched;
  }
  return undefined;
}

function isDownloadableBodyPart(part: MessageStructureObject): boolean {
  if (part.childNodes?.length) return false;
  const disposition = part.disposition?.toLowerCase();
  const filename = part.dispositionParameters?.filename ?? part.parameters?.filename ?? part.parameters?.name;
  if (disposition === "attachment" || disposition === "inline" || Boolean(filename)) return true;
  return !sanitizeAttachmentContentType(part.type).startsWith("text/");
}

function isReadable(value: unknown): value is Readable {
  return typeof value === "object" && value !== null && typeof (value as { on?: unknown }).on === "function";
}

export async function downloadMessageAttachment(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  partId: string,
  accessTokenProvider?: AccountAccessTokenProvider,
): Promise<MessageAttachmentDownload> {
  if (!isValidAttachmentPartId(partId)) throw new Error("Attachment part is invalid.");

  const message = db.prepare(`
    SELECT * FROM messages WHERE id = ?
  `).get(messageId) as MessageStorageRow | undefined;
  if (!message) throw new Error("Message not found.");
  const attachment = (messagePayloadForRow(message, masterKey).attachments ?? []).find((item) => item.partId === partId);
  if (!attachment) throw new Error("Attachment not found. Sync this message again.");

  const account = accountById(db, message.account_id);
  if (!account) throw new Error("Account not found.");

  const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
  let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
  let streamHandedOff = false;
  try {
    await client.connect();
    lock = await client.getMailboxLock(message.mailbox);
    const remoteMessage = await client.fetchOne(message.uid, { uid: true, bodyStructure: true }, { uid: true });
    const remotePart = remoteMessage && remoteMessage.uid === message.uid ? findBodyPart(remoteMessage.bodyStructure, partId) : undefined;
    if (!remotePart || !isDownloadableBodyPart(remotePart)) {
      throw new Error("Attachment is no longer available in this mailbox. Sync this message again.");
    }

    const download = await client.download(message.uid, attachment.partId, { uid: true });
    if (!isReadable(download.content)) throw new Error("Attachment download did not return a readable stream.");

    let resourcesReleased = false;
    const releaseResources = () => {
      if (resourcesReleased) return;
      resourcesReleased = true;
      try {
        lock?.release();
      } catch {
        // The download stream has already completed or failed. Cleanup errors
        // must not replace the actual transfer outcome.
      }
      if (client.usable) void client.logout().catch(() => undefined);
    };
    download.content.once("end", releaseResources);
    download.content.once("error", releaseResources);
    download.content.once("close", releaseResources);
    streamHandedOff = true;
    return { attachment, content: download.content };
  } finally {
    if (!streamHandedOff) {
      try {
        lock?.release();
      } catch {
        // Preserve the connection or IMAP error that caused the download to fail.
      }
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }
}
