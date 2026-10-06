import DOMPurify from "dompurify";
import type { MoveTarget } from "../api";
import type { AttachmentKind } from "../attachmentPresentation";
import { presentAttachment } from "../attachmentPresentation";
import { buildReplyQuote } from "../mailActions";
import { mailBackgroundColor, mailReaderSurface, mailSurfaceForBackground, shouldResetMailForeground, type MailSurface } from "../mailHtmlTheme";
import { isInboxMessage, isArchivedMessage, isSnoozedMessage, type MessageListView } from "../mailListState";
import type { AppSettings } from "../types";
import type { Account, Message } from "../types";
import type { Translate } from "../i18n";

/** Which message list view is active. */
export type MailView = MessageListView;

export const SWITCH_FADE_MS = 240;
export const MAIL_FADE_STAGGER_MS = 60;
export const AGENT_FADE_STAGGER_MS = 80;

// `Intl.DateTimeFormat` construction is not free; per-row-per-frame allocation
// during scrolling is avoidable. Cache one formatter per locale + options pair
// so repeat renders reuse it instead of rebuilding it every time. The key
// carries the serialised options because several distinct variants are in play
// (time-only, day-only, day + year, long form) and they must not share a cache
// slot. Shared by every render path so the mail list, the reader tooltips and
// the agent rows all reuse the same instances.
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export function dateTimeFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  const cached = dateTimeFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, options);
  dateTimeFormatters.set(key, formatter);
  return formatter;
}

