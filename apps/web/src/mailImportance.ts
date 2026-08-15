import type { Message } from "./types";
import type { MessageListSortOrder } from "./mailListState";

/**
 * Local, deterministic approximation of the signals Gmail uses to rank mail
 * by importance (Google's Priority Inbox research: predicting whether the
 * user will read, reply to, or star a message). No machine learning and no
 * Gmail `\Important` IMAP label dependency: every signal below is computed
 * from fields the `Message` model already carries, so the behaviour is
 * explainable, predictable, and unit-testable.
 *
 * Signals modelled:
 *   - explicit user feedback (`flagged` star)         -> highest weight
 *   - unread state (`!seen`)                          -> high weight
 *   - sender frequency within the current view        -> "recent contact" proxy
 *   - delivery mode: direct To > CC > bulk            -> how directly it targets me
 *   - keywords in subject/snippet                     -> content salience
 *   - time decay (newer edges out older)              -> freshness
 */

/** Non-letter sender bucket; sorted after A-Z. */
export const NON_LETTER_INITIAL = "#";

/** Per-sender frequency is capped so a flooded list cannot dominate the score. */
const SENDER_FREQUENCY_CAP = 5;
const SENDER_FREQUENCY_PER_OCCURRENCE = 45;
/** Star = explicit user feedback, mirroring Gmail's manual important toggle. */
const STAR_SCORE = 1000;
const UNREAD_SCORE = 320;
const DIRECT_TO_SCORE = 180;
const CC_SCORE = 70;
const BULK_SCORE = 40;
const KEYWORD_MATCH_CAP = 2;
const KEYWORD_MATCH_SCORE = 110;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_TIER_DAY = 90;
const TIME_TIER_WEEK = 55;
const TIME_TIER_MONTH = 25;

/** Small built-in Chinese/English dictionary; intentionally not exhaustive. */
const IMPORTANCE_KEYWORDS = [
  "urgent",
  "asap",
  "important",
  "invoice",
  "billing",
  "payment",
  "confirm",
  "verify",
  "password",
  "security",
  "alert",
  "紧急",
  "重要",
  "发票",
  "账单",
  "确认",
  "验证",
  "回复",
];

export type ImportanceContext = {
  /** Messages in the current view; used for sender-frequency statistics. */
  messages: readonly Message[];
  /** The user's own account email addresses (lower-cased) for To/CC matching. */
  accountEmails: ReadonlySet<string>;
  /** Injectable clock for deterministic tests; defaults to `Date.now()`. */
  now?: number;
};

/** The sender's display name, falling back to the raw address when unnamed. */
export function senderDisplay(message: Message): string {
  const name = message.from.name.trim();
  return name || message.from.address;
}

/**
 * Single-letter bucket for A-Z senders; everything else (digits, symbols,
 * CJK, missing) is collapsed into {@link NON_LETTER_INITIAL} and sorts last.
 */
export function senderInitial(message: Message): string {
  const first = senderDisplay(message).trim().charAt(0);
  if (!first) return NON_LETTER_INITIAL;
  const upper = first.toUpperCase();
  return /^[A-Z]$/.test(upper) ? upper : NON_LETTER_INITIAL;
}

function timeBandScore(sentAt: string, now: number): number {
  const age = Math.max(0, now - new Date(sentAt).getTime());
  if (age < DAY_MS) return TIME_TIER_DAY;
  if (age < 7 * DAY_MS) return TIME_TIER_WEEK;
  if (age < 30 * DAY_MS) return TIME_TIER_MONTH;
  return 0;
}

function senderFrequencyCounts(messages: readonly Message[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const key = message.from.address.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function scoreWithFrequency(message: Message, ctx: ImportanceContext, frequency: number): number {
  let score = 0;

  if (message.flagged) score += STAR_SCORE;
  if (!message.seen) score += UNREAD_SCORE;

  // Delivery mode: a direct To targeting my own address ranks above being CC'd,
  // which in turn ranks above bulk/unsolicited mail.
  const toAddresses = message.to.map((address) => address.address.toLowerCase());
  const ccAddresses = message.cc.map((address) => address.address.toLowerCase());
  const ccEmail = (address: string) => ctx.accountEmails.has(address);
  if (toAddresses.some(ccEmail)) score += DIRECT_TO_SCORE;
  else if (ccAddresses.some(ccEmail)) score += CC_SCORE;
  else score += BULK_SCORE;

  // Sender frequency approximates Gmail's "recent/frequent contacts".
  score += Math.min(frequency, SENDER_FREQUENCY_CAP) * SENDER_FREQUENCY_PER_OCCURRENCE;

  // Keyword scan is limited to subject + snippet; large bodies are never parsed.
  const haystack = `${message.subject} ${message.snippet}`.toLowerCase();
  let hits = 0;
  for (const keyword of IMPORTANCE_KEYWORDS) {
    if (hits >= KEYWORD_MATCH_CAP) break;
    if (haystack.includes(keyword)) hits += 1;
  }
  score += hits * KEYWORD_MATCH_SCORE;

  score += timeBandScore(message.sentAt, ctx.now ?? Date.now());
  return score;
}

/** Weighted importance score for a single message; higher means more important. */
export function computeImportanceScore(message: Message, ctx: ImportanceContext): number {
  const counts = senderFrequencyCounts(ctx.messages);
  const frequency = counts.get(message.from.address.toLowerCase()) ?? 1;
  return scoreWithFrequency(message, ctx, frequency);
}

function timeDesc(left: Message, right: Message): number {
  return new Date(right.sentAt).getTime() - new Date(left.sentAt).getTime();
}

function initialBucket(initial: string): number {
  return initial === NON_LETTER_INITIAL ? 26 : initial.charCodeAt(0) - "A".charCodeAt(0);
}

function compareSender(left: Message, right: Message): number {
  const bucketDiff = initialBucket(senderInitial(left)) - initialBucket(senderInitial(right));
  if (bucketDiff !== 0) return bucketDiff;
  // Within one letter bucket, newest first (ties break deterministically).
  return timeDesc(left, right);
}

/**
 * Unified sorting entry point. `newest`/`oldest` keep the historical time
 * ordering; `sender` groups by first letter A-Z (non-letters last) with the
 * newest first inside each group; `importance` ranks by score descending,
 * falling back to newest first when scores tie.
 */
export function sortMessages(
  messages: readonly Message[],
  order: MessageListSortOrder,
  ctx: ImportanceContext,
): Message[] {
  if (order === "sender") return [...messages].sort(compareSender);
  if (order === "newest" || order === "oldest") {
    return [...messages].sort((left, right) => (order === "newest" ? timeDesc(left, right) : -timeDesc(left, right)));
  }
  // Importance: build the sender-frequency table once, then rank in one pass.
  const counts = senderFrequencyCounts(messages);
  const scores = new Map<string, number>();
  for (const message of messages) {
    const frequency = counts.get(message.from.address.toLowerCase()) ?? 1;
    scores.set(message.id, scoreWithFrequency(message, ctx, frequency));
  }
  return [...messages].sort((left, right) => {
    const scoreDiff = (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return timeDesc(left, right);
  });
}
