import type { Message, MessageDetail } from "@nami/agent-contracts";
import { limitStoredHtmlBody, limitStoredTextBody } from "./message-body-limits.js";
import {
  hasPendingMove,
  hasUnverifiedMoveLocation,
  messagePayloadForRow,
  pendingMoveDestination,
  type MessageStorageRow,
} from "./message-storage.js";

/**
 * How much of the plain-text body a list row carries.
 *
 * The list renders the snippet alone, but the web re-filters the loaded page
 * with the live (un-debounced) search needle, and that filter matches
 * `subject + from + textBody + snippet` — a list row without any body text
 * would silently drop rows the server's full-text search had just matched.
 * Four thousand characters keeps the page payload at ~160KB (40 rows) while
 * covering the part of a mail that search actually reads; the authoritative
 * search stays the server's FTS index over the complete body.
 */
export const LIST_TEXT_PREVIEW_CHARS = 4_000;

/** Rewrite cid:xxx references in HTML to the inline serving endpoint. */
function rewriteCidReferences(html: string, messageId: string, attachments: { partId: string; contentId?: string }[] | null): string {
  if (!attachments || !html) return html;
  const cidMap = new Map<string, string>();
  for (const att of attachments) {
    if (att.contentId) cidMap.set(att.contentId.toLowerCase(), att.partId);
  }
  if (cidMap.size === 0) return html;
  return html.replace(/src\s*=\s*["']?\s*cid:([^"'\s>]+)/gi, (_match, cid: string) => {
    const partId = cidMap.get(cid.toLowerCase());
    return partId ? `src="/api/messages/${messageId}/inline/${partId}"` : _match;
  });
}

export type MessageRowOptions = {
  /**
   * Whether the row carries the message body. `false` is the list shape: a
   * bounded text preview, no HTML part, and no `rewriteCidReferences` pass
   * over a body the reader no longer receives from here. `true` is the
   * per-message detail shape.
   */
  body?: boolean;
};

/** Serializes a message row for the wire. Shape authority: `Message` in @nami/agent-contracts. */
export function messageRow(row: MessageStorageRow, masterKey: Buffer, options: MessageRowOptions = {}): Message | MessageDetail {
  const flags = JSON.parse(String(row.flags_json ?? "[]")) as string[];
  const payload = messagePayloadForRow(row, masterKey);
  const pendingDestination = pendingMoveDestination(row);
  const movePending = hasPendingMove(row);
  const moveLocationUnverified = hasUnverifiedMoveLocation(row);
  const pendingArchive = pendingDestination !== null
    && (row.pending_move_special_use === "\\Archive"
      || (row.pending_move_special_use === "\\All" && row.all_mail_archived === 1));
  // Join-derived columns are typed by the list/detail queries, not by
  // MessageStorageRow itself; assert here once instead of at every call site.
  const accountEmail = row.account_email as string;
  const providerName = row.provider_name as string;
  const sentAt = row.sent_at as string;
  const size = row.size as number;
  const snoozedUntil = (row.snoozed_until ?? null) as string | null;
  const body = options.body !== false
    ? {
      // A row written before the ingest cap existed still carries whatever the
      // sender sent, and the reader would be handed all of it. The wire copy
      // is bounded by the same policy (the stored payload, and the EML export
      // that re-downloads the provider source, are untouched), so a mailbox
      // that was poisoned before the cap cannot freeze a reader either.
      textBody: limitStoredTextBody(payload.textBody),
      htmlBody: limitStoredHtmlBody(rewriteCidReferences(payload.htmlBody, row.id, payload.attachments)),
    }
    // A list row must not carry the HTML part at all: the reader fetches it
    // per message, and serializing it here is what a page of large mail
    // multiplies. The key is omitted rather than emptied so "this row has no
    // body" stays distinguishable from "this message's body is empty".
    : { textBody: payload.textBody.slice(0, LIST_TEXT_PREVIEW_CHARS) };
  return {
    id: row.id,
    accountId: row.account_id,
    accountEmail,
    providerName,
    mailbox: pendingDestination ?? row.mailbox,
    uid: row.uid,
    movePending,
    moveLocationUnverified,
    archived: row.all_mail_archived === 1 || pendingArchive,
    subject: payload.subject,
    from: { name: payload.fromName, address: payload.fromAddress },
    to: payload.to,
    cc: payload.cc ?? [],
    ...(payload.bcc?.length ? { bcc: payload.bcc } : {}),
    messageId: payload.messageId,
    inReplyTo: payload.inReplyTo,
    references: payload.references ?? [],
    sentAt,
    snippet: payload.snippet,
    ...body,
    flags,
    seen: flags.includes("\\Seen"),
    flagged: flags.includes("\\Flagged"),
    hasAttachments: Boolean(row.has_attachments),
    attachments: payload.attachments ?? [],
    size,
    snoozedUntil,
  };
}