export function formatMessageTime(value: string, locale: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return dateTimeFormatter(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  const sameYear = date.getFullYear() === now.getFullYear();
  return dateTimeFormatter(locale, sameYear ? { month: "numeric", day: "numeric" } : { year: "2-digit", month: "numeric", day: "numeric" }).format(date);
}

export function formatFullDate(value: string, locale: string): string {
  return dateTimeFormatter(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/** Private-use-area sentinel the server stores in place of redacted URLs. */
const LINK_SENTINEL = "\uE000";

/**
 * Substitutes link-redaction sentinels with a language-appropriate label. The
 * server persists a language-neutral sentinel (see server message-links.ts); at
 * render time we swap it for "[链接]" / "[link]" just like the Agent path does.
 */
export function localizeMessageLinks(text: string, locale: string): string {
  if (!text.includes(LINK_SENTINEL)) return text;
  const label = locale.toLowerCase().startsWith("zh") ? "[链接]" : "[link]";
  return text.split(LINK_SENTINEL).join(label);
}

export function formatSyncFreshness(value: string | null, t: Translate): string {
  if (!value) return t("mail.sync.never");
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 60) return t("mail.sync.justNow");
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return t(elapsedMinutes === 1 ? "mail.sync.minuteAgo" : "mail.sync.minutesAgo", { count: elapsedMinutes });
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return t(elapsedHours === 1 ? "mail.sync.hourAgo" : "mail.sync.hoursAgo", { count: elapsedHours });
  const elapsedDays = Math.floor(elapsedHours / 24);
  return t(elapsedDays === 1 ? "mail.sync.dayAgo" : "mail.sync.daysAgo", { count: elapsedDays });
}

export function buildMessageQuery({
  accountId,
  folder,
  search,
  messageView,
  searchScope,
  attachmentKind,
  after,
  before,
  cursor,
}: {
  accountId: string;
  folder: string;
  search: string;
  messageView: MailView;
  searchScope: "view" | "all";
  attachmentKind?: AttachmentKind;
  after?: string;
  before?: string;
  /**
   * Where this page resumes from — the `nextCursor` of the page before it,
   * echoed back verbatim. Absent for the first page. This replaces the old
   * `page` number: an offset shifts by one every time mail arrives above it,
   * so a scroll-through could skip rows outright, while a position in the
   * list's order cannot be pushed around.
   */
  cursor?: string;
}): string {
  const query = new URLSearchParams({ pageSize: "100" });
  if (cursor) query.set("cursor", cursor);
  const globalSearch = searchScope === "all" && search.trim() !== "";
  if (!globalSearch) {
    if (accountId !== "all") query.set("accountId", accountId);
    if (folder) query.set("folder", folder);
    if (messageView === "starred") query.set("starred", "1");
    if (messageView === "unread") query.set("unread", "1");
    if (messageView === "archived") query.set("archived", "1");
    if (messageView === "snoozed") query.set("snoozed", "1");
    if (messageView === "attachments") query.set("hasAttachments", "1");
  }
  if (attachmentKind) query.set("attachmentKind", attachmentKind);
  if (after) query.set("after", after);
  if (before) query.set("before", before);
  if (search.trim()) {
    query.set("q", search.trim());
    if (globalSearch) query.set("scope", "all");
  }
  return query.toString();
}

export function demoMessageTotal(messages: readonly Message[], accounts: readonly Account[], {
  accountId,
  folder,
  search,
  messageView,
  searchScope,
  attachmentKind,
  after,
  before,
}: {
  accountId: string;
  folder: string;
  search: string;
  messageView: MailView;
  searchScope: "view" | "all";
  attachmentKind?: AttachmentKind;
  after?: string;
  before?: string;
}): number {
  const normalizedQuery = search.trim().toLowerCase();
  return messages.filter((message) => {
    if (!(searchScope === "all" && normalizedQuery)) {
      if (accountId !== "all" && message.accountId !== accountId) return false;
      if (folder && message.mailbox !== folder) return false;
      if (!folder && messageView === "inbox" && !isInboxMessage(message, accounts)) return false;
      if (messageView === "unread" && message.seen) return false;
      if (messageView === "starred" && !message.flagged) return false;
      if (messageView === "archived" && !isArchivedMessage(message, accounts)) return false;
      if (messageView === "snoozed" && !isSnoozedMessage(message)) return false;
      if (messageView === "attachments" && !message.hasAttachments) return false;
    }
    if (attachmentKind
      && !message.attachments.some((item) => presentAttachment(item.filename, item.contentType).kind === attachmentKind)) {
      return false;
    }
    if (after || before) {
      const sentTime = new Date(message.sentAt).getTime();
      if (!Number.isFinite(sentTime)) return false;
      if (after && sentTime < new Date(after).getTime()) return false;
      if (before && sentTime >= new Date(before).getTime()) return false;
    }
    if (normalizedQuery && !`${message.subject} ${message.from.name} ${message.from.address} ${message.snippet}`.toLowerCase().includes(normalizedQuery)) return false;
    return true;
  }).length;
}

export function isCompactMailLayout(): boolean {
  return window.matchMedia("(max-width: 620px)").matches;
}

export const moveTargetSpecialUses: Record<MoveTarget, string[]> = {
  archive: ["\\Archive", "\\All"],
  trash: ["\\Trash"],
  junk: ["\\Junk"],
  inbox: ["\\Inbox"],
};

export function moveActionKey(target: MoveTarget, selection: boolean): string {
  if (selection) {
    return target === "archive" ? "mail.selection.archived" : target === "trash" ? "mail.selection.trashed" : "mail.selection.reportedSpam";
  }
  return target === "archive" ? "mail.action.archived" : target === "trash" ? "mail.action.trashed" : target === "junk" ? "mail.action.reportedSpam" : "mail.action.recoveredFromSpam";
}

export function demoMoveDestination(accounts: readonly Account[], accountId: string, target: MoveTarget): string {
  const folders = accounts.find((account) => account.id === accountId)?.folders ?? [];
  for (const specialUse of moveTargetSpecialUses[target]) {
    const folder = folders.find((item) => item.specialUse === specialUse);
    if (folder) return folder.path;
  }
  return "";
}

export function currentSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(preference: AppSettings["theme"], systemTheme: "light" | "dark"): "light" | "dark" {
  return preference === "system" ? systemTheme : preference;
}

export function backgroundUrl(settings: AppSettings): string | null {
  if (settings.backgroundPreset === "custom") return settings.customBackgroundUrl;
  if (settings.backgroundPreset === "none") return null;
  return `/backgrounds/${settings.backgroundPreset}.svg`;
}

export type AttachmentDownloadState = {
  phase: "downloading" | "ready" | "error";
  detail?: string;
};

export const MAX_LLM_TRANSLATION_TEXT_LENGTH = 50_000;

export function sanitizeMailHtml(html: string, darkMode: boolean): string {
  const clean = DOMPurify.sanitize(html, {
    // Defense in depth, not a fix for a known hole: DOMPurify's defaults already
    // drop on* handlers and javascript: URIs. The point of USE_PROFILES is to shrink
    // the surface a future sanitizer bug could reach — the body is parsed and
    // re-serialized three more times below, and every parse-serialize round trip is
    // another chance for markup to mutate.
    //
    // MathML is NOT re-enabled: it has no place in a mail body at all, and its
    // text-integration points are exactly how mutation XSS gets in (an
    // <mtext>/<mglyph> subtree re-parses into different markup on the next pass).
    // The html profile keeps every layout tag real mail relies on (table/thead/
    // tbody/tr/td/th, font, center, div, span, p, ul/ol/li, hr, blockquote,
    // pre/code, h1-h6, a, img) and every legacy presentational attribute
    // (bgcolor, background, align, valign, width, height, cellpadding, cellspacing,
    // border, color, face, size, nowrap, style) — the surface/color walk below reads
    // those attributes, so they must survive.
    //
    // The svg profile IS enabled, deliberately. Dropping the SVG *element* also
    // drops its whole subtree INCLUDING its text: a mail whose visible content is
    // an inline SVG (a <text> label, a signature chart) renders as a blank block,
    // which is a worse outcome than the surface it costs. SVG is not a free pass —
    // DOMPurify's svg set already excludes the dangerous elements (script, use,
    // animate, set, foreignObject; see svgDisallowed in purify.js), and the three
    // entries appended to FORBID_TAGS below close the rest. Verified against the
    // adversarial set in app-utils.test.ts ("adversarial SVG and MathML").
    //
    // ALLOWED_TAGS is deliberately absent: USE_PROFILES *overwrites* ALLOWED_TAGS
    // (purify.js resolves ALLOWED_TAGS first, then replaces it with the profile set),
    // so passing both would leave a hand-written list silently inert. The html+svg
    // profiles are themselves curated allow-lists and are what keep mail layout
    // intact.
    USE_PROFILES: { html: true, svg: true },
    // "script", "style", "iframe", "object", "embed" and "form" do the actual
    // stripping the html profile alone would not (its tag set contains "style"
    // and "form"); the rest are redundant today and stay as an explicit statement
    // of intent that survives future DOMPurify changes.
    //
    // The three animation elements are the SVG profile's real gap and are NOT
    // redundant. `<animateColor attributeName="HREF" values="//evil">` rewrites a
    // link target at render time with no javascript: URI to block: DOMPurify only
    // strips `attributeName` when its value matches "href" case-sensitively
    // (purify.js:2213), so an uppercase "HREF" slips past and the animation
    // survives with its payload. Same trick reaches `to=` on animateTransform.
    // None of the three renders anything on its own, so dropping them costs a mail
    // body nothing and closes the vector outright.
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "animateColor", "animateMotion", "animateTransform"],
    // USE_PROFILES *overwrites* ALLOWED_ATTR (purify.js:1353), so the html
    // profile's table has no "target" — an <a target="_blank"> silently loses it
    // and the mail's external links fall back to replacing the reader's own tab.
    // ADD_ATTR is applied AFTER the profile merge (purify.js:1383), so it is not
    // overwritten and cannot widen the tag surface. target is inert without a
    // scripting context: it only tells the browser which browsing context to
    // navigate, so allowing it grants no new capability.
    ADD_ATTR: ["target"],
  });

  const template = document.createElement("template");
  template.innerHTML = clean;
  const elements = [...template.content.querySelectorAll("*")];
  for (const element of elements) {
    const styled = element as HTMLElement;
    styled.style?.removeProperty("user-select");
    styled.style?.removeProperty("-webkit-user-select");
    element.removeAttribute("data-nami-mail-surface");
  }
  const surfaceByElement = new Map<Element, MailSurface>();
  for (const element of elements) {
    const styled = element as HTMLElement;
    const surface = mailSurfaceForBackground(mailBackgroundColor(
      styled.style?.getPropertyValue("background-color") || styled.style?.backgroundColor,
      styled.style?.getPropertyValue("background") || styled.style?.background,
      element.getAttribute("bgcolor") || element.getAttribute("background"),
    ));
    if (!surface) continue;
    surfaceByElement.set(element, surface);
    element.setAttribute("data-nami-mail-surface", surface.tone);
  }

  const readerSurface = mailReaderSurface(darkMode ? "dark" : "light");
  const nearestSurface = (element: Element): MailSurface => {
    let current: Element | null = element;
    while (current) {
      const surface = surfaceByElement.get(current);
      if (surface) return surface;
      current = current.parentElement;
    }
    return readerSurface;
  };

  for (const element of elements) {
    const styled = element as HTMLElement;
    const surface = nearestSurface(element);
    const foregrounds = [
      { value: styled.style?.getPropertyValue("-webkit-text-fill-color") ?? "", reset: () => styled.style?.removeProperty("-webkit-text-fill-color") },
      { value: styled.style?.getPropertyValue("color") ?? "", reset: () => styled.style?.removeProperty("color") },
      { value: element.getAttribute("color") ?? "", reset: () => element.removeAttribute("color") },
    ].filter((foreground) => Boolean(foreground.value));
    const minimumContrast = element.closest("a") ? 3 : undefined;
    const readableForeground = foregrounds.some((foreground) => !shouldResetMailForeground(foreground.value, surface, minimumContrast));
    for (const foreground of foregrounds) {
      if (shouldResetMailForeground(foreground.value, surface, minimumContrast)) foreground.reset();
    }
    if (!darkMode && surfaceByElement.get(element)?.tone === "dark" && !readableForeground) {
      styled.style?.setProperty("color", "#f5f5f6");
      styled.style?.setProperty("-webkit-text-fill-color", "#f5f5f6");
      styled.style?.setProperty("color-scheme", "dark");
    }
  }
  return template.innerHTML;
}

export function textFromSanitizedMailHtml(html: string): string {
  if (!html) return "";
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.textContent ?? "";
}

/** Same-origin path of the server-side external image proxy
 *  (GET /api/images/proxy, apps/server/src/routes/messages.ts). */
export const IMAGE_PROXY_PATH = "/api/images/proxy";

/**
 * The proxied form of one image source, or `null` when the source must be left
 * exactly as it is.
 *
 * Left untouched, in one bucket or another:
 * - every non-http(s) scheme — `data:` (inline images and BIMI), `cid:`, `blob:`;
 * - anything already resolving against this app's own origin. That covers the
 *   inline-attachment endpoint the server rewrites `cid:` to
 *   (/api/messages/:id/inline/:partId), and an already-proxied body — which is
 *   what makes this function safe to apply more than once.
 *
 * Everything else is a fetch the mail author chose and the reader's network
 * would perform under its own IP, so the proxy takes it over instead. The URL is
 * resolved against the document first so a protocol-relative `//host/pixel`
 * arrives at the proxy as an absolute URL the server can parse at all.
 */
function proxiedImageSource(source: string): string | null {
  const value = source.trim();
  if (!value) return null;
  let resolved: URL;
  try {
    resolved = new URL(value, document.baseURI);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  if (resolved.origin === window.location.origin) return null;
  return `${IMAGE_PROXY_PATH}?url=${encodeURIComponent(resolved.href)}`;
}

/** Rewrites every candidate URL in an `img[srcset]`. `srcset` is what the
 *  browser fetches from whenever it is present, so leaving it alone keeps the
 *  leak wide open behind a proxied `src`.
 *
 *  Candidates follow the HTML srcset parsing algorithm rather than a split on
 *  commas: a URL is the run of characters up to the next whitespace, and it only
 *  ends a candidate when it ends in a comma. Splitting naively would tear a
 *  `data:image/png;base64,AAA=` candidate in half, because that comma belongs to
 *  the URL. */
function rewriteImageSrcset(srcset: string): string {
  const candidates: string[] = [];
  let rest = srcset;
  while (rest.trim()) {
    rest = rest.replace(/^[\t\n\f\r ]+/, "");
    if (!rest) break;
    const urlEnd = rest.search(/[\t\n\f\r ]/);
    let url = urlEnd === -1 ? rest : rest.slice(0, urlEnd);
    let tail = urlEnd === -1 ? "" : rest.slice(urlEnd);
    const trailingCommas = url.match(/,+$/)?.[0] ?? "";
    let descriptor = "";
    if (trailingCommas) {
      url = url.slice(0, -trailingCommas.length);
    } else {
      const descriptorEnd = tail.search(/,/);
      descriptor = descriptorEnd === -1 ? tail : tail.slice(0, descriptorEnd);
      tail = descriptorEnd === -1 ? "" : tail.slice(descriptorEnd + 1);
    }
    if (url) candidates.push(`${proxiedImageSource(url) ?? url}${descriptor}`);
    rest = tail;
  }
  // The encoded proxy URL contains neither a comma nor whitespace, so ", " is
  // always a safe separator here.
  return candidates.length ? candidates.join(", ") : srcset;
}

/** `url(...)` inside an inline style attribute. The replacement is always
 *  double-quoted: encodeURIComponent leaves `'()*!` unescaped, so a bare
 *  parenthesised URL could otherwise break the CSS it is spliced into. */
const CSS_URL_FUNCTION = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi;

/**
 * Routes a mail body's remote images through the server-side image proxy.
 *
 * Opening a mail is itself a disclosure: an `<img src="https://tracker/pixel">`
 * that the renderer fetches directly hands the sender the reader's public IP,
 * the exact open time, and the read receipt that no further interaction is
 * needed to confirm. The proxy already exists and already fail-closed on the
 * server (address allow-list, DNS rebinding caught at resolve time, per-hop
 * redirect re-checks, byte and wall-clock ceilings), but nothing called it, so
 * the images went direct.
 *
 * Applied AFTER `sanitizeMailHtml`, whose DOMPurify pass must keep its own
 * configuration untouched. Kept as a separate export so that contract stays
 * single-purpose and both render paths (the reader body and the translation
 * pipeline that replaces it) opt in explicitly.
 *
 * Runs over every attribute through which a mail body can trigger a remote
 * fetch, not just `img[src]`: `srcset` alone would otherwise bypass an
 * src-only rewrite, and a `background` attribute, a `style` url() or an SVG
 * `image` is the same pixel by another name.
 */
export function rewriteRemoteImagesToProxy(html: string): string {
  if (!html) return html;
  const template = document.createElement("template");
  template.innerHTML = html;

  for (const image of template.content.querySelectorAll("img")) {
    const proxied = proxiedImageSource(image.getAttribute("src") || "");
    if (proxied) image.setAttribute("src", proxied);
    const srcset = image.getAttribute("srcset");
    if (srcset) {
      const rewritten = rewriteImageSrcset(srcset);
      if (rewritten !== srcset) image.setAttribute("srcset", rewritten);
    }
  }
  // SVG <image> carries its URL on href/xlink:href rather than src.
  for (const image of template.content.querySelectorAll("image")) {
    for (const attribute of ["href", "xlink:href"]) {
      const proxied = proxiedImageSource(image.getAttribute(attribute) || "");
      if (proxied) image.setAttribute(attribute, proxied);
    }
  }
  for (const element of template.content.querySelectorAll("[background]")) {
    const proxied = proxiedImageSource(element.getAttribute("background") || "");
    if (proxied) element.setAttribute("background", proxied);
  }
  for (const element of template.content.querySelectorAll("[style]")) {
    const style = element.getAttribute("style") || "";
    const rewritten = style.replace(CSS_URL_FUNCTION, (match, _quote: string, url: string) => {
      const proxied = proxiedImageSource(url);
      return proxied ? `url("${proxied}")` : match;
    });
    if (rewritten !== style) element.setAttribute("style", rewritten);
  }

  return template.innerHTML;
}

/** Quote markers that identify quoted message bodies inside sanitized HTML.
 *  Gmail wraps its quotes in a gmail_quote div (with the "On … wrote:"
 *  attribution inside); most other clients emit plain blockquotes. */
const QUOTE_WRAPPER_SELECTOR = "blockquote, div.gmail_quote";

/** Folds the outermost quoted blocks of a sanitized HTML body into native
 *  <details> elements so long reply chains collapse to a one-line toggle
 *  (Gmail-style "Show quoted text"). Runs AFTER sanitization and only on the
 *  already-safe string. Nested quotes are left untouched — their outer fold
 *  hides them anyway, and doubly-nested toggles just add noise. Returns the
 *  input unchanged when there is nothing to fold. */
export function collapseQuotedMailHtml(html: string, summaryLabel: string): string {
  if (!html) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  // Decide the fold set against the pristine tree, then mutate once — doing
  // both interleaved would re-match quotes that a previous pass just nested
  // inside a <details>.
  const foldables = [...template.content.querySelectorAll(QUOTE_WRAPPER_SELECTOR)]
    .filter((element) => !element.parentElement?.closest(QUOTE_WRAPPER_SELECTOR));
  if (!foldables.length) return html;
  for (const element of foldables) {
    const details = document.createElement("details");
    details.className = "mail-quote";
    const summary = document.createElement("summary");
    summary.textContent = summaryLabel;
    details.append(summary);
    element.replaceWith(details);
    details.append(element);
  }
  return template.innerHTML;
}

const QUOTE_LINE_PATTERN = /^\s*>/;
/** Classic separator headers ("----- 原始邮件 -----") that old clients use
 *  instead of "> " prefixes to introduce quoted content. */
const QUOTE_SEPARATOR_PATTERN = /^\s*[-—–]{2,}\s*(?:原始邮件|Original Message)\s*[-——–]{2,}\s*$/i;

/** Splits a plain-text body into its own content and a trailing quoted
 *  block. The fold is deliberately conservative: only a block that runs to
 *  the end of the message is treated as the quote (interleaved replies stay
 *  inline), a separator line swallows everything below it, and the fold
 *  never consumes the whole message. */
export function splitQuotedMailText(text: string): { body: string; quote: string } {
  if (!text) return { body: "", quote: "" };
  const lines = text.split(/\r?\n/);
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  if (end === 0) return { body: text, quote: "" };
  // Walk backwards over the trailing quote-prefixed block, allowing blank
  // lines between quoted paragraphs but not a blank line before a non-quote.
  let quoteStart = end;
  while (quoteStart > 0) {
    const previous = lines[quoteStart - 1];
    if (QUOTE_LINE_PATTERN.test(previous)) {
      quoteStart -= 1;
      continue;
    }
    if (previous.trim() === "" && quoteStart - 2 >= 0 && QUOTE_LINE_PATTERN.test(lines[quoteStart - 2])) {
      quoteStart -= 1;
      continue;
    }
    break;
  }
  // A separator header sits above the quoted content it introduces (which
  // itself need not use "> " prefixes), so it wins when it sits earlier.
  let separatorStart = -1;
  for (let index = 0; index < end; index += 1) {
    if (QUOTE_SEPARATOR_PATTERN.test(lines[index])) separatorStart = index;
  }
  const start = separatorStart >= 0 && separatorStart < quoteStart ? separatorStart : quoteStart;
  if (start <= 0 || start >= end) return { body: text, quote: "" };
  return {
    body: lines.slice(0, start).join("\n").replace(/\n+$/, ""),
    quote: lines.slice(start, end).join("\n"),
  };
}

/** One run of a plain-text body: literal prose, or a linkable http(s) URL. */
export type BodyTextPart = { kind: "text" | "link"; text: string; href?: string };

/**
 * Characters a bare URL may be built from — RFC 3986's unreserved set plus the
 * sub-delims and gen-delims real links use. Deliberately ASCII-only: anything
 * outside it (whitespace, CJK, full-width punctuation, angle and double quotes)
 * is prose and must never be swallowed, which is what keeps the URL half of
 * `https://host/pull/12已合并` linkified and the Chinese half as text.
 */
const URL_CHARACTERS = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";
/** The `(?<![\w])` guard keeps `xhttps://…` out: an ASCII word character right
 *  in front of the scheme means the match is the tail of a longer token, not a
 *  URL a reader can click. CJK is not `\w`, so adjacency to Chinese still links. */
const BARE_LINK_SOURCE = `(?<![\\w])https?://[${URL_CHARACTERS}]+`;

/** Sentence punctuation that follows a URL in prose but belongs to the prose. */
const TRAILING_LINK_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", "\"", ")", "]"]);

