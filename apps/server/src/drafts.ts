import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import type { DatabaseHandle } from "./db.js";
import { friendlyMailError, imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { moveActionBlockedError, protectedMessageColumns } from "./message-storage.js";
import { indexMessageFts } from "./message-search.js";
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
  /** Stable local `messages.id` for later draft update and deletion actions. */
  id: string;
  destination: string;
  /** RFC 822 Message-ID used for threading and outbound attachment ownership. */
  messageId: string;
  /** The IMAP server completed APPEND for this RFC 822 draft. */
  serverConfirmed: true;
  replaceWarning?: string;
};

type DraftOperationAbortCode = "draft_operation_cancelled" | "draft_operation_outcome_unknown";

function draftOperationAbortError(code: DraftOperationAbortCode): Error & { code: DraftOperationAbortCode } {
  const message = code === "draft_operation_outcome_unknown"
    ? "The draft operation may already have reached the mail server. Check Drafts before retrying."
    : "The draft operation was cancelled before the mail server operation started.";
  return Object.assign(new Error(message), { code });
}

function throwIfDraftOperationCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw draftOperationAbortError("draft_operation_cancelled");
}

/**
 * IMAP APPEND and STORE/EXPUNGE style operations do not expose an abortable
 * protocol primitive. Closing the connection stops local waiting, but when a
 * write is already in flight its server-side result must be treated as
 * unknown rather than reported as a successful cancellation.
 */
function closeClientOnAbort(
  client: { close(): void },
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) return () => undefined;
  const close = () => {
    onAbort();
    try {
      client.close();
    } catch {
      // A best-effort close must not turn an AbortSignal dispatch into an
      // unhandled exception.
    }
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  return () => signal.removeEventListener("abort", close);
}

type StoredDraft = {
  account_id: string;
  mailbox: string;
  uid: number;
  special_use: string | null;
  pending_move_destination: string | null;
  pending_move_state: string | null;
  remote_id_lookup: string | null;
  flags_json: string;
  all_mail_archived: number | null;
};

type DraftImapClient = Awaited<ReturnType<typeof imapClientForAccount>>;

function stableMessageId(accountId: string, mailbox: string, uid: number): string {
  // This is the same durable identity derivation used by normal IMAP sync.
  return createHash("sha256").update(`${accountId}\0${mailbox}\0${uid}`).digest("hex").slice(0, 32);
}

