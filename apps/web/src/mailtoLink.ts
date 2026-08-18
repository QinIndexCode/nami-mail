import type { ComposeDraft } from "./mailUi";

/**
 * RFC 6068 mailto link parsing. The desktop registers the mailto protocol and
 * forwards the raw URL, and plain web sessions intercept anchor clicks, so
 * both entry points converge on this single parser.
 *
 * The compose UI has no separate bcc field, so bcc recipients are folded into
 * cc to keep the receiver's intent (these addresses must still receive the
 * message) without silently dropping them.
 */
export function parseMailtoUrl(href: string): Partial<ComposeDraft> | undefined {
  const match = href.trim().match(/^mailto:([^?]*)(?:\?(.*))?$/i);
  if (!match) return undefined;
  const [, addressPart = "", queryPart = ""] = match;

  let params: URLSearchParams | undefined;
  if (queryPart) {
    try {
      params = new URLSearchParams(queryPart);
    } catch {
      params = undefined;
    }
  }

  const to: string[] = [];
  const address = decodeAddress(addressPart);
  if (address) to.push(address);
  if (params) to.push(...params.getAll("to").map(decodeAddress).filter((value): value is string => Boolean(value)));

  const cc = params ? params.getAll("cc").map(decodeAddress).filter((value): value is string => Boolean(value)) : [];
  const bcc = params ? params.getAll("bcc").map(decodeAddress).filter((value): value is string => Boolean(value)) : [];

  const draft: Partial<ComposeDraft> = {};
  if (to.length > 0) draft.to = to.join(", ");
  if (cc.length > 0 || bcc.length > 0) draft.cc = [...cc, ...bcc].join(", ");
  const subject = params?.get("subject");
  if (subject) draft.subject = subject;
  const body = params?.get("body");
  if (body) draft.text = body;
  return draft;
}

/** Decodes percent-encoding defensively; a malformed sequence stays as-is. */
function decodeAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}