/** True when every closer in `url` was opened, so a trailing `)`/`]` is part of
 *  the URL (`https://host/wiki/Foo_(bar)`) rather than the sentence around it. */
function closesOnlyOpened(value: string, closer: string, opener: string): boolean {
  let balance = 0;
  for (const char of value) {
    if (char === opener) balance += 1;
    else if (char === closer) balance -= 1;
  }
  return balance >= 0;
}

function trimLinkTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1]!;
    if (!TRAILING_LINK_PUNCTUATION.has(char)) break;
    const opener = char === ")" ? "(" : char === "]" ? "[" : "";
    if (opener && closesOnlyOpened(url.slice(0, end), char, opener)) break;
    end -= 1;
  }
  return url.slice(0, end);
}

/**
 * Splits a plain-text body into prose runs and bare http(s) links. The reader
 * typesets the plain-text path as prose (`white-space:pre-wrap`, no markup), so
 * before this a URL was neither clickable nor distinguishable from the sentence
 * around it — the exact shape of a Dependabot notification.
 *
 * Only http/https linkifies: `javascript:`, `data:`, `file:` and `mailto:` are
 * a hard no, so a hostile body cannot get an executable scheme into an href.
 * A single pass, and every other character is copied through verbatim — the
 * parts always join back into the exact input, so no blank line, tab or
 * full-width mark can be lost on the way to the DOM.
 */
