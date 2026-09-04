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

export function formatMessageTime(value: string, locale: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { month: "numeric", day: "numeric" } : { year: "2-digit", month: "numeric", day: "numeric" }).format(date);
}

export function formatFullDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
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
  page = 1,
}: {
  accountId: string;
  folder: string;
  search: string;
  messageView: MailView;
  searchScope: "view" | "all";
  attachmentKind?: AttachmentKind;
  after?: string;
  before?: string;
  page?: number;
}): string {
  const query = new URLSearchParams({ pageSize: "100" });
  if (page > 1) query.set("page", String(page));
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

export function initials(name: string, address: string): string {
  const value = name.trim() || address.split("@")[0] || "?";
  return [...value].slice(0, 2).join("").toUpperCase();
}

export function accountTone(value: string): number {
  return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
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
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
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
