import { createHash, createHmac, randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import {
  decryptTextEnvelope,
  deriveEncryptionKey,
  encryptTextEnvelope,
} from "./crypto.js";
import type { DatabaseHandle } from "./db.js";
import { mailErrorCode, type MailErrorCode } from "./mail.js";
import { messagePayloadForRow, type MessageStorageRow } from "./message-storage.js";

export const OUTBOUND_SUBMISSION_CRYPTO_VERSION = 1;

const OUTBOUND_SUBMISSION_MIGRATION_ID = "outbound-submission-payload-v1";
const requestKeyPurpose = "outbound-submission-request-v1";
const detailsKeyPurpose = "outbound-submission-details-v1";
const fingerprintKeyPurpose = "outbound-submission-fingerprint-v1";
const messageIdKeyPurpose = "outbound-submission-message-id-v1";

export const OUTBOUND_SUBMISSION_STATUSES = [
  "pending",
  "submitting",
  "submitted",
  "confirmed",
  "unknown_delivery",
  "failed",
] as const;

export type OutboundSubmissionStatus = typeof OUTBOUND_SUBMISSION_STATUSES[number];

export type OutboundSubmissionRequest = {
  to: string[];
  cc?: string[];
  inReplyTo?: string;
  references?: string[];
  subject: string;
  text: string;
  html?: string;
  discardDraftId?: string;
  attachmentTokens: string[];
};

type StoredSubmission = {
  id: string;
  account_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  rfc_message_id: string;
  request_json: string;
  status: OutboundSubmissionStatus;
  error_code: string | null;
  error_message: string | null;
  provider_message_id: string | null;
  post_submit_warning: string | null;
  encrypted_details?: string | null;
  crypto_version?: number | null;
  submitted_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

type SubmissionDetails = {
  rfcMessageId: string;
  errorMessage: string | null;
  providerMessageId: string | null;
  postSubmitWarning: string | null;
};

export type OutboundSubmission = {
  id: string;
  accountId: string;
  messageId: string;
  subject: string;
  recipients: string[];
  deliveryStatus: OutboundSubmissionStatus;
  errorCode: string | null;
  errorMessage: string | null;
  postSubmitWarning: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class SubmissionConflictError extends Error {
  constructor() {
    super("This send request is already associated with different message content.");
    this.name = "SubmissionConflictError";
  }
}

function canonicalRequest(request: OutboundSubmissionRequest): string {
  // Keep a stable, explicit field order. It is a fingerprint only; the full
  // request is retained separately so interrupted submissions remain auditable.
  return JSON.stringify({
    to: request.to,
    cc: request.cc ?? [],
    inReplyTo: request.inReplyTo ?? null,
    references: request.references ?? [],
    subject: request.subject,
    text: request.text,
    html: request.html ?? null,
    discardDraftId: request.discardDraftId ?? null,
    attachmentTokens: request.attachmentTokens,
  });
}

function legacyRequestFingerprint(request: OutboundSubmissionRequest): string {
  return createHash("sha256").update(canonicalRequest(request), "utf8").digest("hex");
}

function withDerivedKey<T>(masterKey: Buffer, purpose: string, callback: (key: Buffer) => T): T {
  const key = deriveEncryptionKey(masterKey, purpose);
  try {
    return callback(key);
  } finally {
    key.fill(0);
  }
}

function requestAad(row: Pick<StoredSubmission, "id" | "account_id">): string {
  return `outbound-submissions\0${row.account_id}\0${row.id}\0request-v1`;
}

function detailsAad(row: Pick<StoredSubmission, "id" | "account_id">): string {
  return `outbound-submissions\0${row.account_id}\0${row.id}\0details-v1`;
}

function requestFingerprint(masterKey: Buffer, accountId: string, request: OutboundSubmissionRequest): string {
  return withDerivedKey(masterKey, fingerprintKeyPurpose, (key) =>
    `h1.${createHmac("sha256", key).update(accountId, "utf8").update("\0").update(canonicalRequest(request), "utf8").digest("base64url")}`);
}

function messageIdLookup(masterKey: Buffer, accountId: string, messageId: string): string {
  return withDerivedKey(masterKey, messageIdKeyPurpose, (key) =>
    `h1.${createHmac("sha256", key).update(accountId, "utf8").update("\0").update(messageId, "utf8").digest("base64url")}`);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Stored outbound submission ${field} is invalid.`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Stored outbound submission ${field} is invalid.`);
  return value;
}

function normalizeStoredRequest(value: unknown): OutboundSubmissionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored outbound submission request is invalid.");
  }
  const item = value as Record<string, unknown>;
  if (typeof item.subject !== "string" || typeof item.text !== "string") {
    throw new Error("Stored outbound submission request is invalid.");
  }
  return {
    to: stringArray(item.to, "recipients"),
    cc: stringArray(item.cc ?? [], "Cc recipients"),
    ...(nullableString(item.inReplyTo, "In-Reply-To") !== undefined ? { inReplyTo: item.inReplyTo as string } : {}),
    references: stringArray(item.references ?? [], "References"),
    subject: item.subject,
    text: item.text,
    ...(nullableString(item.html, "HTML") !== undefined ? { html: item.html as string } : {}),
    ...(nullableString(item.discardDraftId, "draft ID") !== undefined ? { discardDraftId: item.discardDraftId as string } : {}),
    attachmentTokens: stringArray(item.attachmentTokens, "attachment tokens"),
  };
}

