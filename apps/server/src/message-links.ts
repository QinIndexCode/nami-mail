/**
 * URL redaction shared by the mail-list snippet pipeline and the Agent search
 * tool. Every detected URL is collapsed into a single neutral sentinel so the
 * stored snippet stays language-neutral; consumers call `localizeLinks` at
 * render/use time to substitute the sentinel with a language-appropriate label
 * (e.g. `[链接]` / `[link]`).
 */

/** Private-use-area char: a single code point that cannot appear in real mail text. */
export const LINK_SENTINEL = "\uE000";

/** Trailing punctuation that belongs to the surrounding sentence, not the URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>]+$/;

/**
 * Common registrable TLDs for the bare-domain matcher. Kept explicit so prose
 * that happens to contain scattered dotted tokens is not over-redacted.
 */
const URL_PATTERNS: readonly RegExp[] = [
  // scheme URLs (http, https, ftp)
  /(?:https?|ftp):\/\/[^\s<>"'(){}\[\]]+/gi,
  // www. prefixed domains
  /(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[^\s<>"'(){}\[\]]*)?/gi,
  // mailto: links
  /(?:mailto:)[^\s<>"']+/gi,
  // bare domains with a common TLD (never inside an email address / hostname)
  /(?<![\w@.])(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|me|dev|info|biz|cc|tv|app|ai|cn)(?:\/[^\s<>"'(){}\[\]]*)?/gi,
];

/** Replaces every URL in `text` with a single sentinel per occurrence. */
export function redactUrls(text: string): string {
  if (!text) return text;
  let result = text;
  for (const pattern of URL_PATTERNS) {
    result = result.replace(pattern, (match: string) => {
      const cleaned = match.replace(TRAILING_PUNCTUATION, "");
      return cleaned.length > 0 ? LINK_SENTINEL : "";
    });
  }
  return result;
}

/** Substitutes redaction sentinels with a localised link label. */
export function localizeLinks(text: string, locale = "en-US"): string {
  if (!text.includes(LINK_SENTINEL)) return text;
  const label = locale.toLowerCase().startsWith("zh") ? "[链接]" : "[link]";
  return text.split(LINK_SENTINEL).join(label);
}