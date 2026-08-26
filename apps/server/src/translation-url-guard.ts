/**
 * URL protection for machine translation.
 *
 * A message body that is mostly URLs (e.g. a list of links) would be mangled by
 * a translation provider — Google/MyMemory may insert spaces inside the scheme,
 * split a link across a chunk boundary, or partially translate parts of it. This
 * is the same problem browsers solve when translating web pages: the strategy
 * (used by Gmail and Chrome) is to *protect* URLs by swapping them for opaque,
 * non-translatable placeholder tokens before sending text to the provider, then
 * restoring the original URLs on the translated output.
 *
 * The placeholders use the private-use character \uE000 as a prefix and carry
 * an index, so they are never translated and survive chunked (split) streaming
 * — a placeholder is a single token that stays within one chunk.
 */

const URL_PATTERN =
  /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]}]/gi;

const PLACEHOLDER_PREFIX = "\uE000";

export type TranslationUrlGuard = {
  /** Text with every URL replaced by a placeholder token. */
  text: string;
  /** The original URLs, in placeholder order. */
  urls: string[];
  /** True when at least one URL was present. */
  hasUrls: boolean;
};

function placeholderFor(index: number): string {
  return `${PLACEHOLDER_PREFIX}URL${index}${PLACEHOLDER_PREFIX}`;
}

/** Extracts every URL and replaces it with a non-translatable placeholder. */
export function protectTranslationUrls(text: string): TranslationUrlGuard {
  const urls: string[] = [];
  const matches = text.match(URL_PATTERN);
  if (!matches || matches.length === 0) {
    return { text, urls, hasUrls: false };
  }
  const seen = new Map<string, string>();
  let nextIndex = 0;
  const protectedText = text.replace(URL_PATTERN, (match) => {
    let token = seen.get(match);
    if (!token) {
      token = placeholderFor(nextIndex);
      seen.set(match, token);
      urls.push(match);
      nextIndex += 1;
    }
    return token;
  });
  return { text: protectedText, urls, hasUrls: true };
}

/**
 * Restores the original URLs into a translated string. Placeholders that the
 * provider dropped, moved, or that no longer appear (e.g. the translation was
 * rewritten) are left as-is to avoid corrupting the output.
 */
export function restoreTranslationUrls(translatedText: string, urls: string[], guardedText: string, appendMissing = true): string {
  if (urls.length === 0) return translatedText;
  let restored = translatedText;
  for (let index = 0; index < urls.length; index++) {
    const token = placeholderFor(index);
    restored = restored.split(token).join(urls[index]!);
  }
  // If a provider collapsed/removed placeholders, append any that did not
  // round-trip so the links are not silently lost. Disabled for streaming LLM
  // output where partial placeholders are expected mid-stream.
  if (!appendMissing) return restored;
  const tokens = guardedText.match(new RegExp(`${PLACEHOLDER_PREFIX}URL\\d+${PLACEHOLDER_PREFIX}`, "g"));
  if (tokens) {
    const missing: string[] = [];
    for (const token of tokens) {
      const match = /URL(\d+)/.exec(token);
      if (match && !restored.includes(urls[Number(match[1])]!)) {
        missing.push(urls[Number(match[1])]!);
      }
    }
    if (missing.length > 0) {
      restored = restored.trimEnd() + "\n\n" + missing.join("\n");
    }
  }
  return restored;
}
