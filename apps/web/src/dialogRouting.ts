import { useCallback, useRef, useState, type RefObject } from "react";
import type { ComposeDraft } from "./mailUi";
import type { Message, MessageAttachment } from "./types";

// A key typed into an input/textarea/select (or a themed select-control
// descendant, or a contentEditable) belongs to the field, not to the app —
// the global shortcuts must never hijack it.
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || Boolean(target instanceof Element && target.closest(".select-control"))
    || Boolean(target instanceof HTMLElement && target.isContentEditable);
}

/** Read-only snapshot of the mail shell's modal/panel state for key routing. */
export interface DialogKeydownSnapshot {
  updatePromptOpen: boolean;
  settingsOpen: boolean;
  calendarOpen: boolean;
  contactsOpen: boolean;
  templatesOpen: boolean;
  accountsOpen: boolean;
  composeOpen: boolean;
  addOpen: boolean;
  mobileSidebar: boolean;
  sendingStatusOpen: boolean;
  selectedId: string | null;
  selected: boolean;
  accountsLength: number;
  filteredMessages: Message[];
}

export type DialogKeydownAction =
  | { kind: "absorb" }
  | { kind: "close_settings" }
  | { kind: "close_calendar" }
  | { kind: "close_contacts" }
  | { kind: "close_templates" }
  | { kind: "close_accounts" }
  | { kind: "close_add_account" }
  | { kind: "close_mobile_sidebar" }
  | { kind: "close_reader" }
  | { kind: "focus_search" }
  | { kind: "compose" }
  | { kind: "add_account" }
  | { kind: "reply" }
  | { kind: "reply_all" }
  | { kind: "forward" }
  | { kind: "open_message"; message: Message };

export interface DialogKeydownDecision {
  action: DialogKeydownAction;
  preventDefault: boolean;
}

// The single decision point behind the shell's global keydown listener.
// Returns null when the key is a no-op for the app (the event is left to
// the element/component layer, e.g. ComposeModal's dirty-draft handling).
export function dialogKeydownDecision(event: KeyboardEvent, snapshot: DialogKeydownSnapshot): DialogKeydownDecision | null {
  if (snapshot.updatePromptOpen) {
    if (event.key === "Escape") return { action: { kind: "absorb" }, preventDefault: true };
    return { action: { kind: "absorb" }, preventDefault: false };
  }
  const isTyping = isTypingTarget(event.target);
  if (event.key === "Escape") {
    if (snapshot.settingsOpen) return { action: { kind: "close_settings" }, preventDefault: false };
    if (snapshot.calendarOpen) return { action: { kind: "close_calendar" }, preventDefault: false };
    if (snapshot.contactsOpen) return { action: { kind: "close_contacts" }, preventDefault: false };
    if (snapshot.templatesOpen) return { action: { kind: "close_templates" }, preventDefault: false };
    if (snapshot.accountsOpen) return { action: { kind: "close_accounts" }, preventDefault: false };
    if (snapshot.composeOpen) return null;
    if (snapshot.addOpen) return { action: { kind: "close_add_account" }, preventDefault: false };
    if (snapshot.mobileSidebar) return { action: { kind: "close_mobile_sidebar" }, preventDefault: false };
    if (snapshot.selectedId) return { action: { kind: "close_reader" }, preventDefault: false };
    return null;
  }
  if (snapshot.settingsOpen || snapshot.calendarOpen || snapshot.contactsOpen || snapshot.templatesOpen || snapshot.accountsOpen || snapshot.sendingStatusOpen || snapshot.composeOpen || snapshot.addOpen || snapshot.mobileSidebar) return null;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    return { action: { kind: "focus_search" }, preventDefault: true };
  }
  if (isTyping || event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "n") {
    if (snapshot.accountsLength > 0) return { action: { kind: "compose" }, preventDefault: true };
    return { action: { kind: "add_account" }, preventDefault: true };
  }
  if (key === "r" && snapshot.selected) {
    if (event.shiftKey) return { action: { kind: "reply_all" }, preventDefault: true };
    return { action: { kind: "reply" }, preventDefault: true };
  }
  if (key === "f" && snapshot.selected) {
    return { action: { kind: "forward" }, preventDefault: true };
  }
  if (key !== "j" && key !== "k") return null;
  const currentIndex = snapshot.filteredMessages.findIndex((message) => message.id === snapshot.selectedId);
  const direction = key === "j" ? 1 : -1;
  const nextIndex = currentIndex === -1 ? (direction === 1 ? 0 : snapshot.filteredMessages.length - 1) : currentIndex + direction;
  const nextMessage = snapshot.filteredMessages[nextIndex];
  if (nextMessage) return { action: { kind: "open_message", message: nextMessage }, preventDefault: true };
  return null;
}

export interface DialogRoutingState {
  addOpen: boolean;
  composeOpen: boolean;
  composeDraft: ComposeDraft;
  settingsOpen: boolean;
  contactsOpen: boolean;
  templatesOpen: boolean;
  calendarOpen: boolean;
  accountsOpen: boolean;
  sendingStatusOpen: boolean;
  translationTermsOpen: boolean;
  translationTermsAccepted: boolean;
  attachmentPreview: { message: Message; attachment: MessageAttachment } | null;
  mobileSidebar: boolean;
  /** Any of the eight core modal dialogs is open (the AutoReply toast stack's behindModal). */
  anyModalOpen: boolean;
  /** Core modals plus the mobile sidebar (the global-shortcut gate list). */
  anyModalOrSidebar: boolean;
}

