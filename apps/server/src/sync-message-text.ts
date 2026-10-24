/**
 * The pure text transforms a synced message passes through before it is stored:
 * address flattening, Message-ID extraction, HTML-to-text and snippet clipping.
 *
 * Split out of sync.ts (a frozen-size monolith). None of these read the
 * database or the provider, which is what makes them safe to share with the
 * parsers that need the same spelling without importing the sync engine.
 */
import type { AddressObject } from "mailparser";
import { redactUrls } from "./message-links.js";

export function addressValues(address: AddressObject | AddressObject[] | undefined): Array<{ name: string; address: string }> {
  if (!address) return [];
  return (Array.isArray(address) ? address : [address]).flatMap((item) =>
    item.value.map((entry) => ({ name: entry.name ?? "", address: entry.address ?? "" })),
  );
}

const messageIdPattern = /<[^<>\r\n]{1,998}>/g;

export function messageIdValues(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const ids = values.flatMap((item) => item.match(messageIdPattern) ?? []);
  return [...new Set(ids)].slice(-50);
}

const SNIPPET_MAX_LENGTH = 150;

const htmlEntityMap: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#(x[0-9a-fA-F]+|\d+)|([a-zA-Z]+));/g, (whole, numeric: string | undefined, name: string | undefined) => {
    if (numeric) {
      const codePoint = numeric.startsWith("x") || numeric.startsWith("X")
        ? Number.parseInt(numeric.slice(1), 16)
        : Number.parseInt(numeric, 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try { return String.fromCodePoint(codePoint); } catch { return whole; }
    }
    return name && htmlEntityMap[name.toLowerCase()] !== undefined ? htmlEntityMap[name.toLowerCase()]! : whole;
  });
}

export function htmlToSnippetText(html: string): string {
  let text = html;
  // Strip non-visible blocks first so their content doesn't leak into the snippet.
  text = text.replace(/<(script|style|head|noscript|svg)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  // Strip all remaining HTML tags.
  text = text.replace(/<[^>]+>/g, " ");
  // Decode HTML entities and collapse whitespace.
  text = decodeHtmlEntities(text).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return text;
}

export function snippet(value: string): string {
  // Redact URLs up front so raw links never land in the stored snippet; the
  // neutral sentinel is rendered as a localized label by the consumer.
  const compact = redactUrls(value.replace(/\s+/g, " ").trim());
  return compact.length <= SNIPPET_MAX_LENGTH ? compact : `${compact.slice(0, SNIPPET_MAX_LENGTH).trimEnd()}…`;
}
