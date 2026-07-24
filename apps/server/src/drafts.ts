import nodemailer from "nodemailer";
import type { DatabaseHandle } from "./db.js";
import { friendlyMailError, imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { moveActionBlockedError } from "./message-storage.js";
import type { ResolvedOutboundAttachment } from "./outbound-attachments.js";
import type { AccountRecord } from "./types.js";

export type DraftMessage = {
  to: string[];
  cc?: string[];
  inReplyTo?: string;
  references?: string[];
  subject: string;
  text: string;
  attachments?: readonly Pick<ResolvedOutboundAttachment, "filename" | "contentType" | "content">[];
};

export type DraftSaveResult = {
  destination: string;
  messageId: string;
  /** The IMAP server completed APPEND for this RFC 822 draft. */
  serverConfirmed: true;
  replaceWarning?: string;
};

type StoredDraft = {
  account_id: string;
  mailbox: string;
  uid: number;
  special_use: string | null;
  pending_move_destination: string | null;
  pending_move_state: string | null;
};

function safeDraftReplacementWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const knownSafeMessages = new Set([
    "Draft not found.",
    "Message is not a draft.",
    "邮件服务器未确认草稿删除，请稍后重试。",
  ]);
  return knownSafeMessages.has(message) ? message : friendlyMailError(error);
}

function draftMailbox(db: DatabaseHandle, accountId: string): string | undefined {
  return (db.prepare(`
    SELECT path FROM folders
    WHERE account_id = ? AND special_use = '\\Drafts'
    ORDER BY path
    LIMIT 1
  `).get(accountId) as { path: string } | undefined)?.path;
}

/**
 * Writes a standards-compliant RFC 822 message to the provider's real Drafts
 * mailbox. The message body never passes through the SMTP transport.
 */
export async function saveDraft(
  db: DatabaseHandle,
  masterKey: Buffer,
  account: AccountRecord,
  draft: DraftMessage,
  options: { replaceDraftId?: string } = {},
  accessTokenProvider?: AccountAccessTokenProvider,
): Promise<DraftSaveResult> {
  const destination = draftMailbox(db, account.id);
  if (!destination) throw new Error("这个邮箱没有提供可用的草稿文件夹。");

  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
  });
  const generated = await transport.sendMail({
    from: account.email,
    to: draft.to.length ? draft.to : undefined,
    cc: draft.cc?.length ? draft.cc : undefined,
    inReplyTo: draft.inReplyTo,
    references: draft.references?.length ? draft.references : undefined,
    subject: draft.subject,
    text: draft.text,
    attachments: draft.attachments?.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: attachment.content,
      contentDisposition: "attachment",
    })),
    headers: { "X-Nami-Mail-Draft": "1" },
  });
  if (!Buffer.isBuffer(generated.message)) throw new Error("无法生成草稿内容，请重试。");

  const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
  try {
    await client.connect();
    // An IMAP tagged OK response to APPEND is the server-side persistence
    // acknowledgement. Do not create a local-only success path for drafts.
    const appended = await client.append(destination, generated.message, ["\\Draft"]);
    if (!appended) throw new Error("邮件服务器未确认草稿保存，请稍后重试。");
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }

  let replaceWarning: string | undefined;
  if (options.replaceDraftId) {
    try {
      await discardDraft(db, masterKey, account, options.replaceDraftId, accessTokenProvider);
    } catch (error) {
      replaceWarning = safeDraftReplacementWarning(error);
    }
  }
  return {
    destination,
    messageId: generated.messageId,
    serverConfirmed: true,
    ...(replaceWarning ? { replaceWarning } : {}),
  };
}

/** Removes a server-side draft only after the caller has completed its replacement or send action. */
export async function discardDraft(
  db: DatabaseHandle,
  masterKey: Buffer,
  account: AccountRecord,
  messageId: string,
  accessTokenProvider?: AccountAccessTokenProvider,
): Promise<void> {
  const stored = db.prepare(`
    SELECT m.account_id, m.mailbox, m.uid, m.pending_move_destination, m.pending_move_state, f.special_use
    FROM messages m
    LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.mailbox
    WHERE m.id = ?
  `).get(messageId) as StoredDraft | undefined;
  if (!stored) throw new Error("Draft not found.");
  const moveBlockedError = moveActionBlockedError(stored);
  if (moveBlockedError) throw new Error(moveBlockedError);
  if (stored.account_id !== account.id || stored.special_use !== "\\Drafts") {
    throw new Error("Message is not a draft.");
  }

  const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(stored.mailbox);
    try {
      const deleted = await client.messageDelete(stored.uid, { uid: true });
      if (!deleted) throw new Error("邮件服务器未确认草稿删除，请稍后重试。");
    } finally {
      lock.release();
    }
    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
}