export interface DialogRoutingActions {
  openAddAccount: () => void;
  closeAddAccount: () => void;
  openCompose: (draft?: ComposeDraft) => void;
  closeCompose: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openContacts: () => void;
  closeContacts: () => void;
  openTemplates: () => void;
  closeTemplates: () => void;
  openCalendar: () => void;
  closeCalendar: () => void;
  openAccounts: () => void;
  closeAccounts: () => void;
  openSendingStatus: () => void;
  closeSendingStatus: () => void;
  openMobileSidebar: () => void;
  closeMobileSidebar: () => void;
  openAttachmentPreview: (message: Message, attachment: MessageAttachment) => void;
  closeAttachmentPreview: () => void;
  setTranslationTermsOpen: (open: boolean) => void;
  setTranslationTermsAccepted: (accepted: boolean) => void;
}

export interface DialogRouting {
  state: DialogRoutingState;
  actions: DialogRoutingActions;
  translationTermsPendingRef: RefObject<"free" | "llm" | null>;
}

// Owns the mail shell's modal/panel routing state (the "dialog routing"
// concern of App): nine modal dialogs, the attachment preview, the mobile
// sidebar, and the translation-terms gate. Everything here is display
// routing only — none of it reads or writes mail data; cross-modal chains
// (e.g. sending-status → compose) are composed by the caller from actions.
export function useDialogRouting(): DialogRouting {
  const [translationTermsAccepted, setTranslationTermsAccepted] = useState<boolean>(() => {
    try {
      if (localStorage.getItem("nami-mail:translation-terms-accepted") === "1") return true;
    } catch { /* localStorage may be unavailable */ }
    // localStorage is origin-scoped and the desktop app uses an ephemeral port
    // (PORT=0), so every restart gets a different origin. Fall back to a cookie
    // which in Chromium is shared across ports on the same domain (127.0.0.1).
    try {
      if (document.cookie.split(";").some((c) => c.trim().startsWith("nami-mail-translation-terms=1"))) return true;
    } catch { /* cookie may be unavailable */ }
    return false;
  });
  const [translationTermsOpen, setTranslationTermsOpen] = useState(() => {
    if (translationTermsAccepted) return false;
    // Skip terms dialog in desktop smoke test mode
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("desktopSmoke") === "1") return false;
    return true;
  });
  const translationTermsPendingRef = useRef<"free" | "llm" | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ComposeDraft>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [sendingStatusOpen, setSendingStatusOpen] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<{ message: Message; attachment: MessageAttachment } | null>(null);
  const [mobileSidebar, setMobileSidebar] = useState(false);

  const openAddAccount = useCallback(() => setAddOpen(true), []);
  const closeAddAccount = useCallback(() => setAddOpen(false), []);
  const openCompose = useCallback((draft: ComposeDraft = {}) => {
    setComposeDraft(draft);
    setComposeOpen(true);
  }, []);
  const closeCompose = useCallback(() => setComposeOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openContacts = useCallback(() => setContactsOpen(true), []);
  const closeContacts = useCallback(() => setContactsOpen(false), []);
  const openTemplates = useCallback(() => setTemplatesOpen(true), []);
  const closeTemplates = useCallback(() => setTemplatesOpen(false), []);
  const openCalendar = useCallback(() => setCalendarOpen(true), []);
  const closeCalendar = useCallback(() => setCalendarOpen(false), []);
  const openAccounts = useCallback(() => setAccountsOpen(true), []);
  const closeAccounts = useCallback(() => setAccountsOpen(false), []);
  const openSendingStatus = useCallback(() => setSendingStatusOpen(true), []);
  const closeSendingStatus = useCallback(() => setSendingStatusOpen(false), []);
  const openMobileSidebar = useCallback(() => setMobileSidebar(true), []);
  const closeMobileSidebar = useCallback(() => setMobileSidebar(false), []);
  const openAttachmentPreview = useCallback((message: Message, attachment: MessageAttachment) => {
    setAttachmentPreview({ message, attachment });
  }, []);
  const closeAttachmentPreview = useCallback(() => setAttachmentPreview(null), []);

  const anyModalOpen = addOpen || composeOpen || settingsOpen || contactsOpen || templatesOpen || calendarOpen || accountsOpen || sendingStatusOpen;
  const anyModalOrSidebar = anyModalOpen || mobileSidebar;

  return {
    state: {
      addOpen,
      composeOpen,
      composeDraft,
      settingsOpen,
      contactsOpen,
      templatesOpen,
      calendarOpen,
      accountsOpen,
      sendingStatusOpen,
      translationTermsOpen,
      translationTermsAccepted,
      attachmentPreview,
      mobileSidebar,
      anyModalOpen,
      anyModalOrSidebar,
    },
    actions: {
      openAddAccount,
      closeAddAccount,
      openCompose,
      closeCompose,
      openSettings,
      closeSettings,
      openContacts,
      closeContacts,
      openTemplates,
      closeTemplates,
      openCalendar,
      closeCalendar,
      openAccounts,
      closeAccounts,
      openSendingStatus,
      closeSendingStatus,
      openMobileSidebar,
      closeMobileSidebar,
      openAttachmentPreview,
      closeAttachmentPreview,
      setTranslationTermsOpen,
      setTranslationTermsAccepted,
    },
    translationTermsPendingRef,
  };
}