export function splitBodyLinks(text: string): BodyTextPart[] {
  if (!text) return [];
  const parts: BodyTextPart[] = [];
  const pushText = (value: string): void => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last?.kind === "text") last.text += value;
    else parts.push({ kind: "text", text: value });
  };
  const pattern = new RegExp(BARE_LINK_SOURCE, "gi");
  let cursor = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const href = trimLinkTail(match[0]);
    // A scheme with no authority ("https://", or one trimmed down to it) is not
    // a link. Leaving the cursor alone keeps those characters as prose.
    if (href.length <= match[0].indexOf("//") + 2) continue;
    pushText(text.slice(cursor, match.index));
    parts.push({ kind: "link", text: href, href });
    cursor = match.index + href.length;
  }
  pushText(text.slice(cursor));
  return parts;
}

export function replyBody(message: Message, accounts: readonly Account[], locale: string, t: Translate, safeHtml: string): string {
  const signature = accounts.find((account) => account.id === message.accountId)?.signature ?? "";
  const body = message.textBody || textFromSanitizedMailHtml(safeHtml) || message.snippet;
  const sender = message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address;
  const quote = buildReplyQuote(body, t("compose.replyQuote", {
    date: formatFullDate(message.sentAt, locale),
    sender,
  }));
  return signature.trim() ? `${signature.trim()}\n\n${quote}` : `\n\n${quote}`;
}
