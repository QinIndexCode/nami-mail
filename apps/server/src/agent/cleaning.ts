import { createHash } from "node:crypto";

export const MAIL_CLEANER_VERSION = "nami-mail-cleaner-v1";
export const DEFAULT_MAX_CLEANED_MAIL_CHARACTERS = 120_000;

export type MailCleaningInput = {
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  maxCharacters?: number;
};

export type CleanedMailContent = {
  cleanerVersion: typeof MAIL_CLEANER_VERSION;
  normalizedSubject: string;
  text: string;
  contentHash: string;
  source: "text" | "html" | "empty";
  truncated: boolean;
  removedQuotedContent: boolean;
  removedSignatureOrDisclaimer: boolean;
};

function normalizeCharacters(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .normalize("NFC");
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(/&(?:#(x[0-9a-fA-F]+|\d+)|([a-zA-Z]+));/g, (whole, numeric: string | undefined, name: string | undefined) => {
    if (numeric) {
      const codePoint = numeric.startsWith("x") || numeric.startsWith("X")
        ? Number.parseInt(numeric.slice(1), 16)
        : Number.parseInt(numeric, 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    return name && named[name.toLowerCase()] !== undefined ? named[name.toLowerCase()]! : whole;
  });
}

function removeHiddenHtml(value: string): string {
  // Repeat a bounded number of passes so nested hidden nodes are removed while
  // malformed untrusted HTML cannot make the cleaner loop indefinitely.
  let result = value;
  const hiddenNode = /<([a-z][\w:-]*)(?=[^>]*(?:\bhidden\b|\baria-hidden\s*=\s*(?:"true"|'true'|true)|\bstyle\s*=\s*(?:"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"|'[^']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^']*')))[^>]*>[\s\S]*?<\/\1\s*>/gi;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = result.replace(hiddenNode, "");
    if (next === result) break;
    result = next;
  }
  return result;
}

/** Converts a constrained email-HTML subset into readable text without rendering it. */
export function htmlToMailText(html: string): string {
  let value = normalizeCharacters(html);
  value = value.replace(/<!--[\s\S]*?-->/g, "");
  value = value.replace(/<(script|style|template|noscript|iframe|object|embed|canvas|svg|form|input|button|select|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  value = value.replace(/<(script|style|template|noscript|iframe|object|embed|canvas|svg|form|input|button|select|textarea)\b[^>]*\/?\s*>/gi, "");
  value = removeHiddenHtml(value);
  // Images are not semantic mail text. Dropping them also removes tracking
  // pixels and their URLs before any data leaves the local process.
  value = value.replace(/<img\b[^>]*>/gi, "");
  value = value.replace(/<(?:br|hr)\b[^>]*>/gi, "\n");
  value = value.replace(/<\/?(?:p|div|section|article|header|footer|main|aside|blockquote|pre|h[1-6])\b[^>]*>/gi, "\n");
  value = value.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, "\n");
  value = value.replace(/<li\b[^>]*>/gi, "\n- ");
  value = value.replace(/<\/li\s*>/gi, "");
  value = value.replace(/<tr\b[^>]*>/gi, "\n");
  value = value.replace(/<\/?(?:td|th)\b[^>]*>/gi, " | ");
  value = value.replace(/<\/tr\s*>/gi, "");
  value = value.replace(/<[^>]+>/g, "");
  return decodeEntities(value)
    .replace(/[ \t]*\|[ \t]*(?:\|[ \t]*)+/g, " | ")
    .replace(/(^|\n)[ \t]*\|[ \t]*/g, "$1")
    .replace(/[ \t]*\|[ \t]*(?=\n|$)/g, "");
}

function stripTrackingParameters(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
    try {
      const parsed = new URL(url);
      for (const key of [...parsed.searchParams.keys()]) {
        const lowered = key.toLowerCase();
        if (lowered.startsWith("utm_") || ["fbclid", "gclid", "mc_cid", "mc_eid", "_hsenc", "_hsmi"].includes(lowered)) {
          parsed.searchParams.delete(key);
        }
      }
      return parsed.toString();
    } catch {
      return url;
    }
  });
}

function looksLikeQuoteBoundary(line: string): boolean {
  const trimmed = line.trim();
  return /^on .+wrote:$/i.test(trimmed)
    || /^-{2,}\s*(?:original message|forwarded message)\s*-{2,}$/i.test(trimmed)
    || /^begin forwarded message:$/i.test(trimmed)
    || /^发件人[:：].+$/i.test(trimmed)
    || /^在 .+ 写道[:：]$/i.test(trimmed);
}

