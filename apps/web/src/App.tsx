import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from "react";
import DOMPurify from "dompurify";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Download,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Forward,
  Inbox,
  LoaderCircle,
  Mail,
  MailOpen,
  Menu,
  MoreHorizontal,
  Moon,
  Paperclip,
  PenLine,
  Plus,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import AccountConnectionModal from "./AddAccountModal";
import { api } from "./api";
import { presentAttachment, type AttachmentKind } from "./attachmentPresentation";
import { summarizeComposeAttachments } from "./attachmentWorkflow";
import { desktopBridge, type DesktopUpdateSnapshot } from "./desktop";
import { demoAccounts, demoMessageTranslation, demoMessages, demoProviders, demoStats, demoSubmissions } from "./demo";
import { accountHealthIssue, mailErrorMessage, mailErrorToastMessage, presentMailError, type MailErrorPresentation } from "./errorPresentation";
import { buildForwardDraft, buildReplyDraft } from "./mailActions";
import { mailBackgroundColor, mailReaderSurface, mailSurfaceForBackground, shouldResetMailForeground, type MailSurface } from "./mailHtmlTheme";
import {
  applyMessageMove,
  applyMessageSeenChange,
  isArchivedMessage,
  isInboxMessage,
  matchesServerMessageQuery,
  mergePendingArchiveMoves,
  mergeUnreadViewSnapshot,
  nextMessageTotalForMove,
  nextUnreadViewRecentlyReadIds,
  sidebarBadgeCounts,
  type MessageListQuery,
  type PendingArchiveMove,
} from "./mailListState";
import SettingsModal from "./SettingsModal";
import SendingStatusModal from "./SendingStatusModal";
import StartupUpdatePrompt from "./StartupUpdatePrompt";
import { pollSubmittingSubmission, sortSubmissions } from "./sendingStatus";
import { providerDisplayName } from "./providerOnboarding";
import { canPlayCustomNotificationSound, playNotificationSound, primeNotificationSound } from "./sounds";
import { saveLocalePreference } from "./localePreference";
import { createSettingsLoadCoordinator } from "./settingsLoadCoordinator";
import ThemedSelect from "./ThemedSelect";
import TranslationPanel, { type TranslationAvailability, type TranslationContent, type TranslationPanelState } from "./TranslationPanel";
import { translationErrorMessage } from "./translationPresentation";
import { defaultAppSettings, type Account, type AppSettings, type AppSettingsPatch, type Message, type MessageAttachment, type OutboundAttachment, type OutboundSubmission, type ProviderInfo, type Stats } from "./types";
import { useDialogFocus } from "./useDialogFocus";
import { findVerificationCodes } from "./verificationCode";
import { resolveLocale, type Translate, useI18n } from "./i18n";

type MailView = MessageListQuery["messageView"];
type ToastKind = "success" | "error" | "info" | "warning";
type ToastNotice = { kind: ToastKind; message: string } | null;
type TranslationSession = {
  messageId: string;
  targetLocale: string;
  state: TranslationPanelState;
};
type PendingAttachmentUpload = {
  id: string;
  file: File;
  phase: "uploading" | "error";
  retryable: boolean;
  error?: string;
};
type AttachmentDownloadState = {
  phase: "downloading" | "ready" | "error";
  detail?: string;
};

function retainedTranslationContent(state: TranslationPanelState): TranslationContent | undefined {
  if (state.phase === "ready") {
    return {
      translatedText: state.translatedText,
      ...(state.detectedLanguage ? { detectedLanguage: state.detectedLanguage } : {}),
      visible: state.visible,
    };
  }
  return state.phase === "loading" || state.phase === "error" ? state.previous : undefined;
}

const submissionStatusesNeedingRefresh = new Set<OutboundSubmission["deliveryStatus"]>([
  "submitting",
  "submitted",
  "unknown_delivery",
]);

export function submissionStatusNeedsRefresh(status: OutboundSubmission["deliveryStatus"]): boolean {
  return submissionStatusesNeedingRefresh.has(status);
}

const isDemo = new URLSearchParams(window.location.search).get("demo") === "1";
const isDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";
const isDesktopSmoke = new URLSearchParams(window.location.search).get("desktopSmoke") === "1";

function formatMessageTime(value: string, locale: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { month: "numeric", day: "numeric" } : { year: "2-digit", month: "numeric", day: "numeric" }).format(date);
}

function formatFullDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatSyncFreshness(value: string | null, t: Translate): string {
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

function isCompactMailLayout(): boolean {
  return window.matchMedia("(max-width: 620px)").matches;
}

function buildMessageQuery({
  accountId,
  folder,
  search,
  messageView,
  page = 1,
}: {
  accountId: string;
  folder: string;
  search: string;
  messageView: MailView;
  page?: number;
}): string {
  const query = new URLSearchParams({ pageSize: "100" });
  if (page > 1) query.set("page", String(page));
  if (accountId !== "all") query.set("accountId", accountId);
  if (folder) query.set("folder", folder);
  if (messageView === "starred") query.set("starred", "1");
  if (messageView === "unread") query.set("unread", "1");
  if (messageView === "archived") query.set("archived", "1");
  if (search.trim()) query.set("q", search.trim());
  return query.toString();
}

function demoMessageTotal(messages: readonly Message[], accounts: readonly Account[], {
  accountId,
  folder,
  search,
  messageView,
}: {
  accountId: string;
  folder: string;
  search: string;
  messageView: MailView;
}): number {
  const normalizedQuery = search.trim().toLowerCase();
  return messages.filter((message) => {
    if (accountId !== "all" && message.accountId !== accountId) return false;
    if (folder && message.mailbox !== folder) return false;
    if (!folder && messageView === "inbox" && !isInboxMessage(message, accounts)) return false;
    if (messageView === "unread" && message.seen) return false;
    if (messageView === "starred" && !message.flagged) return false;
    if (messageView === "archived" && !isArchivedMessage(message, accounts)) return false;
    if (!normalizedQuery) return true;
    return `${message.subject} ${message.from.name} ${message.from.address} ${message.snippet}`.toLowerCase().includes(normalizedQuery);
  }).length;
}

function demoMoveDestination(accounts: readonly Account[], accountId: string, target: "archive" | "trash"): string {
  const specialUses = target === "archive" ? ["\\Archive", "\\All"] : ["\\Trash"];
  const folders = accounts.find((account) => account.id === accountId)?.folders ?? [];
  for (const specialUse of specialUses) {
    const folder = folders.find((item) => item.specialUse === specialUse);
    if (folder) return folder.path;
  }
  return "";
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function AttachmentFileIcon({ kind }: { kind: AttachmentKind }) {
  const icon = kind === "archive"
    ? <FileArchive size={19} />
    : kind === "image"
      ? <FileImage size={19} />
      : kind === "spreadsheet"
        ? <FileSpreadsheet size={19} />
        : <FileText size={19} />;
  return <span className={`attachment-file-icon kind-${kind}`} aria-hidden="true">{icon}</span>;
}

function initials(name: string, address: string): string {
  const value = name.trim() || address.split("@")[0] || "?";
  return [...value].slice(0, 2).join("").toUpperCase();
}

function accountTone(value: string): number {
  return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
}

function currentSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(preference: AppSettings["theme"], systemTheme: "light" | "dark"): "light" | "dark" {
  return preference === "system" ? systemTheme : preference;
}

function backgroundUrl(settings: AppSettings): string | null {
  if (settings.backgroundPreset === "custom") return settings.customBackgroundUrl;
  if (settings.backgroundPreset === "none") return null;
  return `/backgrounds/${settings.backgroundPreset}.png`;
}

function reportCustomNotificationSoundAvailability(): void {
  desktopBridge()?.setCustomNotificationSoundReady(canPlayCustomNotificationSound());
}

type ComposeDraft = {
  accountId?: string;
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  inReplyTo?: string;
  references?: string[];
  sourceDraftId?: string;
  attachments?: OutboundAttachment[];
};

function IconButton({ label, children, onClick, className = "", disabled = false, expanded, buttonRef }: { label: string; children: React.ReactNode; onClick?: () => void; className?: string; disabled?: boolean; expanded?: boolean; buttonRef?: RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={buttonRef} className={`icon-button ${className}`} type="button" aria-label={label} aria-expanded={expanded} data-tooltip={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function sanitizeMailHtml(html: string, darkMode: boolean): string {
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "img", "form"],
  });

  const template = document.createElement("template");
  template.innerHTML = clean;
  const elements = [...template.content.querySelectorAll("*")];
  for (const element of elements) {
    const styled = element as HTMLElement;
    // Mail content is intentionally selectable. Remove only the inline
    // properties that can override the reader's explicit selection policy.
    styled.style?.removeProperty("user-select");
    styled.style?.removeProperty("-webkit-user-select");
    // Email content must not be able to opt itself into the reader's surface
    // normalization before we classify its own declared background.
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
    // WebKit text fill wins over `color` when present. Email generators use it
    // surprisingly often, so checking only `color` can still leave white copy
    // on a light table after sanitization.
    const foregrounds = [
      { value: styled.style?.getPropertyValue("-webkit-text-fill-color") ?? "", reset: () => styled.style?.removeProperty("-webkit-text-fill-color") },
      { value: styled.style?.getPropertyValue("color") ?? "", reset: () => styled.style?.removeProperty("color") },
      { value: element.getAttribute("color") ?? "", reset: () => element.removeAttribute("color") },
    ].filter((foreground) => Boolean(foreground.value));
    // Links retain recognizable brand colors, but still need a visible
    // contrast floor distinct from the stricter body-copy requirement.
    const minimumContrast = element.closest("a") ? 3 : undefined;
    const readableForeground = foregrounds.some((foreground) => !shouldResetMailForeground(foreground.value, surface, minimumContrast));
    for (const foreground of foregrounds) {
      if (shouldResetMailForeground(foreground.value, surface, minimumContrast)) foreground.reset();
    }
    // The app's light reader would otherwise provide dark inherited text for
    // a dark authored table. Give only unstyled or corrected surface roots a
    // readable inherited foreground, while preserving intentional email colors.
    if (!darkMode && surfaceByElement.get(element)?.tone === "dark" && !readableForeground) {
      styled.style?.setProperty("color", "#f5f5f6");
      styled.style?.setProperty("-webkit-text-fill-color", "#f5f5f6");
      styled.style?.setProperty("color-scheme", "dark");
    }
  }
  return template.innerHTML;
}

function textFromSanitizedMailHtml(html: string): string {
  if (!html) return "";
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.textContent ?? "";
}

async function copyVerificationCodeToClipboard(code: string): Promise<boolean> {
  const bridge = desktopBridge();
  if (bridge?.copyVerificationCode) {
    try {
      if ((await bridge.copyVerificationCode(code)).copied) return true;
    } catch {
      // Browser APIs below keep the web build usable when desktop clipboard
      // access is unavailable for a particular session.
    }
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
      return true;
    }
  } catch {
    // Some browsers allow clipboard writes only over secure contexts. Use the
    // short-lived selection fallback instead of retaining message content.
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = code;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
  }
}

function createLocalId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

function createSubmissionIdempotencyKey(): string {
  return createLocalId("sub");
}

function ComposeModal({ accounts, draft, onClose, onSent, onDraftSaved, onDraftDiscarded, onSubmissionChanged, fallbackFocusRef }: { accounts: Account[]; draft: ComposeDraft; onClose: () => void; onSent: (message: string, kind?: ToastKind) => void; onDraftSaved: (accountId: string) => void; onDraftDiscarded: (messageId: string) => void; onSubmissionChanged: () => void; fallbackFocusRef?: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const [accountId, setAccountId] = useState(draft.accountId ?? accounts[0]?.id ?? "");
  const [to, setTo] = useState(draft.to ?? "");
  const [cc, setCc] = useState(draft.cc ?? "");
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [text, setText] = useState(draft.text ?? "");
  const [attachments, setAttachments] = useState<OutboundAttachment[]>(draft.attachments ?? []);
  const [pendingUploads, setPendingUploads] = useState<PendingAttachmentUpload[]>([]);
  const [recentAttachmentTokens, setRecentAttachmentTokens] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"discard" | "delete" | null>(null);
  const [error, setError] = useState("");
  const [deliveryNotice, setDeliveryNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composeDialogRef = useRef<HTMLElement>(null);
  const discardConfirmDialogRef = useRef<HTMLElement>(null);
  const submissionAttemptRef = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const uploadInFlightRef = useRef(false);
  const initialDraftRef = useRef({
    accountId: draft.accountId ?? accounts[0]?.id ?? "",
    to: draft.to ?? "",
    cc: draft.cc ?? "",
    subject: draft.subject ?? "",
    text: draft.text ?? "",
    attachmentTokens: (draft.attachments ?? []).map((attachment) => attachment.token).join("\u001f"),
  });

  const recipients = () => to.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean);
  const copiedRecipients = () => cc.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean);
  const initialDraft = initialDraftRef.current;
  const uploading = pendingUploads.some((upload) => upload.phase === "uploading");
  const hasPendingUploads = pendingUploads.length > 0;
  const hasUploadErrors = pendingUploads.some((upload) => upload.phase === "error");
  const attachmentSummary = summarizeComposeAttachments(attachments, pendingUploads);
  const attachmentStatus = [
    attachmentSummary.uploadingCount > 0 ? t("compose.attachment.uploadingCount", { count: attachmentSummary.uploadingCount }) : "",
    attachmentSummary.failedCount > 0 ? t("compose.attachment.failedCount", { count: attachmentSummary.failedCount }) : "",
  ].filter(Boolean).join(t("common.dotSeparator"));
  const hasUnsavedChanges = accountId !== initialDraft.accountId
    || to !== initialDraft.to
    || cc !== initialDraft.cc
    || subject !== initialDraft.subject
    || text !== initialDraft.text
    || attachments.map((attachment) => attachment.token).join("\u001f") !== initialDraft.attachmentTokens
    || hasPendingUploads;

  const requestClose = useCallback(() => {
    if (busy || uploading || discarding) return;
    if (hasUnsavedChanges) {
      setConfirmAction("discard");
      return;
    }
    onClose();
  }, [busy, discarding, hasUnsavedChanges, onClose, uploading]);

  useDialogFocus(true, composeDialogRef, { fallbackFocusRef, suspended: Boolean(confirmAction) });
  useDialogFocus(Boolean(confirmAction), discardConfirmDialogRef);

  const discardAndClose = async () => {
    if (busy || uploading || discarding) return;
    setDiscarding(true);
    setError("");
    try {
      if (!isDemo && accountId && attachments.length) {
        await api.discardOutboundAttachments(accountId, attachments.map((attachment) => attachment.token));
      }
      onClose();
    } catch (reason) {
      setError(mailErrorMessage(reason, t("compose.error.cleanupAttachments"), t));
      setConfirmAction(null);
    } finally {
      setDiscarding(false);
    }
  };

  const deleteSavedDraft = async () => {
    if (!draft.sourceDraftId || busy || uploading || discarding) return;
    setDiscarding(true);
    setError("");
    try {
      if (!isDemo) await api.discardDraft(draft.sourceDraftId);
      onDraftDiscarded(draft.sourceDraftId);
      onClose();
    } catch (reason) {
      setError(mailErrorMessage(reason, t("compose.error.deleteDraft"), t));
      setConfirmAction(null);
    } finally {
      setDiscarding(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (confirmAction) {
        setConfirmAction(null);
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmAction, requestClose]);

  const chooseFiles = () => fileInputRef.current?.click();

  const uploadAttachment = async (targetAccountId: string, uploadId: string, file: File) => {
    try {
      const attachment = isDemo
        ? {
          token: createLocalId("demo-attachment"),
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
        }
        : await api.uploadOutboundAttachment(targetAccountId, file);
      setAttachments((current) => [...current, attachment]);
      setRecentAttachmentTokens((current) => new Set(current).add(attachment.token));
      setPendingUploads((current) => current.filter((upload) => upload.id !== uploadId));
    } catch (reason) {
      const detail = mailErrorMessage(reason, t("compose.error.uploadAttachment"), t);
      setPendingUploads((current) => current.map((upload) => upload.id === uploadId
        ? { ...upload, phase: "error", retryable: true, error: detail }
        : upload));
    }
  };

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length || busy || uploading || uploadInFlightRef.current) return;
    if (!accountId) {
      setError(t("compose.error.selectSender"));
      return;
    }
    const validFiles = files.filter((file) => file.size > 0 && file.size <= 10 * 1024 * 1024);
    if (attachmentSummary.reservedCount + validFiles.length > 10) {
      setError(t("compose.error.maxAttachments"));
      return;
    }
    const totalSize = attachmentSummary.reservedBytes + validFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > 25 * 1024 * 1024) {
      setError(t("compose.error.maxAttachmentSize"));
      return;
    }

    const nextUploads: PendingAttachmentUpload[] = files.map((file) => {
      const error = file.size <= 0
        ? t("compose.error.emptyAttachment")
        : file.size > 10 * 1024 * 1024
          ? t("compose.error.maxSingleAttachmentSize")
          : undefined;
      return { id: createLocalId("upload"), file, phase: error ? "error" : "uploading", retryable: !error, error };
    });
    setPendingUploads((current) => [...current, ...nextUploads]);
    setError("");
    uploadInFlightRef.current = true;
    try {
      for (const upload of nextUploads) {
        if (upload.phase === "uploading") await uploadAttachment(accountId, upload.id, upload.file);
      }
    } finally {
      uploadInFlightRef.current = false;
    }
  };

  const retryPendingUpload = async (upload: PendingAttachmentUpload) => {
    if (!accountId || !upload.retryable || busy || uploading || discarding || uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    setError("");
    setPendingUploads((current) => current.map((item) => item.id === upload.id
      ? { ...item, phase: "uploading", error: undefined }
      : item));
    try {
      await uploadAttachment(accountId, upload.id, upload.file);
    } finally {
      uploadInFlightRef.current = false;
    }
  };

  const removePendingUpload = (uploadId: string) => {
    if (busy || uploading || discarding) return;
    setPendingUploads((current) => current.filter((upload) => upload.id !== uploadId));
  };

  const removeAttachment = async (attachment: OutboundAttachment) => {
    if (busy || uploading || discarding) return;
    setError("");
    try {
      if (!isDemo && accountId) await api.discardOutboundAttachments(accountId, [attachment.token]);
      setAttachments((current) => current.filter((item) => item.token !== attachment.token));
      setRecentAttachmentTokens((current) => {
        const next = new Set(current);
        next.delete(attachment.token);
        return next;
      });
    } catch (reason) {
      setError(mailErrorMessage(reason, t("compose.error.removeAttachment"), t));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || uploading || discarding) return;
    if (hasPendingUploads) {
      setError(t("compose.error.pendingAttachments"));
      return;
    }
    const recipientValues = recipients();
    const ccValues = copiedRecipients();
    if (!accountId) {
      setError(t("compose.error.selectSender"));
      return;
    }
    if (!recipientValues.length) {
      setError(t("compose.error.recipientRequired"));
      return;
    }
    if ([...recipientValues, ...ccValues].some((recipient) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))) {
      setError(t("compose.error.recipientInvalid"));
      return;
    }
    if (!text.trim() && !attachments.length) {
      setError(t("compose.error.messageRequired"));
      return;
    }
    setBusy(true);
    setError("");
    setDeliveryNotice("");
    try {
      if (!isDemo) {
        const sendRequest = {
          accountId,
          to: recipientValues,
          cc: ccValues.length ? ccValues : undefined,
          subject,
          text,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
          discardDraftId: draft.sourceDraftId,
          attachmentTokens: attachments.map((attachment) => attachment.token),
        };
        const fingerprint = JSON.stringify(sendRequest);
        if (submissionAttemptRef.current?.fingerprint !== fingerprint) {
          submissionAttemptRef.current = { fingerprint, idempotencyKey: createSubmissionIdempotencyKey() };
        }
        const result = await api.send({
          ...sendRequest,
          idempotencyKey: submissionAttemptRef.current.idempotencyKey,
        });
        onSubmissionChanged();
        let submission = result.submission;
        if (submission.deliveryStatus === "submitting") {
          try {
            submission = await pollSubmittingSubmission(
              submission,
              async (id) => (await api.submission(id)).submission,
            );
          } catch {
            // The durable record remains `submitting`. Keep the compose window
            // open so a transient local API failure cannot discard the draft.
          }
          onSubmissionChanged();
          if (submission.deliveryStatus === "submitting") {
            setDeliveryNotice(t("compose.delivery.waitingNotice"));
            onSent(t("compose.delivery.waitingToast"), "info");
            return;
          }
          if (submission.deliveryStatus === "failed") {
            setError(mailErrorMessage(
              { code: submission.errorCode ?? undefined, message: submission.errorMessage ?? "" },
              t("compose.error.sendRejected"),
              t,
            ));
            return;
          }
        }
        if (submission.deliveryStatus === "unknown_delivery") {
          onSent(
            t("compose.delivery.unknown"),
            "warning",
          );
        } else {
          if (draft.sourceDraftId && !result.draftDiscardWarning) onDraftDiscarded(draft.sourceDraftId);
          const deliveryMessage = submission.deliveryStatus === "confirmed"
            ? t("compose.delivery.confirmed")
            : t("compose.delivery.submitted");
          onSent(result.draftDiscardWarning ? t("compose.delivery.previousDraftRemains", { message: deliveryMessage }) : deliveryMessage);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 650));
        onSent(t("compose.delivery.demoSent"));
      }
      onClose();
    } catch (reason) {
      setError(mailErrorMessage(reason, t("compose.error.send"), t));
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!accountId || busy || uploading || discarding) return;
    if (hasPendingUploads) {
      setError(t("compose.error.pendingAttachments"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!isDemo) {
        const result = await api.saveDraft({
          accountId,
          to: recipients(),
          cc: copiedRecipients(),
          subject,
          text,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
          replaceDraftId: draft.sourceDraftId,
          attachmentTokens: attachments.map((attachment) => attachment.token),
        });
        if (!result.serverConfirmed) {
          setError(t("compose.error.draftUnconfirmed"));
          return;
        }
        if (draft.sourceDraftId && !result.replaceWarning) onDraftDiscarded(draft.sourceDraftId);
        const warnings = [
          result.replaceWarning ? t("compose.save.replaceWarning") : "",
          result.attachmentWarning ? t("compose.save.attachmentWarning") : "",
        ].filter(Boolean);
        onSent(warnings.length ? t("compose.save.confirmedWithWarnings", { warnings: warnings.join(t("common.listSeparator")) }) : t("compose.save.confirmed"));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 380));
        onSent(t("compose.save.demo"));
      }
      onDraftSaved(accountId);
      onClose();
    } catch (reason) {
      setError(mailErrorMessage(reason, t("compose.error.saveDraft"), t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop compose-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (confirmAction) setConfirmAction(null);
      else requestClose();
    }}>
      <section ref={composeDialogRef} className="compose-card" role="dialog" aria-modal="true" aria-labelledby="compose-title" tabIndex={-1}>
        <header className="compose-header">
          <div><span className="eyebrow">{draft.sourceDraftId ? t("compose.draft") : t("compose.new")}</span><h2 id="compose-title">{draft.sourceDraftId ? t("compose.editDraft") : t("compose.new")}</h2></div>
          <div className="compose-header-actions">{draft.sourceDraftId && <IconButton label={t("compose.deleteDraft")} onClick={() => setConfirmAction("delete")} disabled={busy || uploading || discarding}><Trash2 size={18} /></IconButton>}<IconButton label={t("common.close")} onClick={requestClose} disabled={busy || uploading || discarding}><X size={18} /></IconButton></div>
        </header>
        <form noValidate onSubmit={submit}>
          <label className="compose-row" htmlFor="compose-account"><span>{t("compose.sender")}</span><ThemedSelect id="compose-account" value={accountId} onValueChange={(value) => {
            if ((attachments.length || pendingUploads.length) && value !== accountId) {
              setError(t("compose.error.senderLocked"));
              return;
            }
            setAccountId(value);
          }} disabled={busy || uploading || discarding}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</ThemedSelect></label>
          <label className="compose-row" htmlFor="compose-to"><span>{t("compose.to")}</span><input id="compose-to" type="text" data-dialog-initial-focus value={to} onChange={(event) => setTo(event.target.value)} placeholder="email@example.com" disabled={busy || discarding} /></label>
          <label className="compose-row" htmlFor="compose-cc"><span>{t("compose.cc")}</span><input id="compose-cc" type="text" value={cc} onChange={(event) => setCc(event.target.value)} placeholder={t("compose.ccPlaceholder")} disabled={busy || discarding} /></label>
          <label className="compose-row" htmlFor="compose-subject"><span>{t("compose.subject")}</span><input id="compose-subject" type="text" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder={t("compose.subjectPlaceholder")} disabled={busy || discarding} /></label>
          <label className="visually-hidden" htmlFor="compose-body">{t("compose.body")}</label>
          <textarea id="compose-body" className="compose-body" value={text} onChange={(event) => setText(event.target.value)} placeholder={t("compose.bodyPlaceholder")} disabled={busy || discarding} />
          <section className="compose-attachments" aria-label={t("compose.attachment.aria", { count: attachmentSummary.attachedCount, status: attachmentStatus })}>
            <div className="compose-attachments-heading"><span><Paperclip size={16} />{t("compose.attachments")}</span><small aria-live="polite">{attachmentSummary.attachedCount} / 10{t("common.dotSeparator")}{formatFileSize(attachmentSummary.attachedBytes)}{attachmentStatus ? `${t("common.dotSeparator")}${attachmentStatus}` : ""}</small><button className="compose-attachment-add" type="button" onClick={chooseFiles} disabled={busy || uploading || discarding || !accountId}>{uploading ? <LoaderCircle className="spin" size={15} /> : <Paperclip size={15} />}{uploading ? t("compose.attachment.uploading") : t("compose.attachment.add")}</button></div>
            <input ref={fileInputRef} className="visually-hidden" type="file" tabIndex={-1} multiple onChange={(event) => void addFiles(event)} />
            {(attachments.length > 0 || pendingUploads.length > 0) && <div className="compose-attachment-list">{attachments.map((attachment) => {
              const presentation = presentAttachment(attachment.filename, attachment.contentType, t);
              const recentlyAdded = recentAttachmentTokens.has(attachment.token);
              return <div className={`compose-attachment-item${recentlyAdded ? " is-success" : ""}`} key={attachment.token}><AttachmentFileIcon kind={presentation.kind} /><span><strong className="truncated-tooltip" data-tooltip={attachment.filename}><span>{attachment.filename}</span></strong><small aria-live={recentlyAdded ? "polite" : undefined}>{recentlyAdded ? `${t("compose.attachment.added")}${t("common.dotSeparator")}` : ""}{presentation.label}{t("common.dotSeparator")}{formatFileSize(attachment.size)}</small></span><IconButton label={t("compose.attachment.remove", { filename: attachment.filename })} onClick={() => void removeAttachment(attachment)} disabled={busy || uploading || discarding}><X size={16} /></IconButton></div>;
            })}{pendingUploads.map((upload) => {
              const presentation = presentAttachment(upload.file.name, upload.file.type || "application/octet-stream", t);
              const isUploading = upload.phase === "uploading";
              const isRetryable = !isUploading && upload.retryable;
              return <div className={`compose-attachment-item is-${upload.phase}${isRetryable ? " has-retry" : ""}`} key={upload.id}><AttachmentFileIcon kind={presentation.kind} /><span><strong className="truncated-tooltip" data-tooltip={upload.file.name}><span>{upload.file.name}</span></strong><small className="truncated-tooltip" aria-live="polite" data-tooltip={upload.error}><span>{isUploading ? t("compose.attachment.uploadingEllipsis") : upload.error}</span></small></span>{isUploading ? <span className="attachment-transfer-state" role="status" aria-label={t("compose.attachment.uploadingFile", { filename: upload.file.name })}><LoaderCircle className="spin" size={16} /></span> : <span className="attachment-upload-actions">{isRetryable && <IconButton label={t("compose.attachment.retry", { filename: upload.file.name })} onClick={() => void retryPendingUpload(upload)} disabled={busy || uploading || discarding}><RefreshCw size={16} /></IconButton>}<IconButton label={t("compose.attachment.remove", { filename: upload.file.name })} onClick={() => removePendingUpload(upload.id)} disabled={busy || uploading || discarding}><X size={16} /></IconButton></span>}</div>;
            })}</div>}
            {hasPendingUploads && <p className={`compose-attachment-hint${hasUploadErrors ? " error" : ""}`} role={hasUploadErrors ? "alert" : "status"}>{hasUploadErrors ? t("compose.attachment.failedHint") : t("compose.attachment.uploadingHint")}</p>}
          </section>
          {deliveryNotice && <div className="form-status warning" role="status"><LoaderCircle className="spin" size={17} />{deliveryNotice}</div>}
          {error && <div id="compose-error" className="form-status error" role="alert"><X size={17} />{error}</div>}
          <footer className="compose-footer">
            <button className="secondary-button" type="button" disabled={busy || uploading || discarding || hasPendingUploads || !accountId} onClick={() => void saveDraft()}>{busy ? <LoaderCircle className="spin" size={17} /> : <FileText size={17} />}{t("compose.saveDraft")}</button>
            <button className="primary-button" type="submit" disabled={busy || uploading || discarding || hasPendingUploads || !accountId}>{busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}{busy ? t("compose.sending") : t("compose.send")}</button>
          </footer>
        </form>
        {confirmAction && (
          <div className="compose-confirm-backdrop" role="presentation" onMouseDown={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) setConfirmAction(null);
          }}>
            <section ref={discardConfirmDialogRef} className="compose-confirm" role="alertdialog" aria-modal="true" aria-labelledby="discard-compose-title" aria-describedby="discard-compose-copy" tabIndex={-1}>
              <h3 id="discard-compose-title">{confirmAction === "delete" ? t("compose.confirm.deleteTitle") : t("compose.confirm.discardTitle")}</h3>
              <p id="discard-compose-copy">{confirmAction === "delete" ? t("compose.confirm.deleteDescription") : t("compose.confirm.discardDescription")}</p>
              <div><button className="secondary-button" type="button" onClick={() => setConfirmAction(null)} disabled={discarding}>{confirmAction === "delete" ? t("compose.confirm.keepDraft") : t("compose.confirm.continueEditing")}</button><button className="danger-button" type="button" onClick={() => void (confirmAction === "delete" ? deleteSavedDraft() : discardAndClose())} disabled={discarding}>{discarding ? t("compose.processing") : confirmAction === "delete" ? t("compose.deleteDraft") : t("compose.confirm.discardAction")}</button></div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

export default function App() {
  const { locale, setLocale, t } = useI18n();
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(currentSystemTheme);
  const [settings, setSettings] = useState<AppSettings>(() => ({ ...defaultAppSettings, locale }));
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingArchiveMoves, setPendingArchiveMoves] = useState<PendingArchiveMove[]>([]);
  const [pendingMoveVerifications, setPendingMoveVerifications] = useState<string[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [messagePage, setMessagePage] = useState(1);
  const [stats, setStats] = useState<Stats>({ accounts: 0, messages: 0, unread: 0 });
  const [unreadViewRecentlyReadIds, setUnreadViewRecentlyReadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [translationSession, setTranslationSession] = useState<TranslationSession | null>(null);
  const [translationAvailability, setTranslationAvailability] = useState<TranslationAvailability>(isDemo ? "available" : "checking");
  const [view, setView] = useState<MailView>("inbox");
  const [selectedAccount, setSelectedAccount] = useState("all");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ComposeDraft>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sendingStatusOpen, setSendingStatusOpen] = useState(false);
  const [submissions, setSubmissions] = useState<OutboundSubmission[]>([]);
  const [submissionLoading, setSubmissionLoading] = useState(true);
  const [submissionLoadError, setSubmissionLoadError] = useState<string | null>(null);
  const [messageAction, setMessageAction] = useState<"archive" | "trash" | null>(null);
  const [messageFlagging, setMessageFlagging] = useState(false);
  const [attachmentDownloads, setAttachmentDownloads] = useState<Record<string, AttachmentDownloadState>>({});
  const [recipientDetailsOpen, setRecipientDetailsOpen] = useState(false);
  const [readerMoreOpen, setReaderMoreOpen] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [toast, setToast] = useState<ToastNotice>(null);
  const [fatalError, setFatalError] = useState<MailErrorPresentation | null>(null);
  const [desktopUpdateStatus, setDesktopUpdateStatus] = useState<DesktopUpdateSnapshot | null>(null);
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const readerTitleRef = useRef<HTMLHeadingElement>(null);
  const readerMoreRef = useRef<HTMLDivElement>(null);
  const messageButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const messagesRef = useRef<Message[]>([]);
  const pendingArchiveMovesRef = useRef<PendingArchiveMove[]>([]);
  const unreadViewRecentlyReadIdsRef = useRef<ReadonlySet<string>>(new Set());
  const seenMutationIdsRef = useRef(new Set<string>());
  const viewRef = useRef<MailView>("inbox");
  const lastOpenedMessageIdRef = useRef<string | null>(null);
  const translationRequestIdRef = useRef(0);
  const translationAvailabilityRequestIdRef = useRef(0);
  const settingsLoadCoordinatorRef = useRef(createSettingsLoadCoordinator());
  const demoLoadedRef = useRef(false);
  const selectionInitializedRef = useRef(false);
  const loadRequestRef = useRef(0);
  const submissionLoadRequestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const theme = resolveTheme(settings.theme, systemTheme);
  const activeBackgroundUrl = backgroundUrl(settings);
  const accountIdsKey = accounts.map((account) => account.id).sort().join("|");
  const pendingMoveVerificationKey = [...new Set([
    ...pendingMoveVerifications,
    ...pendingArchiveMoves.map((move) => move.id),
    ...messages.filter((message) => message.movePending === true).map((message) => message.id),
  ])].sort().join("|");
  const submissionStatusRefreshIdsKey = submissions
    .filter((submission) => submissionStatusNeedsRefresh(submission.deliveryStatus))
    .map((submission) => submission.id)
    .sort()
    .join("|");
  const submissionAttentionCount = submissions.filter((submission) => ["unknown_delivery", "failed"].includes(submission.deliveryStatus)).length;
  const submissionActiveCount = submissions.filter((submission) => ["pending", "submitting", "submitted"].includes(submission.deliveryStatus)).length;
  const submissionOutstandingCount = submissionAttentionCount + submissionActiveCount;
  const sidebarCounts = useMemo(() => sidebarBadgeCounts(stats), [stats]);
  useDialogFocus(mobileSidebar, sidebarRef);
  const showToast = useCallback((message: string, kind: ToastKind = "success") => {
    setToast({ kind, message });
  }, []);
  const applySettings = useCallback((nextSettings: AppSettings) => {
    const normalizedSettings = { ...nextSettings, locale: resolveLocale(nextSettings.locale) };
    settingsLoadCoordinatorRef.current.recordSettingsChange();
    setSettings(normalizedSettings);
    setLocale(normalizedSettings.locale);
    if (!isDemo) saveLocalePreference(normalizedSettings.locale);
  }, [setLocale]);
  const clearUnreadViewRecentlyRead = useCallback(() => {
    const next = new Set<string>();
    unreadViewRecentlyReadIdsRef.current = next;
    setUnreadViewRecentlyReadIds(next);
  }, []);
  const updateUnreadViewRecentlyRead = useCallback((message: Pick<Message, "id" | "seen">, nextSeen: boolean) => {
    const next = nextUnreadViewRecentlyReadIds(
      unreadViewRecentlyReadIdsRef.current,
      message,
      nextSeen,
      viewRef.current === "unread",
    );
    unreadViewRecentlyReadIdsRef.current = next;
    setUnreadViewRecentlyReadIds(next);
  }, []);

  const refreshSubmissions = useCallback(async (
    targetAccounts: Account[],
    { silent = false }: { silent?: boolean } = {},
  ): Promise<void> => {
    const requestId = ++submissionLoadRequestRef.current;
    if (!silent) setSubmissionLoading(true);
    if (isDemo || targetAccounts.length === 0) {
      setSubmissions(isDemo ? sortSubmissions(demoSubmissions) : []);
      setSubmissionLoadError(null);
      setSubmissionLoading(false);
      return;
    }

    const settled = await Promise.allSettled(targetAccounts.map(async (account) => ({
      accountId: account.id,
      items: (await api.submissions(account.id, 100)).items,
    })));
    if (requestId !== submissionLoadRequestRef.current) return;

    const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const failedAccountIds = new Set(targetAccounts
      .filter((_, index) => settled[index]?.status === "rejected")
      .map((account) => account.id));
    const currentAccountIds = new Set(targetAccounts.map((account) => account.id));
    setSubmissions((current) => sortSubmissions([
      ...fulfilled.flatMap((result) => result.items),
      ...current.filter((item) => currentAccountIds.has(item.accountId) && failedAccountIds.has(item.accountId)),
    ]));

    const firstFailure = settled.find((result) => result.status === "rejected");
    setSubmissionLoadError(firstFailure?.status === "rejected"
      ? t("sending.loadError", {
        count: failedAccountIds.size,
        message: mailErrorToastMessage(firstFailure.reason, t("error.localServiceUnavailable.title"), t),
      })
      : null);
    setSubmissionLoading(false);
  }, [t]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemTheme(currentSystemTheme());
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 820px)");
    const closeDesktopDrawer = () => {
      if (!mediaQuery.matches) setMobileSidebar(false);
    };
    mediaQuery.addEventListener("change", closeDesktopDrawer);
    closeDesktopDrawer();
    return () => mediaQuery.removeEventListener("change", closeDesktopDrawer);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#09090a" : "#f2f2f4");
  }, [theme]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const replacePendingArchiveMoves = useCallback((next: PendingArchiveMove[]) => {
    pendingArchiveMovesRef.current = next;
    setPendingArchiveMoves(next);
  }, []);

  const load = useCallback(async ({
    silent = false,
    accountId = selectedAccount,
    folder = selectedFolder,
    search = debouncedQuery,
    messageView = view,
  }: {
    silent?: boolean;
    accountId?: string;
    folder?: string;
    search?: string;
    messageView?: MailView;
  } = {}) => {
    const requestId = ++loadRequestRef.current;
    try {
      if (!silent) setLoading(true);
      setFatalError(null);
      if (isDemo) {
        const demoTotal = demoMessageTotal(
          demoLoadedRef.current && messagesRef.current.length ? messagesRef.current : demoMessages,
          demoAccounts,
          { accountId, folder, search, messageView },
        );
        if (!demoLoadedRef.current) {
          demoLoadedRef.current = true;
          const shouldInitializeSelection = !selectionInitializedRef.current;
          selectionInitializedRef.current = true;
          setAccounts(demoAccounts);
          setProviders(demoProviders);
          setMessages(demoMessages);
          setMessagePage(1);
          setStats(demoStats);
          if (shouldInitializeSelection && !isCompactMailLayout()) setSelectedId(demoMessages[0]?.id ?? null);
        }
        setMessageTotal(demoTotal);
        setMessagePage(1);
        setSubmissions(sortSubmissions(demoSubmissions));
        setSubmissionLoadError(null);
        setSubmissionLoading(false);
      } else {
        const messageQuery = buildMessageQuery({ accountId, folder, search, messageView });
        const [nextAccounts, nextProviders, messagePage, nextStats] = await Promise.all([
          api.accounts(),
          api.providers(),
          api.messages(messageQuery),
          api.stats(),
        ]);
        if (requestId !== loadRequestRef.current) return;
        const shouldInitializeSelection = !selectionInitializedRef.current;
        selectionInitializedRef.current = true;
        const pendingMerge = mergePendingArchiveMoves(
          messagePage.items,
          pendingArchiveMovesRef.current,
          nextAccounts,
          { accountId, folder, search, messageView },
        );
        const nextMessages = mergeUnreadViewSnapshot(
          pendingMerge.items,
          messagesRef.current,
          unreadViewRecentlyReadIdsRef.current,
          messageView === "unread",
        );
        setAccounts(nextAccounts);
        setProviders(nextProviders);
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
        setMessageTotal(Math.max(messagePage.total, pendingMerge.items.length));
        setMessagePage(messagePage.page);
        setStats(nextStats);
        setSelectedId((current) => {
          if (current && nextMessages.some((item) => item.id === current)) return current;
          return shouldInitializeSelection && !isCompactMailLayout() ? nextMessages[0]?.id ?? null : null;
        });
        await refreshSubmissions(nextAccounts, { silent: true });
      }
    } catch (error) {
      if (requestId === loadRequestRef.current) {
        setFatalError(presentMailError(error, t));
        setSubmissionLoading(false);
        setSubmissionLoadError(mailErrorToastMessage(error, t("sending.error.load"), t));
      }
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [selectedAccount, selectedFolder, debouncedQuery, refreshSubmissions, replacePendingArchiveMoves, t, view]);

  const loadSettings = useCallback(async () => {
    if (isDemo) return;
    const ticket = settingsLoadCoordinatorRef.current.beginLoad();
    try {
      const nextSettings = await api.settings();
      if (!settingsLoadCoordinatorRef.current.canApplyLoad(ticket)) return;
      applySettings(nextSettings);
    } catch (error) {
      if (!settingsLoadCoordinatorRef.current.canApplyLoad(ticket)) return;
      showToast(t("settings.error.load", { message: mailErrorToastMessage(error, undefined, t) }), "error");
    }
  }, [applySettings, showToast, t]);

  const updateSettings = useCallback(async (patch: AppSettingsPatch) => {
    if (isDemo) {
      applySettings({ ...settings, ...patch, updatedAt: new Date().toISOString() });
      return;
    }
    applySettings(await api.updateSettings(patch));
  }, [applySettings, settings]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadSettings(); }, [loadSettings]);
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge || isDemo) return undefined;
    let active = true;
    let receivedUpdateEvent = false;
    const removeListener = bridge.onUpdateStatus((snapshot) => {
      receivedUpdateEvent = true;
      if (active) setDesktopUpdateStatus(snapshot);
    });
    void bridge.getUpdateStatus().then((snapshot) => {
      // Prefer a broadcast received after subscription over an older IPC
      // snapshot, so a just-found release cannot be hidden by a race.
      if (active && !receivedUpdateEvent && snapshot) setDesktopUpdateStatus(snapshot);
    }).catch(() => undefined);
    return () => {
      active = false;
      removeListener();
    };
  }, []);
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge || isDemo) return undefined;
    return bridge.onSettingsChanged(() => void loadSettings());
  }, [loadSettings]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (isDemo) return;
    const timer = window.setInterval(() => void load({ silent: true }), settings.refreshIntervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [load, settings.refreshIntervalSeconds]);
  useEffect(() => {
    if (isDemo || !pendingMoveVerificationKey) return undefined;
    const pendingIds = pendingMoveVerificationKey.split("|").filter(Boolean);
    let cancelled = false;
    let timer = 0;
    let attempt = 0;

    const verifyPendingMoves = async () => {
      const results = await Promise.allSettled(pendingIds.map(async (id) => ({ id, message: await api.message(id) })));
      if (cancelled) return;
      const resolvedIds = new Set(results.flatMap((result) =>
        result.status === "fulfilled"
          && result.value.message.id === result.value.id
          && result.value.message.movePending === false
          ? [result.value.id]
          : []
      ));
      if (resolvedIds.size) {
        setPendingMoveVerifications((current) => current.filter((id) => !resolvedIds.has(id)));
        replacePendingArchiveMoves(pendingArchiveMovesRef.current.filter((move) => !resolvedIds.has(move.id)));
        void load({ silent: true });
      }
      if (cancelled || resolvedIds.size === pendingIds.length) return;
      attempt += 1;
      const delay = Math.min(5_000, 750 * (2 ** Math.min(attempt, 3)));
      timer = window.setTimeout(() => void verifyPendingMoves(), delay);
    };

    timer = window.setTimeout(() => void verifyPendingMoves(), 750);
    return () => window.clearTimeout(timer);
  }, [load, pendingMoveVerificationKey, replacePendingArchiveMoves]);
  useEffect(() => {
    if (isDemo || !submissionStatusRefreshIdsKey || !accountIdsKey) return undefined;
    let cancelled = false;
    let attempts = 0;
    let timer = 0;
    const targetAccounts = accounts;
    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      await refreshSubmissions(targetAccounts, { silent: true });
      if (!cancelled && attempts < 12) timer = window.setTimeout(() => void poll(), 1_250);
    };
    timer = window.setTimeout(() => void poll(), 750);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [accountIdsKey, refreshSubmissions, submissionStatusRefreshIdsKey]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.kind === "warning" ? 9000 : toast.kind === "error" ? 6000 : 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filteredMessages = useMemo(() => messages.filter((message) => matchesServerMessageQuery(
    message,
    accounts,
    { accountId: selectedAccount, folder: selectedFolder, search: query, messageView: view },
    unreadViewRecentlyReadIds,
  )), [accounts, messages, query, selectedAccount, selectedFolder, unreadViewRecentlyReadIds, view]);

  const loadedServerMessageCount = useMemo(() => {
    if (isDemo) return filteredMessages.length;
    return view === "unread"
      ? messages.filter((message) => !message.seen || !unreadViewRecentlyReadIds.has(message.id)).length
      : messages.length;
  }, [filteredMessages, messages, unreadViewRecentlyReadIds, view]);
  const currentMessageTotal = useMemo(() => isDemo
    ? demoMessageTotal(messages, demoAccounts, {
      accountId: selectedAccount,
      folder: selectedFolder,
      search: debouncedQuery,
      messageView: view,
    })
    : messageTotal, [debouncedQuery, messageTotal, messages, selectedAccount, selectedFolder, view]);
  const recentlyReadVisibleCount = useMemo(() => view === "unread"
    ? filteredMessages.filter((message) => message.seen && unreadViewRecentlyReadIds.has(message.id)).length
    : 0, [filteredMessages, unreadViewRecentlyReadIds, view]);
  const messageCountDescription = view === "unread"
    ? recentlyReadVisibleCount
      ? t("mail.count.unreadWithRetained", { count: currentMessageTotal, retained: recentlyReadVisibleCount })
      : t("mail.count.unread", { count: currentMessageTotal })
    : t("mail.count.total", { count: currentMessageTotal });
  const listToolbarStatus = query
    ? t("mail.search.results", { query })
    : recentlyReadVisibleCount
      ? t("mail.unread.retained", { count: recentlyReadVisibleCount })
      : currentMessageTotal > loadedServerMessageCount
        ? t("mail.loaded", { loaded: loadedServerMessageCount, total: currentMessageTotal })
        : t("mail.recentlySynced");
  const sendingStatusDescription = submissionAttentionCount && submissionActiveCount
    ? t("sending.sidebarAttentionAndActive", { attention: submissionAttentionCount, active: submissionActiveCount })
    : submissionAttentionCount
      ? t("sending.sidebarAttention", { count: submissionAttentionCount })
      : submissionActiveCount
        ? t("sending.sidebarActive", { count: submissionActiveCount })
        : t("sending.sidebarComplete");

  useEffect(() => {
    if (!selectedId || filteredMessages.some((message) => message.id === selectedId)) return;
    setSelectedId(null);
    setRecipientDetailsOpen(false);
  }, [filteredMessages, selectedId]);

  const loadMore = async () => {
    if (loading || loadingMoreRef.current || loadedServerMessageCount >= currentMessageTotal) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const requestId = loadRequestRef.current;
    try {
      const nextQuery = buildMessageQuery({
        accountId: selectedAccount,
        folder: selectedFolder,
        search: debouncedQuery,
        messageView: view,
        page: messagePage + 1,
      });
      const nextPage = await api.messages(nextQuery);
      if (requestId !== loadRequestRef.current) return;
      const pendingMerge = mergePendingArchiveMoves(
        nextPage.items,
        pendingArchiveMovesRef.current,
        accounts,
        { accountId: selectedAccount, folder: selectedFolder, search: debouncedQuery, messageView: view },
      );
      setMessages((items) => {
        const existingIds = new Set(items.map((item) => item.id));
        return [...items, ...pendingMerge.items.filter((item) => !existingIds.has(item.id))];
      });
      setMessagePage(nextPage.page);
      setMessageTotal(Math.max(nextPage.total, pendingMerge.items.length));
    } catch (error) {
      if (requestId === loadRequestRef.current) showToast(mailErrorToastMessage(error, undefined, t), "error");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const selected = filteredMessages.find((message) => message.id === selectedId) ?? null;
  const selectedIsArchived = selected ? isArchivedMessage(selected, accounts) : false;
  const selectedMovePending = selected ? selected.movePending === true || pendingArchiveMoves.some((move) => move.id === selected.id) : false;
  const selectedMoveLocationUnverified = selected?.moveLocationUnverified === true;
  const selectedRemoteActionsBlocked = selectedMovePending || selectedMoveLocationUnverified;
  const selectedMoveActionLabel = selectedMovePending
    ? t("mail.action.moveRefreshing")
    : selectedMoveLocationUnverified
      ? t("mail.action.locationUnverified")
      : null;
  const translationState: TranslationPanelState = selected
    && translationSession?.messageId === selected.id
    && translationSession.targetLocale === locale
    ? translationSession.state
    : { phase: "idle" };
  const refreshTranslationAvailability = useCallback(async () => {
    const requestId = ++translationAvailabilityRequestIdRef.current;
    if (isDemo) {
      setTranslationAvailability("available");
      return;
    }
    setTranslationAvailability("checking");
    try {
      const status = await api.translationStatus();
      if (requestId === translationAvailabilityRequestIdRef.current) {
        setTranslationAvailability(status.configurationError ? "invalid" : status.enabled ? "available" : "unavailable");
      }
    } catch {
      if (requestId === translationAvailabilityRequestIdRef.current) setTranslationAvailability("unknown");
    }
  }, []);
  const selectedMessageAccount = selected ? accounts.find((account) => account.id === selected.accountId) : undefined;
  const visibleAttachments = selected?.attachments.filter((attachment) => !attachment.related) ?? [];
  const selectedAccountRecord = accounts.find((account) => account.id === selectedAccount);
  const localizedProviderName = (account: Pick<Account, "provider" | "providerName">) => providerDisplayName({ id: account.provider, name: account.providerName }, locale, t);
  const sentFolder = selectedAccountRecord?.folders.find((folder) => folder.specialUse === "\\Sent");
  const draftsFolder = selectedAccountRecord?.folders.find((folder) => folder.specialUse === "\\Drafts");
  const selectedFolderRecord = selectedAccountRecord?.folders.find((folder) => folder.path === selectedFolder);
  const emptyMessageList = query.trim()
    ? { title: t("mail.empty.searchTitle"), description: t("mail.empty.searchDescription"), canClearSearch: true }
    : view === "unread"
      ? { title: t("mail.empty.unreadTitle"), description: t("mail.empty.unreadDescription"), canClearSearch: false }
    : view === "starred"
      ? { title: t("mail.empty.starredTitle"), description: t("mail.empty.starredDescription"), canClearSearch: false }
      : view === "archived"
        ? { title: t("mail.empty.archiveTitle"), description: t("mail.empty.archiveDescription"), canClearSearch: false }
      : selectedFolderRecord
          ? { title: t("mail.empty.folderTitle", { folder: selectedFolderRecord.name }), description: t("mail.empty.folderDescription"), canClearSearch: false }
          : { title: t("mail.empty.inboxTitle"), description: t("mail.empty.inboxDescription"), canClearSearch: false };
  const accountIssues = useMemo(() => {
    const issues = new Map<string, MailErrorPresentation>();
    for (const account of accounts) {
      const issue = accountHealthIssue(account, t);
      if (issue) issues.set(account.id, issue);
    }
    return issues;
  }, [accounts, t]);
  const accountsNeedingAttention = accounts.filter((account) => accountIssues.has(account.id));
  const primaryAccountNeedingAttention = accountsNeedingAttention[0];
  const primaryAccountIssue = primaryAccountNeedingAttention ? accountIssues.get(primaryAccountNeedingAttention.id) : undefined;
  const safeHtml = useMemo(
    () => selected?.htmlBody ? sanitizeMailHtml(selected.htmlBody, theme === "dark") : "",
    [selected?.htmlBody, theme],
  );
  const verificationCodes = useMemo(() => {
    if (!selected) return [];
    const htmlText = textFromSanitizedMailHtml(safeHtml);
    return findVerificationCodes({
      subject: selected.subject,
      body: [selected.textBody, selected.snippet, htmlText].filter(Boolean).join("\n"),
    });
  }, [safeHtml, selected]);
  useEffect(() => {
    // Translation is view-local and target-language specific. Never retain a
    // result when the user changes the selected mail or interface language.
    translationRequestIdRef.current += 1;
    setTranslationSession(null);
  }, [locale, selected?.id]);
  useEffect(() => {
    void refreshTranslationAvailability();
    return () => {
      translationAvailabilityRequestIdRef.current += 1;
    };
  }, [refreshTranslationAvailability]);
  const translateSelectedMessage = useCallback(async () => {
    if (!selected || translationState.phase === "loading") return;
    const messageId = selected.id;
    const targetLocale = locale;
    const previous = retainedTranslationContent(translationState);
    const requestId = ++translationRequestIdRef.current;
    setTranslationSession({ messageId, targetLocale, state: { phase: "loading", ...(previous ? { previous } : {}) } });
    try {
      const result = isDemo
        ? demoMessageTranslation(selected, targetLocale)
        : await api.translateMessage(messageId, targetLocale);
      if (requestId !== translationRequestIdRef.current) return;
      setTranslationSession({
        messageId,
        targetLocale,
        state: {
          phase: "ready",
          translatedText: result.translatedText,
          ...(result.detectedLanguage ? { detectedLanguage: result.detectedLanguage } : {}),
          visible: true,
        },
      });
    } catch (error) {
      if (requestId !== translationRequestIdRef.current) return;
      setTranslationSession({
        messageId,
        targetLocale,
        state: { phase: "error", message: translationErrorMessage(error, t), ...(previous ? { previous } : {}) },
      });
    }
  }, [locale, selected, t, translationState.phase]);
  const showSelectedTranslation = useCallback(() => {
    setTranslationSession((current) => {
      if (!selected || !current || current.messageId !== selected.id || current.targetLocale !== locale || current.state.phase !== "ready") {
        return current;
      }
      return { ...current, state: { ...current.state, visible: true } };
    });
  }, [locale, selected]);
  const hideSelectedTranslation = useCallback(() => {
    setTranslationSession((current) => {
      if (!selected || !current || current.messageId !== selected.id || current.targetLocale !== locale || current.state.phase !== "ready") {
        return current;
      }
      return { ...current, state: { ...current.state, visible: false } };
    });
  }, [locale, selected]);
  const copyDetectedVerificationCode = useCallback(async (code: string) => {
    const copied = await copyVerificationCodeToClipboard(code);
    showToast(copied ? t("mail.verification.copied", { code }) : t("mail.verification.copyFailed"), copied ? "success" : "error");
  }, [showToast, t]);

  const applyLocalSeenChange = useCallback((message: Message, nextSeen: boolean) => {
    if (message.seen === nextSeen) return;
    setMessages((items) => {
      const next = applyMessageSeenChange(accounts, items, stats, message.id, nextSeen).messages;
      messagesRef.current = next;
      return next;
    });
    setAccounts((items) => applyMessageSeenChange(items, [message], stats, message.id, nextSeen).accounts);
    setStats((current) => applyMessageSeenChange(accounts, [message], current, message.id, nextSeen).stats);
    if (viewRef.current === "unread") setMessageTotal((total) => Math.max(0, total + (nextSeen ? -1 : 1)));
  }, [accounts, stats]);

  const openCompose = useCallback((draft: ComposeDraft = {}) => {
    setComposeDraft(draft);
    setComposeOpen(true);
  }, []);

  const openMessage = useCallback(async (message: Message) => {
    const account = accounts.find((item) => item.id === message.accountId);
    const isDraft = account?.folders.some((folder) => folder.path === message.mailbox && folder.specialUse === "\\Drafts");
    if (isDraft) {
      setSelectedId(null);
      setRecipientDetailsOpen(false);
      let attachments: OutboundAttachment[] = [];
      if (!isDemo) {
        try {
          attachments = (await api.draftOutboundAttachments(message.id)).items;
          if (!attachments.length && message.attachments.some((attachment) => !attachment.related)) {
            attachments = (await api.importDraftOutboundAttachments(message.id)).items;
          }
        } catch (error) {
          showToast(mailErrorToastMessage(error, t("mail.error.readDraftAttachments"), t), "error");
        }
      }
      openCompose({
        accountId: message.accountId,
        to: message.to.map((recipient) => recipient.address).filter(Boolean).join(", "),
        cc: message.cc.map((recipient) => recipient.address).filter(Boolean).join(", "),
        subject: message.subject,
        text: message.textBody || message.snippet,
        inReplyTo: message.inReplyTo ?? undefined,
        references: message.references,
        sourceDraftId: message.id,
        attachments,
      });
      return;
    }
    lastOpenedMessageIdRef.current = message.id;
    setSelectedId(message.id);
    setRecipientDetailsOpen(false);
    setReaderMoreOpen(false);
    if (!message.seen && !seenMutationIdsRef.current.has(message.id)) {
      seenMutationIdsRef.current.add(message.id);
      updateUnreadViewRecentlyRead(message, true);
      applyLocalSeenChange(message, true);
      if (isDemo) {
        seenMutationIdsRef.current.delete(message.id);
      } else {
        void api.markSeen(message.id, true).catch((error: unknown) => {
          const readMessage = { ...message, seen: true, flags: [...new Set([...message.flags, "\\Seen"])] };
          updateUnreadViewRecentlyRead(readMessage, false);
          applyLocalSeenChange(readMessage, false);
          showToast(t("mail.error.markRead", { message: mailErrorToastMessage(error, t("mail.error.markReadFallback"), t) }), "error");
        }).finally(() => {
          seenMutationIdsRef.current.delete(message.id);
        });
      }
    }
  }, [accounts, applyLocalSeenChange, openCompose, showToast, t, updateUnreadViewRecentlyRead]);

  const closeReader = useCallback((restoreFocus = false) => {
    const messageId = lastOpenedMessageIdRef.current;
    setSelectedId(null);
    setRecipientDetailsOpen(false);
    setReaderMoreOpen(false);
    if (!restoreFocus || !messageId) return;
    window.requestAnimationFrame(() => messageButtonRefs.current.get(messageId)?.focus());
  }, []);

  useEffect(() => {
    if (!selectedId || !isCompactMailLayout()) return;
    const frame = window.requestAnimationFrame(() => readerTitleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId]);

  useEffect(() => {
    if (!readerMoreOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (readerMoreRef.current?.contains(event.target as Node)) return;
      setReaderMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReaderMoreOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [readerMoreOpen]);

  const openReply = useCallback(() => {
    if (!selected) return;
    const reply = buildReplyDraft(selected, [...accounts.map((account) => account.email), selected.accountEmail]);
    openCompose({
      accountId: selected.accountId,
      to: reply.to.join(", "),
      cc: reply.cc.join(", "),
      subject: reply.subject,
      inReplyTo: reply.inReplyTo,
      references: reply.references,
    });
  }, [accounts, openCompose, selected]);

  const openReplyAll = useCallback(() => {
    if (!selected) return;
    const reply = buildReplyDraft(selected, [...accounts.map((account) => account.email), selected.accountEmail], true);
    openCompose({
      accountId: selected.accountId,
      to: reply.to.join(", "),
      cc: reply.cc.join(", "),
      subject: reply.subject,
      inReplyTo: reply.inReplyTo,
      references: reply.references,
    });
  }, [accounts, openCompose, selected]);

  const openForward = useCallback(() => {
    if (!selected) return;
    const forward = buildForwardDraft(
      selected,
      selected.textBody || textFromSanitizedMailHtml(safeHtml) || selected.snippet,
    );
    openCompose({
      accountId: selected.accountId,
      to: forward.to.join(", "),
      cc: forward.cc.join(", "),
      subject: forward.subject,
      text: forward.text,
    });
  }, [openCompose, safeHtml, selected]);

  const moveSelectedMessage = async (target: "archive" | "trash") => {
    if (!selected || messageAction || messageFlagging || selectedRemoteActionsBlocked || (target === "archive" && selectedIsArchived)) return;
    // A response started before this confirmed MOVE still describes the
    // source mailbox. Keep it from replacing the local destination state.
    if (!isDemo) loadRequestRef.current += 1;
    setMessageAction(target);
    try {
      const move = isDemo
        ? { destination: demoMoveDestination(accounts, selected.accountId, target), uid: undefined, refreshPending: false, uncertain: false, locationUnverified: false }
        : await api.moveMessage(selected.id, target);
      if (move.uncertain) {
        // Do not optimistically move an item when the provider connection ended
        // after the command was issued. The durable server intent will resolve
        // from protocol evidence during the background refresh.
        setSelectedId(null);
        setPendingMoveVerifications((current) => current.includes(selected.id) ? current : [...current, selected.id]);
        void load({ silent: true });
        showToast(t("mail.action.moveChecking"), "info");
        return;
      }
      const destination = move.destination;
      const movedSnapshot = applyMessageMove(
        accounts,
        [selected],
        stats,
        selected.id,
        destination,
        move.uid,
        move.refreshPending,
        move.locationUnverified,
      ).messages[0];
      setMessages((items) => {
        const next = applyMessageMove(
          accounts,
          items,
          stats,
          selected.id,
          destination,
          move.uid,
          move.refreshPending,
          move.locationUnverified,
        ).messages;
        messagesRef.current = next;
        return next;
      });
      setAccounts((items) => applyMessageMove(
        items,
        [selected],
        stats,
        selected.id,
        destination,
        move.uid,
        move.refreshPending,
        move.locationUnverified,
      ).accounts);
      setStats((current) => applyMessageMove(
        accounts,
        [selected],
        current,
        selected.id,
        destination,
        move.uid,
        move.refreshPending,
        move.locationUnverified,
      ).stats);
      if (movedSnapshot) {
        const currentQuery: MessageListQuery = {
          accountId: selectedAccount,
          folder: selectedFolder,
          search: debouncedQuery,
          messageView: view,
        };
        const wasIncluded = matchesServerMessageQuery(selected, accounts, currentQuery);
        const remainsIncluded = matchesServerMessageQuery(movedSnapshot, accounts, currentQuery);
        setMessageTotal((total) => nextMessageTotalForMove(total, wasIncluded, remainsIncluded));
        if (!isDemo && target === "archive" && move.refreshPending) {
          replacePendingArchiveMoves([
            ...pendingArchiveMovesRef.current.filter((pending) => pending.id !== selected.id),
            { id: selected.id, accountId: selected.accountId, destination, snapshot: movedSnapshot },
          ]);
        }
        if (!isDemo && move.refreshPending) {
          setPendingMoveVerifications((current) => current.includes(selected.id) ? current : [...current, selected.id]);
        }
      }
      if (unreadViewRecentlyReadIdsRef.current.has(selected.id)) {
        const nextRecentlyRead = new Set(unreadViewRecentlyReadIdsRef.current);
        nextRecentlyRead.delete(selected.id);
        unreadViewRecentlyReadIdsRef.current = nextRecentlyRead;
        setUnreadViewRecentlyReadIds(nextRecentlyRead);
      }
      if (move.locationUnverified && target === "archive") {
        // The server confirmed the archive move, but no stable remote UID is
        // available. Keep the user in the retained local snapshot instead of
        // leaving the only explanation behind a transient toast.
        setView("archived");
        setSelectedFolder("");
        setQuery("");
        setDebouncedQuery("");
        setSelectedId(selected.id);
      } else {
        setSelectedId(null);
      }
      showToast(
        move.locationUnverified
          ? t("mail.action.movedLocationUnverified")
          : move.refreshPending
          ? t("mail.action.moveRefreshing")
          : target === "archive" ? t("mail.action.archived") : t("mail.action.trashed"),
        move.refreshPending || move.locationUnverified ? "info" : "success",
      );
      if (!isDemo && !move.refreshPending) void load({ silent: true });
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
    } finally {
      setMessageAction(null);
    }
  };

  const toggleSelectedStar = async () => {
    if (!selected || messageFlagging || selectedRemoteActionsBlocked) return;
    const nextFlagged = !selected.flagged;
    setMessageFlagging(true);
    try {
      if (!isDemo) await api.updateMessageFlags(selected.id, { flagged: nextFlagged });
      setMessages((items) => items.map((item) => {
        if (item.id !== selected.id) return item;
        const flags = new Set(item.flags);
        if (nextFlagged) flags.add("\\Flagged");
        else flags.delete("\\Flagged");
        return { ...item, flagged: nextFlagged, flags: [...flags] };
      }));
      if (view === "starred" && !nextFlagged) setSelectedId(null);
      showToast(nextFlagged ? t("mail.action.starred") : t("mail.action.unstarred"));
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.updateStar"), t), "error");
    } finally {
      setMessageFlagging(false);
    }
  };

  const toggleSelectedSeen = async () => {
    if (!selected || messageFlagging || selectedRemoteActionsBlocked || seenMutationIdsRef.current.has(selected.id)) return;
    const nextSeen = !selected.seen;
    seenMutationIdsRef.current.add(selected.id);
    setMessageFlagging(true);
    updateUnreadViewRecentlyRead(selected, nextSeen);
    applyLocalSeenChange(selected, nextSeen);
    try {
      if (!isDemo) await api.updateMessageFlags(selected.id, { seen: nextSeen });
      showToast(nextSeen ? t("mail.action.markedRead") : t("mail.action.markedUnread"));
    } catch (error) {
      const changedMessage = { ...selected, seen: nextSeen, flags: nextSeen ? [...new Set([...selected.flags, "\\Seen"])] : selected.flags.filter((flag) => flag !== "\\Seen") };
      updateUnreadViewRecentlyRead(changedMessage, selected.seen);
      applyLocalSeenChange(changedMessage, selected.seen);
      showToast(mailErrorToastMessage(error, t("mail.error.updateRead"), t), "error");
    } finally {
      seenMutationIdsRef.current.delete(selected.id);
      setMessageFlagging(false);
    }
  };

  const downloadAttachment = async (message: Message, attachment: MessageAttachment) => {
    if (pendingArchiveMovesRef.current.some((move) => move.id === message.id) || message.movePending) {
      showToast(t("mail.action.moveRefreshing"), "info");
      return;
    }
    if (message.moveLocationUnverified) {
      showToast(t("mail.action.locationUnverified"), "info");
      return;
    }
    if (isDemo) {
      showToast(t("mail.attachment.demoUnavailable"), "info");
      return;
    }
    const downloadKey = `${message.id}:${attachment.partId}`;
    if (attachmentDownloads[downloadKey]?.phase === "downloading") return;
    setAttachmentDownloads((current) => ({ ...current, [downloadKey]: { phase: "downloading" } }));
    try {
      const blob = await api.downloadAttachment(message.id, attachment.partId);
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = attachment.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
      setAttachmentDownloads((current) => ({ ...current, [downloadKey]: { phase: "ready" } }));
      window.setTimeout(() => {
        setAttachmentDownloads((current) => {
          if (current[downloadKey]?.phase !== "ready") return current;
          const next = { ...current };
          delete next[downloadKey];
          return next;
        });
      }, 3_600);
      showToast(t("mail.attachment.downloadStarted", { filename: attachment.filename }));
    } catch (error) {
      const detail = mailErrorMessage(error, t("mail.error.downloadAttachment"), t);
      setAttachmentDownloads((current) => ({ ...current, [downloadKey]: { phase: "error", detail } }));
      showToast(mailErrorToastMessage(error, t("mail.error.downloadAttachment"), t), "error");
    }
  };

  const removeAccountFromView = useCallback((accountId: string) => {
    const account = accounts.find((item) => item.id === accountId);
    const removesSelectedAccount = selectedAccount === accountId;
    const removesSelectedMessage = messages.some((message) => message.id === selectedId && message.accountId === accountId);
    const inboxFolders = account?.folders.filter((folder) => folder.specialUse === "\\Inbox" || folder.path.toUpperCase() === "INBOX") ?? [];
    const removedMessageCount = inboxFolders.reduce((total, folder) => total + folder.total, 0);
    const removedUnreadCount = inboxFolders.reduce((total, folder) => total + folder.unseen, 0);
    const removedMessageIds = new Set(messages.filter((message) => message.accountId === accountId).map((message) => message.id));
    if (removedMessageIds.size) {
      const nextRecentlyRead = new Set([...unreadViewRecentlyReadIdsRef.current].filter((id) => !removedMessageIds.has(id)));
      unreadViewRecentlyReadIdsRef.current = nextRecentlyRead;
      setUnreadViewRecentlyReadIds(nextRecentlyRead);
    }
    setAccounts((items) => items.filter((account) => account.id !== accountId));
    setMessages((items) => items.filter((message) => message.accountId !== accountId));
    setStats((value) => ({
      accounts: Math.max(0, value.accounts - 1),
      messages: Math.max(0, value.messages - removedMessageCount),
      unread: Math.max(0, value.unread - removedUnreadCount),
    }));
    if (isDemo) {
      const removedVisibleMessages = messages.filter((message) => message.accountId === accountId).length;
      setMessageTotal((total) => Math.max(0, total - removedVisibleMessages));
    } else {
      const nextAccountId = removesSelectedAccount ? "all" : selectedAccount;
      const nextFolder = removesSelectedAccount ? "" : selectedFolder;
      void load({ silent: true, accountId: nextAccountId, folder: nextFolder });
    }
    if (removesSelectedAccount) {
      setSelectedAccount("all");
      setSelectedFolder("");
    }
    if (removesSelectedMessage) {
      setSelectedId(null);
      setRecipientDetailsOpen(false);
    }
  }, [accounts, load, messages, selectedAccount, selectedFolder, selectedId]);

  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    void updateSettings({ theme: nextTheme }).catch((error: unknown) => {
      showToast(mailErrorToastMessage(error, t("settings.error.updateTheme"), t), "error");
    });
  };

  const testDesktopNotification = useCallback(async (testSettings: AppSettings) => {
    const bridge = desktopBridge();
    if (isDesktop && !bridge) throw new Error(t("settings.error.desktopNotificationsUnavailable"));
    const customSound = testSettings.notificationSound === "soft" || testSettings.notificationSound === "bright";
    const customSoundReady = customSound && await primeNotificationSound();
    reportCustomNotificationSoundAvailability();
    const payload = {
      title: "Nami Mail",
      body: t("settings.notifications.testBody"),
      silent: testSettings.notificationSound === "none" || customSoundReady,
    };
    if (bridge) {
      const result = await bridge.notify(payload);
      if (!result.shown) throw new Error(t("settings.error.systemNotificationsUnavailable"));
      return;
    }
    if (!("Notification" in window)) throw new Error(t("settings.error.browserNotificationsUnsupported"));
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(t("settings.error.notificationsPermission"));
    new Notification(payload.title, payload);
  }, [t]);

  const testNotificationSound = useCallback(async (sound: AppSettings["notificationSound"]) => {
    if (sound === "none") return;
    if (sound === "system") {
      await testDesktopNotification({ ...settings, notificationSound: sound });
      return;
    }
    const primed = await primeNotificationSound();
    reportCustomNotificationSoundAvailability();
    if (primed && playNotificationSound(sound)) return;
    desktopBridge()?.setCustomNotificationSoundReady(false);
    await testDesktopNotification({ ...settings, notificationSound: "system" });
    desktopBridge()?.setCustomNotificationSoundReady(false);
  }, [settings, testDesktopNotification]);

  const openNotifiedMessage = useCallback(async (messageId: string) => {
    if (isDemo) {
      const message = demoMessages.find((item) => item.id === messageId);
      if (message) await openMessage(message);
      return;
    }
    try {
      const message = await api.message(messageId);
      setMessages((items) => items.some((item) => item.id === message.id) ? items : [message, ...items]);
      await openMessage(message);
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.openNew"), t), "error");
      void load({ silent: true });
    }
  }, [load, openMessage, showToast, t]);

  useEffect(() => {
    const unlockAudio = () => {
      void primeNotificationSound().then(reportCustomNotificationSoundAvailability, reportCustomNotificationSoundAvailability);
    };
    const reportAudioAvailability = () => reportCustomNotificationSoundAvailability();
    reportAudioAvailability();
    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);
    window.addEventListener("focus", reportAudioAvailability);
    document.addEventListener("visibilitychange", reportAudioAvailability);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      window.removeEventListener("focus", reportAudioAvailability);
      document.removeEventListener("visibilitychange", reportAudioAvailability);
      desktopBridge()?.setCustomNotificationSoundReady(false);
    };
  }, []);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge || isDemo) return undefined;
    const unsubscribeNewMail = bridge.onNewMail((notice) => {
      void load({ silent: true });
      if (!notice.shouldAlert) return;
      if (notice.playCustomSound && !playNotificationSound(settings.notificationSound)) {
        bridge.setCustomNotificationSoundReady(false);
        const sender = notice.fromName || notice.fromAddress || t("mail.notification.newContact");
        void bridge.notify({
          title: notice.count === 1 ? t("mail.notification.singleTitle", { sender }) : t("mail.notification.multipleTitle", { count: notice.count }),
          body: notice.count === 1 ? notice.subject : t("mail.notification.multipleBody", { sender }),
          silent: false,
        }).catch(() => undefined);
      }
      showToast(notice.count === 1
        ? t("mail.notification.singleToast", { sender: notice.fromName || notice.fromAddress || t("mail.notification.newContact") })
        : t("mail.notification.multipleToast", { count: notice.count }));
    });
    const unsubscribeOpenMessage = bridge.onOpenMessage((messageId) => {
      void openNotifiedMessage(messageId);
    });
    return () => {
      unsubscribeNewMail();
      unsubscribeOpenMessage();
    };
  }, [load, openNotifiedMessage, settings.notificationSound, showToast, t]);

  useEffect(() => {
    if (!isDesktopSmoke) return;
    const report = (payload: { invoked: boolean; shown?: boolean; error?: string }) => {
      document.documentElement.dataset.namiDesktopSmokeNotification = JSON.stringify(payload);
    };
    const bridge = desktopBridge();
    if (!bridge) {
      report({ invoked: false, error: "Desktop bridge is unavailable." });
      return;
    }
    void bridge.notify({
      title: "Nami Mail",
      body: "Desktop notification bridge smoke test",
      silent: true,
    }).then(
      (result) => report({ invoked: true, shown: result.shown }),
      (error: unknown) => report({
        invoked: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (updatePromptOpen) {
        if (event.key === "Escape") event.preventDefault();
        return;
      }
      const isTyping = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || Boolean(target instanceof Element && target.closest(".select-control"))
        || Boolean(target instanceof HTMLElement && target.isContentEditable);
      if (event.key === "Escape") {
        if (settingsOpen) setSettingsOpen(false);
        else if (composeOpen) return;
        else if (addOpen) setAddOpen(false);
        else if (mobileSidebar) setMobileSidebar(false);
        else if (selectedId) closeReader(true);
        return;
      }
      if (settingsOpen || sendingStatusOpen || composeOpen || addOpen || mobileSidebar) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (isTyping || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        if (accounts.length) openCompose();
        else setAddOpen(true);
        return;
      }
      if (key === "r" && selected) {
        event.preventDefault();
        if (event.shiftKey) openReplyAll();
        else openReply();
        return;
      }
      if (key === "f" && selected) {
        event.preventDefault();
        openForward();
        return;
      }
      if (key !== "j" && key !== "k") return;
      const currentIndex = filteredMessages.findIndex((message) => message.id === selectedId);
      const direction = key === "j" ? 1 : -1;
      const nextIndex = currentIndex === -1 ? (direction === 1 ? 0 : filteredMessages.length - 1) : currentIndex + direction;
      const nextMessage = filteredMessages[nextIndex];
      if (nextMessage) {
        event.preventDefault();
        void openMessage(nextMessage);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [accounts.length, addOpen, closeReader, composeOpen, filteredMessages, mobileSidebar, openCompose, openForward, openMessage, openReply, openReplyAll, selected, selectedId, sendingStatusOpen, settingsOpen, updatePromptOpen]);

  const sync = async () => {
    if (!accounts.length || syncing) return;
    clearUnreadViewRecentlyRead();
    setSyncing(true);
    try {
      if (!isDemo) {
        const targets = selectedAccount === "all" ? accounts : accounts.filter((account) => account.id === selectedAccount);
        const settled = await Promise.allSettled(targets.map((account) => api.sync(account.id)));
        await load({ silent: true });
        const results = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const failedAccounts = settled.length - results.length;
        const synced = results.reduce((sum, result) => sum + result.synced, 0);
        const folders = results.reduce((sum, result) => sum + result.folders, 0);
        const failedFolders = results.reduce((sum, result) => sum + result.failedFolders, 0);
        const firstFailure = settled.find((result) => result.status === "rejected");
        const failureIssue = firstFailure?.status === "rejected" ? presentMailError(firstFailure.reason, t) : null;
        if (!results.length && failedAccounts) {
          throw firstFailure?.status === "rejected" ? firstFailure.reason : new Error(t("mail.sync.allFailed"));
        }
        const partialFailure = failedAccounts > 0 || failedFolders > 0;
        showToast(
          partialFailure
            ? failedAccounts
              ? t("mail.sync.partialAccounts", { synced, accounts: failedAccounts, issue: failureIssue?.title ?? "" })
              : t("mail.sync.partialFolders", { synced, folders: failedFolders })
            : t("mail.sync.completed", { synced, folders }),
          partialFailure ? "error" : "success",
        );
      } else {
        await new Promise((resolve) => setTimeout(resolve, 700));
        showToast(t("mail.sync.demoRefreshed"));
      }
    } catch (error) {
      showToast(t("mail.sync.failed", { message: mailErrorToastMessage(error, undefined, t) }), "error");
    } finally {
      setSyncing(false);
    }
  };

  const retryAccountSync = useCallback(async (accountId: string) => {
    if (isDemo) {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      return { ok: true, synced: 0, folders: 0, failedFolders: 0 };
    }
    try {
      return await api.sync(accountId);
    } finally {
      // A failed sync persists a new health code on the server. Refresh it before the caller shows the recovery path.
      try {
        await load({ silent: true });
      } catch {
        // The sync result remains the primary outcome; load already owns its non-blocking fatal state.
      }
    }
  }, [load]);

  const chooseView = (next: MailView) => {
    viewRef.current = next;
    clearUnreadViewRecentlyRead();
    setView(next);
    setSelectedFolder("");
    setSelectedId(null);
    setRecipientDetailsOpen(false);
    setMobileSidebar(false);
  };

  const chooseFolder = (path: string) => {
    viewRef.current = "inbox";
    clearUnreadViewRecentlyRead();
    setSelectedFolder(path);
    setView("inbox");
    setSelectedId(null);
    setRecipientDetailsOpen(false);
    setMobileSidebar(false);
  };

  return (
    <div className={`workspace-canvas${activeBackgroundUrl ? " background-active" : ""}`}>
      {activeBackgroundUrl && (
        <div
          key={activeBackgroundUrl}
          className="workspace-background"
          style={{ backgroundImage: `url("${activeBackgroundUrl}")`, opacity: settings.backgroundIntensity / 100 }}
          aria-hidden="true"
        />
      )}
      <div className={`app-frame${isDesktop ? " desktop-app" : ""}`}>
      {!isDesktop && (
        <div className="window-bar">
          <span className="window-title">Nami Mail</span>
          <div className="window-actions"><span className="local-pill"><span /> {t("app.localEncryption")}</span><IconButton label={theme === "light" ? t("app.switchDark") : t("app.switchLight")} onClick={toggleTheme}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</IconButton></div>
        </div>
      )}

      <main className={`mail-shell${selected ? " has-open-message" : ""}`}>
        <aside
          ref={sidebarRef}
          className={`sidebar ${mobileSidebar ? "open" : ""}`}
          role={mobileSidebar ? "dialog" : undefined}
          aria-modal={mobileSidebar ? true : undefined}
          aria-label={mobileSidebar ? t("navigation.mail") : undefined}
          tabIndex={mobileSidebar ? -1 : undefined}
        >
          <div className="brand-row">
            <div className="brand-mark" aria-hidden="true">
              <img className="brand-mark-image brand-mark-light" src="/brand/mark-light.png" alt="" />
              <img className="brand-mark-image brand-mark-dark" src="/brand/mark-dark.png" alt="" />
            </div>
            <div><strong>Nami Mail</strong><span>{t("app.localMailSpace")}</span></div>
            <IconButton label={t("navigation.closeMenu")} className="mobile-only" onClick={() => setMobileSidebar(false)}><X size={18} /></IconButton>
          </div>

          <button className="compose-button" type="button" onClick={() => { setMobileSidebar(false); if (accounts.length) openCompose(); else setAddOpen(true); }}><PenLine size={18} />{t("mail.compose")}</button>

          <nav className="nav-section" aria-label={t("navigation.mailViews")}>
            <button aria-pressed={view === "inbox" && !selectedFolder} className={view === "inbox" && !selectedFolder ? "active" : ""} onClick={() => chooseView("inbox")}><Inbox size={18} /><span>{t("mail.unifiedInbox")}</span><em className="sidebar-count" data-tooltip={t("mail.inboxCountTooltip")}>{sidebarCounts.inbox || ""}</em></button>
            <button aria-pressed={view === "unread"} className={view === "unread" ? "active" : ""} onClick={() => chooseView("unread")}><Mail size={18} /><span>{t("mail.unread")}</span><em className="sidebar-count" data-tooltip={t("mail.unreadCountTooltip")}>{sidebarCounts.unread || ""}</em></button>
            <button aria-pressed={view === "starred"} className={view === "starred" ? "active" : ""} onClick={() => chooseView("starred")}><Star size={18} /><span>{t("mail.starred")}</span></button>
            <button aria-pressed={view === "archived"} className={view === "archived" ? "active" : ""} onClick={() => chooseView("archived")}><Archive size={18} /><span>{t("mail.action.archive")}</span></button>
            <button className={selectedFolder === draftsFolder?.path ? "active" : ""} disabled={!draftsFolder} onClick={() => draftsFolder && chooseFolder(draftsFolder.path)}><FileText size={18} /><span>{t("mail.drafts")}</span></button>
            <button className={selectedFolder === sentFolder?.path ? "active" : ""} disabled={!sentFolder} onClick={() => sentFolder && chooseFolder(sentFolder.path)}><Send size={18} /><span>{t("mail.sent")}</span></button>
            <button className={`sending-status-nav${submissionAttentionCount ? " attention" : ""}`} aria-label={t("sending.sidebarAria", { status: sendingStatusDescription })} aria-haspopup="dialog" data-tooltip={sendingStatusDescription} onClick={() => { setMobileSidebar(false); setSendingStatusOpen(true); void refreshSubmissions(accounts, { silent: true }); }}>{submissionAttentionCount ? <CircleAlert size={18} /> : <Send size={18} />}<span>{t("sending.title")}</span><em aria-hidden="true">{submissionOutstandingCount || ""}</em></button>
          </nav>

          <div className="accounts-heading"><span>{t("mail.accounts")}</span><IconButton label={t("account.add")} onClick={() => { setMobileSidebar(false); setAddOpen(true); }}><Plus size={16} /></IconButton></div>
          <div className="account-list">
            <button aria-pressed={selectedAccount === "all"} className={selectedAccount === "all" ? "active" : ""} onClick={() => { clearUnreadViewRecentlyRead(); setSelectedAccount("all"); setSelectedFolder(""); setSelectedId(null); setRecipientDetailsOpen(false); setMobileSidebar(false); }}><span className="account-avatar all"><Sparkles size={14} /></span><span className="account-copy"><strong>{t("mail.allAccounts")}</strong><small>{t("mail.accountCount", { count: accounts.length })}</small></span></button>
            {accounts.map((account) => {
              const issue = accountIssues.get(account.id);
              const providerName = localizedProviderName(account);
              const freshness = formatSyncFreshness(account.lastSyncedAt, t);
              return (
                <button key={account.id} aria-pressed={selectedAccount === account.id} className={selectedAccount === account.id ? "active" : ""} data-tooltip={issue ? t("mail.accountIssueTooltip", { title: issue.title, guidance: issue.guidance }) : t("mail.accountFreshness", { provider: providerName, freshness })} onClick={() => { clearUnreadViewRecentlyRead(); setSelectedAccount(account.id); setSelectedFolder(""); setSelectedId(null); setRecipientDetailsOpen(false); setMobileSidebar(false); }}>
                  <span className={`account-avatar tone-${accountTone(account.email)}`}>{account.email[0]?.toUpperCase()}</span>
                  <span className="account-copy"><strong>{account.email.split("@")[0]}</strong><small>{issue?.title ?? t("mail.accountFreshness", { provider: providerName, freshness })}</small></span>
                  <span className={`status-dot ${issue ? "error" : account.status}`} aria-hidden="true" />
                </button>
              );
            })}
          </div>

          {selectedAccountRecord && selectedAccountRecord.folders.length > 0 && (
            <div className="folder-list">
              <span className="folder-title">{t("mail.folders")}</span>
              {selectedAccountRecord.folders.map((folder) => (
                <button key={folder.path} className={selectedFolder === folder.path ? "active" : ""} onClick={() => chooseFolder(folder.path)}><Archive size={15} /><span>{folder.name}</span><em>{folder.unseen || ""}</em></button>
              ))}
            </div>
          )}

          <div className="sidebar-footer">
            <div><ShieldCheck size={16} /><span><strong>{t("app.localEncryption")}</strong><small>{t("app.credentialsLocal")}</small></span></div>
            <div className="sidebar-footer-actions"><IconButton label={t("settings.title")} onClick={() => { setMobileSidebar(false); setSettingsOpen(true); }}><Settings size={17} /></IconButton><span className="version">v{__NAMI_APP_VERSION__}</span></div>
          </div>
        </aside>

        <section className="message-column">
          <header className="column-header">
            <IconButton label={t("navigation.openMenu")} className="mobile-only" buttonRef={mobileMenuButtonRef} onClick={() => setMobileSidebar(true)}><Menu size={19} /></IconButton>
            <div><span className="eyebrow">{selectedAccount === "all" ? t("mail.unifiedMailbox") : selectedAccountRecord ? localizedProviderName(selectedAccountRecord).toUpperCase() : ""}</span><h1>{view === "unread" ? t("mail.unread") : view === "starred" ? t("mail.starred") : view === "archived" ? t("mail.action.archive") : selectedFolderRecord?.name || t("mail.inbox")}</h1></div>
            <div className="header-actions"><span className="message-count" aria-label={messageCountDescription} data-tooltip={messageCountDescription}>{currentMessageTotal}</span><IconButton label={t("mail.compose")} className="mobile-only mobile-compose-action" onClick={() => accounts.length ? openCompose() : setAddOpen(true)}><PenLine size={17} /></IconButton>{isDesktop && <IconButton label={theme === "light" ? t("app.switchDark") : t("app.switchLight")} onClick={toggleTheme}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</IconButton>}<IconButton label={t("mail.sync.action")} onClick={() => void sync()} disabled={syncing || !accounts.length}><RefreshCw className={syncing ? "spin" : ""} size={17} /></IconButton></div>
          </header>

          <div className="search-wrap"><Search size={17} /><label className="visually-hidden" htmlFor="mail-search">{t("mail.search")}</label><input id="mail-search" ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("mail.searchPlaceholder")} />{query && <IconButton label={t("mail.clearSearch")} className="search-clear" onClick={() => { setQuery(""); setDebouncedQuery(""); searchInputRef.current?.focus(); }}><X size={15} /></IconButton>}</div>

          {accountsNeedingAttention.length > 0 && (
            <div className="account-health-banner" role="status">
              <CircleAlert size={17} />
              <span><strong>{t("mail.accountAttention", { count: accountsNeedingAttention.length })}</strong><small>{primaryAccountNeedingAttention && primaryAccountIssue ? t("mail.accountProblem", { email: primaryAccountNeedingAttention.email, title: primaryAccountIssue.title }) : t("mail.otherAccountsAvailable")}</small></span>
              <button type="button" onClick={() => setSettingsOpen(true)}>{t("mail.viewReason")}</button>
            </div>
          )}

          <div className="list-toolbar"><span className="sort-label">{t("mail.newestFirst")}</span><span className={recentlyReadVisibleCount ? "unread-retention-note" : ""} aria-live={recentlyReadVisibleCount ? "polite" : undefined}>{listToolbarStatus}</span></div>

          <div className="message-list">
            {loading && <div className="center-state"><LoaderCircle className="spin" size={24} /><p>{t("mail.loading")}</p></div>}
            {!loading && fatalError && <div className="center-state error-state"><X size={24} /><h3>{fatalError.title}</h3><p>{fatalError.message} {fatalError.guidance}</p><button className="secondary-button" onClick={() => void load()}>{t("mail.reconnect")}</button></div>}
            {!loading && !fatalError && !accounts.length && (
              <div className="center-state empty-state"><div className="empty-orb"><Mail size={28} /></div><h3>{t("mail.empty.firstAccountTitle")}</h3><p>{t("mail.empty.firstAccountDescription")}</p><button className="primary-button" onClick={() => setAddOpen(true)}><Plus size={17} />{t("account.add")}</button></div>
            )}
            {!loading && accounts.length > 0 && filteredMessages.length === 0 && (
              <div className="center-state empty-state">
                {emptyMessageList.canClearSearch ? <Search size={24} /> : <Mail size={24} />}
                <h3>{emptyMessageList.title}</h3>
                <p>{emptyMessageList.description}</p>
                {emptyMessageList.canClearSearch && <button className="secondary-button" type="button" onClick={() => { setQuery(""); setDebouncedQuery(""); searchInputRef.current?.focus(); }}>{t("mail.clearSearch")}</button>}
              </div>
            )}
            {filteredMessages.map((message) => (
              <button key={message.id} ref={(node) => { if (node) messageButtonRefs.current.set(message.id, node); else messageButtonRefs.current.delete(message.id); }} className={`message-item ${selectedId === message.id ? "selected" : ""} ${message.seen ? "" : "unread"} ${view === "unread" && message.seen && unreadViewRecentlyReadIds.has(message.id) ? "recently-read-in-unread" : ""}`} onClick={() => void openMessage(message)}>
                <span className="visually-hidden">{t("mail.messageAria", { readState: message.seen ? t("mail.read") : t("mail.unread"), starred: message.flagged ? t("mail.messageStarred") : "", attachments: message.hasAttachments ? t("mail.messageHasAttachments") : "" })}</span>
                <span className={`sender-avatar tone-${accountTone(message.from.address)}`}>{initials(message.from.name, message.from.address)}</span>
                <span className="message-copy">
                  <span className="message-meta"><strong>{message.from.name || message.from.address}</strong><time>{formatMessageTime(message.sentAt, locale)}</time></span>
                  <span className="message-subject">{message.subject}</span>
                  <span className="message-snippet">{message.snippet}</span>
                  <span className="message-tags"><i>{message.accountEmail.split("@")[0]}</i>{message.moveLocationUnverified && <i className="message-local-copy">{t("mail.messageLocalReadOnly")}</i>}{message.hasAttachments && <Paperclip size={13} />}{message.flagged && <Star size={13} fill="currentColor" />}</span>
                </span>
                {!message.seen && <span className="unread-dot" />}
              </button>
            ))}
            {!loading && !fatalError && filteredMessages.length > 0 && loadedServerMessageCount < currentMessageTotal && query === debouncedQuery && (
              <div className="list-footer">
                <button className="secondary-button" type="button" onClick={() => void loadMore()} disabled={loading || loadingMore}>
                  {loadingMore ? <LoaderCircle className="spin" size={15} /> : null}{loadingMore ? t("common.loading") : t("mail.loadMore")} <span>{loadedServerMessageCount} / {currentMessageTotal}</span>
                </button>
              </div>
            )}
          </div>
        </section>

        <section className={`reader-column ${selected ? "has-message" : ""}`}>
          {selected ? (
            <>
              <header className="reader-toolbar">
                <IconButton label={t("mail.reader.backToList")} className="reader-back" onClick={() => closeReader(true)}><ArrowLeft size={18} /></IconButton>
                <div className="reader-actions">
                  <IconButton label={t("mail.action.reply")} onClick={openReply}><Reply size={18} /></IconButton>
                  <IconButton label={t("mail.action.replyAll")} className="reader-action-secondary" onClick={openReplyAll}><ReplyAll size={18} /></IconButton>
                  <IconButton label={t("mail.action.forward")} className="reader-action-secondary" onClick={openForward}><Forward size={18} /></IconButton>
                  <span className="toolbar-divider" aria-hidden="true" />
                  <IconButton label={selectedMoveActionLabel ?? (selected.seen ? t("mail.action.markUnread") : t("mail.action.markRead"))} onClick={() => void toggleSelectedSeen()} disabled={messageFlagging || selectedRemoteActionsBlocked}>{selected.seen ? <Mail size={18} /> : <MailOpen size={18} />}</IconButton>
                  <IconButton label={selectedMoveActionLabel ?? (selected.flagged ? t("mail.action.unstar") : t("mail.action.star"))} className={selected.flagged ? "active-star" : ""} onClick={() => void toggleSelectedStar()} disabled={messageFlagging || selectedRemoteActionsBlocked}><Star size={18} fill={selected.flagged ? "currentColor" : "none"} /></IconButton>
                  <IconButton label={selectedMoveActionLabel ?? t("mail.action.archive")} className="reader-action-secondary" onClick={() => void moveSelectedMessage("archive")} disabled={messageAction !== null || messageFlagging || selectedRemoteActionsBlocked || selectedIsArchived}><Archive size={18} /></IconButton>
                  <IconButton label={selectedMoveActionLabel ?? t("mail.action.moveToTrash")} className="reader-action-secondary" onClick={() => void moveSelectedMessage("trash")} disabled={messageAction !== null || messageFlagging || selectedRemoteActionsBlocked}><Trash2 size={18} /></IconButton>
                  <div className="reader-more" ref={readerMoreRef}>
                    <IconButton label={t("mail.action.more")} className="reader-more-toggle" onClick={() => setReaderMoreOpen((value) => !value)} expanded={readerMoreOpen}><MoreHorizontal size={19} /></IconButton>
                    {readerMoreOpen && (
                      <div className="reader-more-menu" role="menu" aria-label={t("mail.action.more")}>
                        <button type="button" role="menuitem" onClick={() => { setReaderMoreOpen(false); openReplyAll(); }}><ReplyAll size={16} />{t("mail.action.replyAll")}</button>
                        <button type="button" role="menuitem" onClick={() => { setReaderMoreOpen(false); openForward(); }}><Forward size={16} />{t("mail.action.forward")}</button>
                        <button type="button" role="menuitem" disabled={messageAction !== null || messageFlagging || selectedRemoteActionsBlocked || selectedIsArchived} onClick={() => { setReaderMoreOpen(false); void moveSelectedMessage("archive"); }}><Archive size={16} />{t("mail.action.archive")}</button>
                        <button type="button" role="menuitem" className="reader-more-danger" disabled={messageAction !== null || messageFlagging || selectedRemoteActionsBlocked} onClick={() => { setReaderMoreOpen(false); void moveSelectedMessage("trash"); }}><Trash2 size={16} />{t("mail.action.moveToTrash")}</button>
                      </div>
                    )}
                  </div>
                </div>
              </header>
                {selectedMoveLocationUnverified && <section className="move-location-notice" role="status"><CircleAlert size={18} /><div><strong>{t("mail.moveLocationUnverified.title")}</strong><p>{t("mail.moveLocationUnverified.description")}</p></div></section>}
                <article className="mail-reader">
                <header className="mail-title"><span className="account-badge">{selectedMessageAccount ? localizedProviderName(selectedMessageAccount) : selected.providerName}</span><h2 ref={readerTitleRef} tabIndex={-1}>{selected.subject}</h2><div className="mail-people"><span className={`sender-avatar large tone-${accountTone(selected.from.address)}`}>{initials(selected.from.name, selected.from.address)}</span><div className="mail-people-copy"><strong>{selected.from.name || selected.from.address}</strong><button className="mail-recipient-toggle" type="button" data-tooltip={selected.from.address} aria-expanded={recipientDetailsOpen} onClick={() => setRecipientDetailsOpen((value) => !value)}>{t("mail.reader.toMe")} <ChevronDown className={recipientDetailsOpen ? "open" : ""} size={13} /></button>{recipientDetailsOpen && <div className="mail-recipient-details"><span>{t("compose.sender")}</span><strong>{selected.from.name ? `${selected.from.name} <${selected.from.address}>` : selected.from.address}</strong><span>{t("compose.to")}</span><strong>{selected.to.length ? selected.to.map((recipient) => recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address).join(t("common.listSeparator")) : selected.accountEmail}</strong>{selected.cc.length > 0 && <><span>{t("compose.cc")}</span><strong>{selected.cc.map((recipient) => recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address).join(t("common.listSeparator"))}</strong></>}</div>}</div><time>{formatFullDate(selected.sentAt, locale)}</time></div></header>
                {verificationCodes.length > 0 && (
                  <section className="verification-code-list" aria-label={t("mail.verification.detected") }>
                    {verificationCodes.map((candidate, index) => {
                      const isPrimaryVerificationCode = index === 0;
                      const sourceLabel = candidate.source === "subject" ? t("mail.verification.subject") : t("mail.verification.body");
                      return (
                        <section className={`verification-code-panel ${isPrimaryVerificationCode ? "primary" : "candidate"}`} key={`${candidate.code}:${candidate.source}`} aria-label={isPrimaryVerificationCode ? t("mail.verification.detected") : t("mail.verification.otherCandidate")}>
                          <div><span>{isPrimaryVerificationCode ? t("mail.verification.label", { source: sourceLabel }) : t("mail.verification.otherLabel", { source: sourceLabel })}</span><strong>{candidate.code}</strong></div>
                          <button className="secondary-button verification-code-copy" type="button" onClick={() => void copyDetectedVerificationCode(candidate.code)} aria-label={t("mail.verification.copyAria", { code: candidate.code })} data-tooltip={t("mail.verification.copyTooltip")}><Copy size={15} />{isPrimaryVerificationCode ? t("mail.verification.copy") : t("common.copy")}</button>
                        </section>
                      );
                    })}
                  </section>
                )}
                <TranslationPanel
                  availability={translationAvailability}
                  state={translationState}
                  onCheckAvailability={() => void refreshTranslationAvailability()}
                  onTranslate={() => void translateSelectedMessage()}
                  onShow={showSelectedTranslation}
                  onHide={hideSelectedTranslation}
                />
                <div className="mail-content">
                  {selected.htmlBody ? <div className="mail-html" dangerouslySetInnerHTML={{ __html: safeHtml }} /> : <div className="mail-text">{selected.textBody || selected.snippet}</div>}
                </div>
                {visibleAttachments.length > 0 && (
                  <section className="attachment-list" aria-label={t("mail.attachment.aria", { count: visibleAttachments.length })}>
                    <div className="attachment-list-heading"><Paperclip size={15} /><span>{t("compose.attachments")}</span><small>{t("mail.attachment.fileCount", { count: visibleAttachments.length })}</small></div>
                    {visibleAttachments.map((attachment) => {
                      const presentation = presentAttachment(attachment.filename, attachment.contentType, t);
                      const downloadKey = `${selected.id}:${attachment.partId}`;
                      const download = attachmentDownloads[downloadKey];
                      const isDownloading = download?.phase === "downloading";
                      const downloadDetail = isDownloading
                        ? t("mail.attachment.preparing")
                        : download?.phase === "ready"
                          ? t("mail.attachment.ready", { type: presentation.label, size: formatFileSize(attachment.size) })
                          : download?.phase === "error"
                            ? t("mail.attachment.failed", { message: download.detail ?? t("error.retry") })
                            : t("mail.attachment.detail", { type: presentation.label, size: formatFileSize(attachment.size) });
                      return (
                        <div className={`attachment-card${download?.phase ? ` is-${download.phase}` : ""}`} key={attachment.partId}>
                          <AttachmentFileIcon kind={presentation.kind} />
                          <span><strong className="truncated-tooltip" data-tooltip={attachment.filename}><span>{attachment.filename}</span></strong><small className="truncated-tooltip" aria-live="polite" data-tooltip={download?.detail}><span>{downloadDetail}</span></small></span>
                          <IconButton label={selectedMoveActionLabel ?? (download?.phase === "error" ? t("mail.attachment.retryDownload", { filename: attachment.filename }) : t("mail.attachment.download", { filename: attachment.filename }))} disabled={isDownloading || selectedRemoteActionsBlocked} onClick={() => void downloadAttachment(selected, attachment)}>{isDownloading ? <LoaderCircle className="spin" size={16} /> : download?.phase === "error" ? <RefreshCw size={16} /> : <Download size={16} />}</IconButton>
                        </div>
                      );
                    })}
                  </section>
                )}
                <footer className="quick-reply"><span className={`sender-avatar small tone-${accountTone(selected.accountEmail)}`}>{selected.accountEmail[0]?.toUpperCase()}</span><button onClick={openReply}>{t("mail.reader.replyTo", { sender: selected.from.name || selected.from.address })}</button></footer>
              </article>
            </>
          ) : (
            <div className="reader-empty"><div className="reader-orb"><Mail size={32} /></div><h2>{t("mail.reader.emptyTitle")}</h2><p>{t("mail.reader.emptyDescription")}</p></div>
          )}
        </section>
      </main>

      {addOpen && <AccountConnectionModal providers={providers} onClose={() => setAddOpen(false)} onAdded={load} fallbackFocusRef={mobileMenuButtonRef} demoMode={isDemo} />}
      {composeOpen && <ComposeModal accounts={accounts} draft={composeDraft} onClose={() => setComposeOpen(false)} onSent={(message, kind) => showToast(message, kind)} onDraftSaved={(accountId) => { if (!isDemo) void api.sync(accountId).then(() => load({ silent: true })).catch(() => undefined); }} onDraftDiscarded={(messageId) => { setMessages((items) => items.filter((message) => message.id !== messageId)); setSelectedId((current) => current === messageId ? null : current); }} onSubmissionChanged={() => void refreshSubmissions(accounts, { silent: true })} fallbackFocusRef={mobileMenuButtonRef} />}
      {settingsOpen && <SettingsModal settings={settings} accounts={accounts} onClose={() => setSettingsOpen(false)} onSettingsChange={applySettings} onAccountRemoved={removeAccountFromView} onAccountSync={retryAccountSync} onTestNotification={testDesktopNotification} onTestSound={testNotificationSound} onTranslationConfigurationChanged={refreshTranslationAvailability} fallbackFocusRef={mobileMenuButtonRef} demoMode={isDemo} />}
      {sendingStatusOpen && <SendingStatusModal accounts={accounts} submissions={submissions} loading={submissionLoading} loadError={submissionLoadError} onClose={() => setSendingStatusOpen(false)} onRefresh={() => refreshSubmissions(accounts)} onSyncAccount={async (accountId) => { await retryAccountSync(accountId); }} onCreateNewMessage={(draft) => { setSendingStatusOpen(false); openCompose(draft); }} fallbackFocusRef={mobileMenuButtonRef} />}
      <StartupUpdatePrompt
        snapshot={desktopUpdateStatus}
        onSnapshot={setDesktopUpdateStatus}
        defer={addOpen || composeOpen || settingsOpen || sendingStatusOpen || mobileSidebar || syncing}
        onVisibilityChange={setUpdatePromptOpen}
      />
      {mobileSidebar && <button className="mobile-scrim" aria-label={t("navigation.closeMenu")} onClick={() => setMobileSidebar(false)} />}
      {toast && <div className={`toast ${toast.kind}`} role={toast.kind === "error" || toast.kind === "warning" ? "alert" : "status"} aria-atomic="true"><span className="toast-icon" aria-hidden="true">{toast.kind === "error" || toast.kind === "warning" ? <CircleAlert size={17} /> : toast.kind === "info" ? <Sparkles size={17} /> : <Check size={17} />}</span><span className="toast-message">{toast.message}</span><button className="toast-dismiss" type="button" aria-label={t("common.closeNotification")} data-tooltip={t("common.closeNotification")} onClick={() => setToast(null)}><X size={16} /></button></div>}
      </div>
    </div>
  );
}