function normalizeStoredDetails(value: unknown): SubmissionDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored outbound submission details are invalid.");
  }
  const item = value as Record<string, unknown>;
  if (typeof item.rfcMessageId !== "string" || !item.rfcMessageId) {
    throw new Error("Stored outbound submission Message-ID is invalid.");
  }
  const errorMessage = nullableString(item.errorMessage, "error message") ?? null;
  const providerMessageId = nullableString(item.providerMessageId, "provider message ID") ?? null;
  const postSubmitWarning = nullableString(item.postSubmitWarning, "post-submit warning") ?? null;
  return { rfcMessageId: item.rfcMessageId, errorMessage, providerMessageId, postSubmitWarning };
}

function requestForRow(row: StoredSubmission, masterKey: Buffer): OutboundSubmissionRequest {
  let plaintext: string;
  if (row.crypto_version === OUTBOUND_SUBMISSION_CRYPTO_VERSION && row.request_json.startsWith("nami-v1.")) {
    plaintext = withDerivedKey(masterKey, requestKeyPurpose, (key) =>
      decryptTextEnvelope(row.request_json, key, requestAad(row)));
  } else {
    plaintext = row.request_json;
  }
  try {
    return normalizeStoredRequest(JSON.parse(plaintext) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Stored outbound submission")) throw error;
    throw new Error("Stored outbound submission request is invalid.");
  }
}

function detailsForRow(row: StoredSubmission, masterKey: Buffer): SubmissionDetails {
  let details: SubmissionDetails;
  if (row.crypto_version === OUTBOUND_SUBMISSION_CRYPTO_VERSION && row.encrypted_details) {
    const plaintext = withDerivedKey(masterKey, detailsKeyPurpose, (key) =>
      decryptTextEnvelope(row.encrypted_details as string, key, detailsAad(row)));
    try {
      details = normalizeStoredDetails(JSON.parse(plaintext) as unknown);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Stored outbound submission")) throw error;
      throw new Error("Stored outbound submission details are invalid.");
    }
  } else {
    if (!row.rfc_message_id) throw new Error("Stored outbound submission Message-ID is invalid.");
    details = {
      rfcMessageId: row.rfc_message_id,
      errorMessage: row.error_message,
      providerMessageId: row.provider_message_id,
      postSubmitWarning: row.post_submit_warning,
    };
  }
  // Preserve a value written by an older process after an interrupted rolling
  // migration; the next protection pass clears these compatibility columns.
  return {
    ...details,
    errorMessage: row.error_message ?? details.errorMessage,
    providerMessageId: row.provider_message_id ?? details.providerMessageId,
    postSubmitWarning: row.post_submit_warning ?? details.postSubmitWarning,
  };
}

function encryptedRequest(row: StoredSubmission, masterKey: Buffer, request: OutboundSubmissionRequest): string {
  return withDerivedKey(masterKey, requestKeyPurpose, (key) =>
    encryptTextEnvelope(canonicalRequest(request), key, requestAad(row)));
}

function encryptedDetails(row: StoredSubmission, masterKey: Buffer, details: SubmissionDetails): string {
  return withDerivedKey(masterKey, detailsKeyPurpose, (key) =>
    encryptTextEnvelope(JSON.stringify(details), key, detailsAad(row)));
}

function generatedMessageId(accountEmail: string): string {
  const rawDomain = accountEmail.slice(accountEmail.lastIndexOf("@") + 1).trim().toLowerCase();
  const domain = domainToASCII(rawDomain) || "nami.invalid";
  return `<${randomUUID()}@${domain}>`;
}

function publicSubmission(row: StoredSubmission, masterKey: Buffer): OutboundSubmission {
  const details = detailsForRow(row, masterKey);
  const request = requestForRow(row, masterKey);
  return {
    id: row.id,
    accountId: row.account_id,
    messageId: details.rfcMessageId,
    subject: request.subject,
    recipients: [...request.to, ...(request.cc ?? [])],
    deliveryStatus: row.status,
    errorCode: row.error_code,
    errorMessage: details.errorMessage,
    postSubmitWarning: details.postSubmitWarning,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function submissionById(db: DatabaseHandle, id: string): StoredSubmission | undefined {
  return db.prepare("SELECT * FROM outbound_submissions WHERE id = ?").get(id) as StoredSubmission | undefined;
}

function submissionByKey(db: DatabaseHandle, accountId: string, idempotencyKey: string): StoredSubmission | undefined {
  return db.prepare(`
    SELECT * FROM outbound_submissions WHERE account_id = ? AND idempotency_key = ?
  `).get(accountId, idempotencyKey) as StoredSubmission | undefined;
}

function protectSubmissionRow(
  db: DatabaseHandle,
  row: StoredSubmission,
  masterKey: Buffer,
  request: OutboundSubmissionRequest,
  details: SubmissionDetails,
): void {
  db.prepare(`
    UPDATE outbound_submissions
    SET request_fingerprint = ?,
        rfc_message_id = ?,
        request_json = ?,
        error_message = NULL,
        provider_message_id = NULL,
        post_submit_warning = NULL,
        encrypted_details = ?,
        crypto_version = ?
    WHERE id = ?
  `).run(
    requestFingerprint(masterKey, row.account_id, request),
    messageIdLookup(masterKey, row.account_id, details.rfcMessageId),
    encryptedRequest(row, masterKey, request),
    encryptedDetails(row, masterKey, details),
    OUTBOUND_SUBMISSION_CRYPTO_VERSION,
    row.id,
  );
}

/** Encrypts legacy send requests and diagnostic details before API startup. */
export function migrateOutboundSubmissionStorage(
  db: DatabaseHandle,
  masterKey: Buffer,
): { migrated: number; vacuumed: boolean } {
  const marker = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(OUTBOUND_SUBMISSION_MIGRATION_ID);
  const rows = db.prepare(`
    SELECT * FROM outbound_submissions
    WHERE crypto_version <> ? OR encrypted_details IS NULL OR encrypted_details = ''
       OR request_json NOT LIKE 'nami-v1.%'
       OR request_fingerprint NOT LIKE 'h1.%' OR rfc_message_id NOT LIKE 'h1.%'
       OR error_message IS NOT NULL OR provider_message_id IS NOT NULL OR post_submit_warning IS NOT NULL
  `).all(OUTBOUND_SUBMISSION_CRYPTO_VERSION) as StoredSubmission[];

  db.transaction(() => {
    for (const row of rows) {
      protectSubmissionRow(db, row, masterKey, requestForRow(row, masterKey), detailsForRow(row, masterKey));
    }
  })();

  const protectedRows = db.prepare("SELECT * FROM outbound_submissions").all() as StoredSubmission[];
  for (const row of protectedRows) {
    const request = requestForRow(row, masterKey);
    const details = detailsForRow(row, masterKey);
    if (
      row.crypto_version !== OUTBOUND_SUBMISSION_CRYPTO_VERSION
      || row.error_message !== null
      || row.provider_message_id !== null
      || row.post_submit_warning !== null
      || row.request_fingerprint !== requestFingerprint(masterKey, row.account_id, request)
      || row.rfc_message_id !== messageIdLookup(masterKey, row.account_id, details.rfcMessageId)
    ) {
      throw new Error("Outbound submission storage migration verification failed.");
    }
  }

  let vacuumed = false;
  if (rows.length > 0 || (!marker && protectedRows.length > 0)) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.pragma("wal_checkpoint(TRUNCATE)");
    vacuumed = true;
  }
  db.prepare(`
    INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
  `).run(OUTBOUND_SUBMISSION_MIGRATION_ID, new Date().toISOString());
  if (vacuumed) db.pragma("wal_checkpoint(TRUNCATE)");
  return { migrated: rows.length, vacuumed };
}

export function submissionRequestForId(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
): OutboundSubmissionRequest | undefined {
  const row = submissionById(db, id);
  return row ? requestForRow(row, masterKey) : undefined;
}

export function createIdempotencyKey(): string {
  return `sub_${randomUUID()}`;
}

export function prepareSubmission(
  db: DatabaseHandle,
  masterKey: Buffer,
  input: { accountId: string; accountEmail: string; idempotencyKey?: string; request: OutboundSubmissionRequest },
): { submission: OutboundSubmission; idempotencyKey: string; created: boolean } {
  const idempotencyKey = input.idempotencyKey || createIdempotencyKey();
  const fingerprint = requestFingerprint(masterKey, input.accountId, input.request);
  const existing = submissionByKey(db, input.accountId, idempotencyKey);
  if (existing) {
    const legacyFingerprint = legacyRequestFingerprint(input.request);
    if (existing.request_fingerprint !== fingerprint && existing.request_fingerprint !== legacyFingerprint) {
      throw new SubmissionConflictError();
    }
    if (existing.crypto_version !== OUTBOUND_SUBMISSION_CRYPTO_VERSION) {
      protectSubmissionRow(db, existing, masterKey, requestForRow(existing, masterKey), detailsForRow(existing, masterKey));
    }
    const protectedExisting = submissionByKey(db, input.accountId, idempotencyKey);
    if (!protectedExisting) throw new Error("Outbound submission not found.");
    return { submission: publicSubmission(protectedExisting, masterKey), idempotencyKey, created: false };
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const rfcMessageId = generatedMessageId(input.accountEmail);
  const row: StoredSubmission = {
    id,
    account_id: input.accountId,
    idempotency_key: idempotencyKey,
    request_fingerprint: fingerprint,
    rfc_message_id: messageIdLookup(masterKey, input.accountId, rfcMessageId),
    request_json: "",
    status: "pending",
    error_code: null,
    error_message: null,
    provider_message_id: null,
    post_submit_warning: null,
    encrypted_details: null,
    crypto_version: OUTBOUND_SUBMISSION_CRYPTO_VERSION,
    submitted_at: null,
    confirmed_at: null,
    created_at: now,
    updated_at: now,
  };
  row.request_json = encryptedRequest(row, masterKey, input.request);
  row.encrypted_details = encryptedDetails(row, masterKey, {
    rfcMessageId,
    errorMessage: null,
    providerMessageId: null,
    postSubmitWarning: null,
  });

  try {
    db.prepare(`
      INSERT INTO outbound_submissions (
        id, account_id, idempotency_key, request_fingerprint, rfc_message_id,
        request_json, status, error_code, error_message, provider_message_id,
        post_submit_warning, encrypted_details, crypto_version,
        submitted_at, confirmed_at, created_at, updated_at
      ) VALUES (
        @id, @account_id, @idempotency_key, @request_fingerprint, @rfc_message_id,
        @request_json, @status, @error_code, @error_message, @provider_message_id,
        @post_submit_warning, @encrypted_details, @crypto_version,
        @submitted_at, @confirmed_at, @created_at, @updated_at
      )
    `).run(row);
    return { submission: publicSubmission(row, masterKey), idempotencyKey, created: true };
  } catch (error) {
    // A duplicate POST can race in two Fastify handlers. Re-read the durable
    // row rather than creating another RFC Message-ID for the same request.
    const raced = submissionByKey(db, input.accountId, idempotencyKey);
    if (!raced) throw error;
    const legacyFingerprint = legacyRequestFingerprint(input.request);
    if (raced.request_fingerprint !== fingerprint && raced.request_fingerprint !== legacyFingerprint) {
      throw new SubmissionConflictError();
    }
    return { submission: publicSubmission(raced, masterKey), idempotencyKey, created: false };
  }
}

export function submissionForId(db: DatabaseHandle, masterKey: Buffer, id: string): OutboundSubmission | undefined {
  const row = submissionById(db, id);
  return row ? publicSubmission(row, masterKey) : undefined;
}

export function submissionsForAccount(db: DatabaseHandle, masterKey: Buffer, accountId: string, limit = 50): OutboundSubmission[] {
  return (db.prepare(`
    SELECT * FROM outbound_submissions
    WHERE account_id = ?
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(accountId, limit) as StoredSubmission[]).map((row) => publicSubmission(row, masterKey));
}

export function startSubmission(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
): { submission: OutboundSubmission; shouldAttempt: boolean } {
  const existing = submissionById(db, id);
  if (!existing) throw new Error("Outbound submission not found.");

  if (existing.status === "pending" || existing.status === "failed") {
    return {
      submission: updateSubmission(db, masterKey, id, {
        status: "submitting",
        errorCode: null,
        errorMessage: null,
      }),
      shouldAttempt: true,
    };
  }

  // `submitting` means another renderer request already owns the attempt.
  // `unknown_delivery` must never be automatically retried because SMTP may
  // have accepted the message just before the connection disappeared.
  return { submission: publicSubmission(existing, masterKey), shouldAttempt: false };
}

function updateSubmission(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
  fields: {
    status: OutboundSubmissionStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    providerMessageId?: string | null;
    submittedAt?: string | null;
    confirmedAt?: string | null;
    postSubmitWarning?: string | null;
  },
): OutboundSubmission {
  const current = submissionById(db, id);
  if (!current) throw new Error("Outbound submission not found.");
  const currentDetails = detailsForRow(current, masterKey);
  const has = (field: keyof typeof fields): boolean => Object.prototype.hasOwnProperty.call(fields, field);
  const details: SubmissionDetails = {
    rfcMessageId: currentDetails.rfcMessageId,
    errorMessage: has("errorMessage") ? fields.errorMessage ?? null : currentDetails.errorMessage,
    providerMessageId: has("providerMessageId") ? fields.providerMessageId ?? null : currentDetails.providerMessageId,
    postSubmitWarning: has("postSubmitWarning") ? fields.postSubmitWarning ?? null : currentDetails.postSubmitWarning,
  };
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE outbound_submissions
    SET status = @status,
        error_code = @errorCode,
        error_message = NULL,
        provider_message_id = NULL,
        submitted_at = @submittedAt,
        confirmed_at = @confirmedAt,
        post_submit_warning = NULL,
        encrypted_details = @encryptedDetails,
        crypto_version = @cryptoVersion,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    status: fields.status,
    errorCode: has("errorCode") ? fields.errorCode ?? null : current.error_code,
    submittedAt: has("submittedAt") ? fields.submittedAt ?? null : current.submitted_at,
    confirmedAt: has("confirmedAt") ? fields.confirmedAt ?? null : current.confirmed_at,
    encryptedDetails: encryptedDetails(current, masterKey, details),
    cryptoVersion: OUTBOUND_SUBMISSION_CRYPTO_VERSION,
    updatedAt: now,
  });
  const updated = submissionById(db, id);
  if (!updated) throw new Error("Outbound submission not found.");
  return publicSubmission(updated, masterKey);
}

export function markSubmissionSubmitted(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
  providerMessageId: string | undefined,
): OutboundSubmission {
  const submittedAt = new Date().toISOString();
  return updateSubmission(db, masterKey, id, {
    status: "submitted",
    errorCode: null,
    errorMessage: null,
    providerMessageId: providerMessageId ?? null,
    submittedAt,
  });
}

/**
 * A Sent-folder match proves that this account's provider stored the exact
 * RFC message. It is intentionally distinct from recipient delivery: IMAP
 * and SMTP alone cannot prove that a recipient read or received the message.
 */
export function markSubmissionConfirmed(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
): OutboundSubmission {
  const current = submissionById(db, id);
  if (!current) throw new Error("Outbound submission not found.");
  if (current.status === "confirmed") return publicSubmission(current, masterKey);
  if (current.status !== "submitted" && current.status !== "unknown_delivery") {
    return publicSubmission(current, masterKey);
  }
  return updateSubmission(db, masterKey, id, {
    status: "confirmed",
    errorCode: null,
    errorMessage: null,
    confirmedAt: new Date().toISOString(),
  });
}

export function markSubmissionFailed(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
  errorCode: string,
  errorMessage: string,
): OutboundSubmission {
  return updateSubmission(db, masterKey, id, { status: "failed", errorCode, errorMessage });
}

export function markSubmissionUnknownDelivery(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
  errorCode: string,
  errorMessage: string,
): OutboundSubmission {
  return updateSubmission(db, masterKey, id, { status: "unknown_delivery", errorCode, errorMessage });
}

export function setSubmissionPostSubmitWarning(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
  warning: string | null,
): OutboundSubmission {
  const current = submissionById(db, id);
  if (!current) throw new Error("Outbound submission not found.");
  return updateSubmission(db, masterKey, id, { status: current.status, postSubmitWarning: warning });
}

function smtpCommand(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 2) return undefined;
  const details = error as Record<string, unknown>;
  if (typeof details.command === "string") return details.command.trim().toUpperCase();
  return smtpCommand(details.cause, depth + 1);
}

function isKnownPreAcceptanceFailure(code: MailErrorCode, error: unknown): boolean {
  if ([
    "local_data_invalid",
    "invalid_credential",
    "imap_auth_failed",
    "smtp_auth_failed",
    "imap_disabled",
    "provider_configuration",
    "server_not_found",
    "network_unavailable",
    "connection_refused",
    "tls_certificate_failed",
    "tls_handshake_failed",
    "oauth_required",
    "reauth_required",
  ].includes(code)) return true;

  // Nodemailer labels SMTP protocol failures by command. Explicit SMTP
  // command rejection before message transfer is safe to retry. `CONN` is
  // intentionally excluded: socket timeout/reset errors may be reported with
  // that command even when the final delivery response was lost.
  const command = smtpCommand(error);
  return command === "EHLO"
    || command === "HELO"
    || command === "AUTH"
    || command === "MAIL FROM"
    || command === "RCPT TO"
    || command === "DATA";
}

export function deliveryFailureStatus(error: unknown): "failed" | "unknown_delivery" {
  const code = mailErrorCode(error);
  return isKnownPreAcceptanceFailure(code, error) ? "failed" : "unknown_delivery";
}

/** Converts an interrupted process-local SMTP attempt into a safe no-retry state. */
export function recoverInterruptedSubmissions(db: DatabaseHandle, masterKey: Buffer): number {
  const rows = db.prepare("SELECT id FROM outbound_submissions WHERE status = 'submitting'").all() as Array<{ id: string }>;
  db.transaction(() => {
    for (const row of rows) {
      updateSubmission(db, masterKey, row.id, {
        status: "unknown_delivery",
        errorCode: "submission_interrupted",
        errorMessage: "The previous SMTP attempt was interrupted before delivery could be confirmed. Check Sent before sending again.",
      });
    }
  })();
  return rows.length;
}

/** Marks SMTP-accepted or uncertain submissions confirmed after Sent sync finds the exact RFC Message-ID. */
export function confirmSubmissionsInSent(db: DatabaseHandle, masterKey: Buffer, accountId: string): number {
  const sentRows = db.prepare(`
    SELECT m.* FROM messages m
    JOIN folders f ON f.account_id = m.account_id AND f.path = m.mailbox
    WHERE m.account_id = ? AND f.special_use = '\\Sent'
  `).all(accountId) as MessageStorageRow[];
  const sentMessageIds = new Set(sentRows.flatMap((row) => {
    const messageId = messagePayloadForRow(row, masterKey).messageId;
    return messageId ? [messageId] : [];
  }));
  if (!sentMessageIds.size) return 0;

  const candidates = db.prepare(`
    SELECT * FROM outbound_submissions
    WHERE account_id = ? AND status IN ('submitted', 'unknown_delivery')
  `).all(accountId) as StoredSubmission[];
  const confirmed = candidates.filter((row) => sentMessageIds.has(detailsForRow(row, masterKey).rfcMessageId));
  if (!confirmed.length) return 0;
  db.transaction(() => {
    for (const row of confirmed) markSubmissionConfirmed(db, masterKey, row.id);
  })();
  return confirmed.length;
}