function removeQuotedContent(value: string): { text: string; removed: boolean } {
  const lines = value.split("\n");
  const output: string[] = [];
  let removed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*>/.test(line)) {
      removed = true;
      continue;
    }
    if (looksLikeQuoteBoundary(line) && output.some((existing) => existing.trim().length > 0)) {
      removed = true;
      break;
    }
    output.push(line);
  }
  return { text: output.join("\n"), removed };
}

function isDisclaimerLine(line: string): boolean {
  const normalized = line.replace(/\s+/g, " ").trim();
  return /^(?:this (?:e-?mail|message).{0,180}(?:confidential|intended only|attachments)|please consider the environment before printing|本邮件(?:及附件)?.{0,180}(?:保密|仅供|机密)|此电子邮件(?:及附件)?.{0,180}(?:保密|仅供|机密))/i.test(normalized);
}

function removeSignatureAndDisclaimer(value: string): { text: string; removed: boolean } {
  const lines = value.split("\n");
  let cutAt = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if ((line.trim() === "--" || line.trim() === "__") && lines.slice(0, index).some((entry) => entry.trim())) {
      cutAt = index;
      break;
    }
    if (isDisclaimerLine(line) && lines.slice(0, index).some((entry) => entry.trim())) {
      cutAt = index;
      break;
    }
  }
  return { text: lines.slice(0, cutAt).join("\n"), removed: cutAt < lines.length };
}

function normalizeWhitespace(value: string): string {
  const uniqueParagraphs: string[] = [];
  let previous = "";
  for (const rawParagraph of value.split(/\n{2,}/)) {
    const paragraph = rawParagraph
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
      .join("\n")
      .trim();
    if (!paragraph) continue;
    const key = paragraph.replace(/\s+/g, " ").toLocaleLowerCase();
    if (key === previous) continue;
    uniqueParagraphs.push(paragraph);
    previous = key;
  }
  return uniqueParagraphs.join("\n\n").trim();
}

function truncateAtBoundary(value: string, maximum: number): { text: string; truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false };
  const prefix = value.slice(0, maximum);
  const boundary = Math.max(prefix.lastIndexOf("\n\n"), prefix.lastIndexOf(". "), prefix.lastIndexOf("。"), prefix.lastIndexOf("\n"));
  const cut = boundary >= Math.floor(maximum * 0.55) ? boundary : maximum;
  return { text: `${value.slice(0, cut).trimEnd()}\n\n[Content truncated locally]`, truncated: true };
}

function contentHash(value: string): string {
  return `sha256.${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}

/**
 * Cleans a copy for RAG only. It never changes the original encrypted mail
 * payload and deliberately prefers a meaningful plain-text alternative.
 */
export function cleanMailContent(input: MailCleaningInput): CleanedMailContent {
  const maximum = input.maxCharacters ?? DEFAULT_MAX_CLEANED_MAIL_CHARACTERS;
  if (!Number.isSafeInteger(maximum) || maximum < 256 || maximum > 2_000_000) {
    throw new Error("Mail cleaning maximum is invalid.");
  }
  const subject = normalizeWhitespace(normalizeCharacters(input.subject ?? "")).replace(/\n+/g, " ");
  const plain = normalizeCharacters(input.textBody ?? "");
  const html = input.htmlBody ? htmlToMailText(input.htmlBody) : "";
  const source = plain.trim() ? "text" : html.trim() ? "html" : "empty";
  const raw = source === "text" ? plain : html;
  if (source === "empty") {
    return {
      cleanerVersion: MAIL_CLEANER_VERSION,
      normalizedSubject: subject,
      text: "",
      contentHash: contentHash(""),
      source,
      truncated: false,
      removedQuotedContent: false,
      removedSignatureOrDisclaimer: false,
    };
  }
  const withoutTracking = stripTrackingParameters(raw);
  const quote = removeQuotedContent(withoutTracking);
  const signature = removeSignatureAndDisclaimer(quote.text);
  const normalized = normalizeWhitespace(signature.text);
  const truncated = truncateAtBoundary(normalized, maximum);
  return {
    cleanerVersion: MAIL_CLEANER_VERSION,
    normalizedSubject: subject,
    text: truncated.text,
    contentHash: contentHash(truncated.text),
    source,
    truncated: truncated.truncated,
    removedQuotedContent: quote.removed,
    removedSignatureOrDisclaimer: signature.removed,
  };
}