function validUid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function storedDraftForAccount(db: DatabaseHandle, account: AccountRecord, messageId: string): StoredDraft {
  const stored = db.prepare(`
    SELECT
      m.account_id, m.mailbox, m.uid, m.pending_move_destination, m.pending_move_state,
      m.remote_id_lookup, m.flags_json, m.all_mail_archived, f.special_use
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
  return stored;
}

/**
 * UIDPLUS gives APPENDUID directly. When it is unavailable, lock Drafts and
 * verify the exact generated Message-ID before using a search result as an
 * addressable UID. A partial header match must never select another draft.
 */
async function appendedDraftUid(
  client: DraftImapClient,
  destination: string,
  messageId: string,
  appended: { uid?: number },
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (validUid(appended.uid)) return appended.uid;

  throwIfDraftOperationCancelled(signal);
  const lock = await client.getMailboxLock(destination);
  try {
    throwIfDraftOperationCancelled(signal);
    const matches = await client.search({ header: { "Message-ID": messageId } }, { uid: true });
    if (!matches) return undefined;
    for (const uid of matches.slice(-20).reverse()) {
      if (!validUid(uid)) continue;
      throwIfDraftOperationCancelled(signal);
      const candidate = await client.fetchOne(uid, { envelope: true }, { uid: true });
      if (candidate && candidate.envelope?.messageId === messageId) return uid;
    }
    return undefined;
  } finally {
    lock.release();
  }
}

function persistAppendedDraft(
  db: DatabaseHandle,
  masterKey: Buffer,
  account: AccountRecord,
  destination: string,
  uid: number,
  draft: DraftMessage,
  messageId: string,
  rawSize: number,
  agentEvents?: AgentMailEventSink,
): string {
  const id = stableMessageId(account.id, destination, uid);
  const now = new Date().toISOString();
  const protectedColumns = protectedMessageColumns(masterKey, id, account.id, {
    messageId,
    subject: draft.subject,
    fromName: "",
    fromAddress: account.email,
    to: draft.to.map((address) => ({ name: "", address })),
    cc: draft.cc?.map((address) => ({ name: "", address })) ?? [],
    inReplyTo: draft.inReplyTo ?? null,
    references: draft.references ? [...draft.references] : [],
    snippet: draft.text.replace(/\s+/g, " ").trim().slice(0, 220),
    textBody: draft.text,
    htmlBody: "",
    // IMAP APPEND does not expose assigned MIME part identifiers. NULL asks a
    // later sync to hydrate attachment metadata instead of inventing it.
    attachments: null,
  });
  const existing = db.prepare(`
    SELECT id FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?
  `);
  const insert = db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid,
      message_id, subject, from_name, from_address, to_json, cc_json, in_reply_to, references_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, attachments_json,
      encrypted_payload, payload_version, size, created_at
    ) VALUES (
      @id, @accountId, @mailbox, @uid,
      @messageId, @subject, @fromName, @fromAddress, @toJson, @ccJson, @inReplyTo, @referencesJson,
      @sentAt, @snippet, @textBody, @htmlBody, @flagsJson, @hasAttachments, @attachmentsJson,
      @encryptedPayload, @payloadVersion, @size, @createdAt
    )
  `);

  db.transaction(() => {
    const prior = existing.get(account.id, destination, uid) as { id: string } | undefined;
    if (prior) {
      if (prior.id !== id) throw new Error("The appended draft conflicts with an existing local message record.");
      return;
    }
    const agentLease = agentEvents?.acquireLease(account.id);
    insert.run({
      id,
      accountId: account.id,
      mailbox: destination,
      uid,
      ...protectedColumns,
      sentAt: now,
      flagsJson: JSON.stringify(["\\Draft"]),
      hasAttachments: draft.attachments?.length ? 1 : 0,
      size: rawSize,
      createdAt: now,
    });
    // Drafts are searchable through the same FTS index as synced mail.
    indexMessageFts(db, id, {
      subject: draft.subject,
      fromName: "",
      fromAddress: account.email,
      textBody: draft.text,
    });
    if (agentEvents && agentLease) {
      agentEvents.messageUpsertedWithinTransaction(agentLease, id, {
        transition: "draft-appended",
        mailbox: destination,
        uid,
        flags: ["\\Draft"],
      });
    }
  })();
  return id;
}

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
  agentEvents?: AgentMailEventSink,
  signal?: AbortSignal,
): Promise<DraftSaveResult> {
  throwIfDraftOperationCancelled(signal);
  const destination = draftMailbox(db, account.id);
  if (!destination) throw new Error("这个邮箱没有提供可用的草稿文件夹。");
  // Validate the target before APPEND. An update must never create a new
  // remote draft when its requested replacement is stale, foreign, or not a
  // draft in the first place.
  if (options.replaceDraftId) storedDraftForAccount(db, account, options.replaceDraftId);

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

  throwIfDraftOperationCancelled(signal);
  const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
  let appendStarted = false;
  let appendConfirmed = false;
  let abortedDuringAppend = false;
  let appendedUid: number | undefined;
  const removeAbortListener = closeClientOnAbort(client, signal, () => {
    if (appendStarted) abortedDuringAppend = true;
  });
  try {
    throwIfDraftOperationCancelled(signal);
    await client.connect();
    throwIfDraftOperationCancelled(signal);
    // An IMAP tagged OK response to APPEND is the server-side persistence
    // acknowledgement. Do not create a local-only success path for drafts.
    appendStarted = true;
    const appended = await client.append(destination, generated.message, ["\\Draft"]);
    if (abortedDuringAppend || signal?.aborted) {
      throw draftOperationAbortError("draft_operation_outcome_unknown");
    }
    if (!appended) throw new Error("邮件服务器未确认草稿保存，请稍后重试。");
    appendConfirmed = true;
    appendedUid = await appendedDraftUid(client, destination, generated.messageId, appended, signal);
    if (!validUid(appendedUid)) throw draftOperationAbortError("draft_operation_outcome_unknown");
  } catch (error) {
    if (abortedDuringAppend || (appendStarted && signal?.aborted)) {
      throw draftOperationAbortError("draft_operation_outcome_unknown");
    }
    if (signal?.aborted) throw draftOperationAbortError("draft_operation_cancelled");
    // The APPEND tagged OK response is durable. A later lookup failure must
    // not look retryable, because another APPEND could duplicate the draft.
    if (appendConfirmed) throw draftOperationAbortError("draft_operation_outcome_unknown");
    throw error;
  } finally {
    removeAbortListener();
    if (client.usable) await client.logout().catch(() => undefined);
  }

  // From this point a new remote draft is known to exist. A late cancellation
  // cannot truthfully be presented as a fully cancelled operation.
  if (signal?.aborted) throw draftOperationAbortError("draft_operation_outcome_unknown");
  let id: string;
  try {
    id = persistAppendedDraft(
      db,
      masterKey,
      account,
      destination,
      appendedUid,
      draft,
      generated.messageId,
      generated.message.length,
      agentEvents,
    );
  } catch {
    // The remote draft is already durable, but without a local messages.id it
    // cannot be safely updated or deleted through the normal mutation APIs.
    throw draftOperationAbortError("draft_operation_outcome_unknown");
  }
  if (signal?.aborted) throw draftOperationAbortError("draft_operation_outcome_unknown");
  let replaceWarning: string | undefined;
  if (options.replaceDraftId) {
    try {
      await discardDraft(db, masterKey, account, options.replaceDraftId, accessTokenProvider, agentEvents, signal);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "draft_operation_outcome_unknown" || signal?.aborted) {
        throw draftOperationAbortError("draft_operation_outcome_unknown");
      }
      replaceWarning = safeDraftReplacementWarning(error);
    }
  }
  return {
    id,
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
  agentEvents?: AgentMailEventSink,
  signal?: AbortSignal,
): Promise<void> {
  throwIfDraftOperationCancelled(signal);
  const stored = storedDraftForAccount(db, account, messageId);
  const agentLease = agentEvents?.acquireLease(account.id);

  throwIfDraftOperationCancelled(signal);
  const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
  let deletionStarted = false;
  let abortedDuringDeletion = false;
  const removeAbortListener = closeClientOnAbort(client, signal, () => {
    if (deletionStarted) abortedDuringDeletion = true;
  });
  try {
    throwIfDraftOperationCancelled(signal);
    await client.connect();
    throwIfDraftOperationCancelled(signal);
    const lock = await client.getMailboxLock(stored.mailbox);
    try {
      throwIfDraftOperationCancelled(signal);
      deletionStarted = true;
      const deleted = await client.messageDelete(stored.uid, { uid: true });
      if (abortedDuringDeletion || signal?.aborted) {
        throw draftOperationAbortError("draft_operation_outcome_unknown");
      }
      if (!deleted) throw new Error("邮件服务器未确认草稿删除，请稍后重试。");
    } finally {
      lock.release();
    }
    // Keep the local record for the next sync if cancellation races the
    // server acknowledgement. The remote deletion may already be durable.
    if (signal?.aborted) throw draftOperationAbortError("draft_operation_outcome_unknown");
    db.transaction(() => {
      const deleted = db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
      if (deleted.changes !== 1) throw new Error("Draft record could not be removed after server confirmation.");
      if (agentEvents && agentLease) {
        agentEvents.messageDeletedWithinTransaction(agentLease, messageId, {
          reason: "draft-discarded",
          mailbox: stored.mailbox,
          uid: stored.uid,
          remoteIdLookup: stored.remote_id_lookup,
          flagsJson: stored.flags_json,
          allMailArchived: stored.all_mail_archived,
        });
      }
    })();
  } catch (error) {
    if (abortedDuringDeletion || (deletionStarted && signal?.aborted)) {
      throw draftOperationAbortError("draft_operation_outcome_unknown");
    }
    throw error;
  } finally {
    removeAbortListener();
    if (client.usable) await client.logout().catch(() => undefined);
  }
}
