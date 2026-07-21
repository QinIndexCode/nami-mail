import type { MailAddress, Message } from "./types";

export type ComposeAction = {
  to: string[];
  cc: string[];
  subject: string;
  text?: string;
  inReplyTo?: string;
  references?: string[];
};

const messageIdPattern = /^<[^<>\r\n]{1,998}>$/;

function normalizedAddress(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueAddresses(values: readonly string[], excluded: ReadonlySet<string> = new Set()): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const address = value.trim();
    const key = normalizedAddress(address);
    if (!address || excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(address);
  }
  return result;
}

function messageIds(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = value.trim();
    if (!messageIdPattern.test(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(-50);
}

function prefixSubject(subject: string, prefix: "Re" | "Fwd"): string {
  const existing = prefix === "Re"
    ? /^\s*re\s*:/i
    : /^\s*(?:fw|fwd)\s*:/i;
  return existing.test(subject) ? subject : `${prefix}: ${subject}`;
}

function formattedAddress(address: MailAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function formattedRecipients(recipients: readonly MailAddress[]): string {
  return recipients.map(formattedAddress).filter(Boolean).join(", ");
}

function replyThreading(message: Message): Pick<ComposeAction, "inReplyTo" | "references"> {
  const inReplyTo = message.messageId?.trim();
  if (!inReplyTo || !messageIdPattern.test(inReplyTo)) return {};
  const references = messageIds([...(message.references ?? []), inReplyTo]);
  return { inReplyTo, references };
}

/** Builds a direct reply or reply-all draft without ever mailing one of the user's own accounts. */
export function buildReplyDraft(message: Message, accountEmails: readonly string[], replyAll = false): ComposeAction {
  const ownAddresses = new Set(accountEmails.map(normalizedAddress));
  const fromAddress = message.from.address.trim();
  const fromIsOwn = ownAddresses.has(normalizedAddress(fromAddress));
  const originalTo = message.to.map((recipient) => recipient.address);
  const originalCc = message.cc.map((recipient) => recipient.address);
  const toCandidates = fromIsOwn
    ? originalTo
    : replyAll ? [fromAddress, ...originalTo] : [fromAddress];
  const to = uniqueAddresses(toCandidates, ownAddresses);
  const toKeys = new Set(to.map(normalizedAddress));
  const cc = replyAll ? uniqueAddresses(originalCc, new Set([...ownAddresses, ...toKeys])) : [];
  return {
    to,
    cc,
    subject: prefixSubject(message.subject, "Re"),
    ...replyThreading(message),
  };
}

/** Builds a plain-text forward so message HTML is never copied into the composer unsanitized. */
export function buildForwardDraft(message: Message, body: string): ComposeAction {
  const forwardedBody = body.trim() || message.snippet.trim();
  const headers = [
    "---------- Forwarded message ----------",
    `From: ${formattedAddress(message.from)}`,
    `Date: ${message.sentAt}`,
    `Subject: ${message.subject}`,
  ];
  const to = formattedRecipients(message.to);
  const cc = formattedRecipients(message.cc);
  if (to) headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  return {
    to: [],
    cc: [],
    subject: prefixSubject(message.subject, "Fwd"),
    text: `${headers.join("\n")}\n\n${forwardedBody}`,
  };
}
