import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import type { ComposeDraft } from "./mailUi";
import { isDesktopSettingsRuntime, resolveSettingsCategory, type SettingsCategoryId } from "./settings/settings-categories";
import type { Message, MessageAttachment } from "./types";
import { readDemoPresentation } from "./demoPresentation";

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
  translationTermsOpen: boolean;
  attachmentPreviewOpen: boolean;
  // App-owned modals, read from the same state useDialogRouting is handed
  // (see AppOwnedModals). They live in the snapshot — and therefore in
  // MODAL_KEYS — so the shortcut gate cannot miss them.
  batchDeleteOpen: boolean;
  agentOpen: boolean;
  selectedId: string | null;
  selected: boolean;
  /** The message shift+J/K expands from; null until the first expansion. */
  keyboardSelectionAnchorId: string | null;
  accountsLength: number;
  filteredMessages: Message[];
}

/**
 * WEB-5 guard: the single mechanical list of every modal/overlay boolean in
 * DialogKeydownSnapshot, in snapshot field order. Everything that used to be
 * a hand-written OR over these flags (the shortcut gate in
 * dialogKeydownDecision, useDialogRouting's anyModalOpen/anyModalOrSidebar)
 * derives from this tuple, and the tables that consume it (the anyModalOpen
 * sentinel test) are typed Record<ModalKey, …> — so a new modal added to the
 * snapshot without registering it here fails to compile or fails a test
 * instead of shipping.
 *
 * Membership means "the shortcut gate must freeze here", NOT "the shell's
 * Escape chain owns this layer". A layer that installs its own capture-phase
 * Escape listener (updatePromptOpen's StartupUpdatePrompt, the batch-delete
 * alertdialog, the agent workspace) closes itself and must NOT also get a
 * branch below the gate — that is exactly the WEB-1 bug class, one Escape
 * closing two layers. Those still belong here: the gate is what keeps `n`,
 * `j`/`k` and Cmd+K from reaching through a dialog that is visually on top.
 *
 * updatePromptOpen is deliberately absent entirely: it is App-local state
 * (not owned by useDialogRouting) and it is dispatched before this Escape
 * chain (the absorb branch at the top of dialogKeydownDecision).
 */
export const MODAL_KEYS = [
  "settingsOpen",
  "calendarOpen",
  "contactsOpen",
  "templatesOpen",
  "accountsOpen",
  "composeOpen",
  "addOpen",
  "mobileSidebar",
  "sendingStatusOpen",
  "translationTermsOpen",
  "attachmentPreviewOpen",
  "batchDeleteOpen",
  "agentOpen",
] as const;

export type ModalKey = (typeof MODAL_KEYS)[number];

/**
 * Modal keys that must NOT sink the AutoReply toast stack
 * (useDialogRouting's anyModalOpen, the toast stack's behindModal).
 *
 * Three different reasons, one list:
 * - mobileSidebar: a drawer gated separately, not a backdrop modal.
 * - attachmentPreviewOpen: a non-modal reader pane (aria-modal="false"; the
 *   reader stays interactive behind it).
 * - agentOpen: a backdrop modal, but the toast stack already paints over it
 *   on purpose (stack z-index 100 vs the workspace's 30) and the stack's
 *   `inAgent` prop shifts it up so it never blocks the agent composer.
 *   Sinking it would hide the pending-draft approval cards entirely.
 *
 * Every other MODAL_KEYS entry is a backdrop modal that must cover the
 * toasts — including the batch-delete alertdialog, whose `.modal-backdrop`
 * now sits at z-index 40 and would otherwise leave a clickable toast
 * floating above the confirmation.
 *
 * ── Stacking ladder ──────────────────────────────────────────────────────
 * This hook owns WHICH overlay is open; styles.css owns the order they paint
 * in. Two constraints link them, both pinned by overlayStacking.test.ts:
 *
 * - At most one MODAL_KEYS entry is open at a time, which is what lets the
 *   scrim backdrops share rungs (45 / 60 / 70) without a tie ever being
 *   observable. Adding a modal that can be open ALONGSIDE another needs its
 *   own rung, not a shared one.
 * - `.modal-backdrop` is the shared base every `*-backdrop` overrides, so its
 *   value must not collide with anything. It was 30, which `.agent-workspace`
 *   also used — the batch-delete alertdialog then lost to the agent workspace
 *   purely on DOM order. It is 40 now: above the 30 band the in-app workspaces
 *   occupy, below the 45+ scrim band.
 */
export const TOAST_RAISED_MODAL_KEYS: readonly ModalKey[] = ["mobileSidebar", "attachmentPreviewOpen", "agentOpen"];

/**
 * Modals App renders itself, which useDialogRouting does not own but must
 * still gate. They are passed in rather than kept App-private precisely so
 * they cannot fall out of the registry again.
 */
export interface AppOwnedModals {
  /** App's role="alertdialog" aria-modal="true" batch-delete confirmation. */
  batchDeleteOpen: boolean;
  /** The agent assistant workspace (role="dialog" aria-modal="true"). */
  agentOpen: boolean;
}

const noAppOwnedModals: AppOwnedModals = { batchDeleteOpen: false, agentOpen: false };

export type DialogKeydownAction =
  | { kind: "absorb" }
  | { kind: "close_settings" }
  | { kind: "close_calendar" }
  | { kind: "close_contacts" }
  | { kind: "close_templates" }
  | { kind: "close_accounts" }
  | { kind: "close_add_account" }
  | { kind: "close_mobile_sidebar" }
  | { kind: "close_attachment_preview" }
  | { kind: "close_reader" }
  | { kind: "focus_search" }
  | { kind: "compose" }
  | { kind: "add_account" }
  | { kind: "reply" }
  | { kind: "reply_all" }
  | { kind: "forward" }
  | { kind: "open_message"; message: Message }
  | { kind: "select_range"; ids: string[] };

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
    // The attachment preview drawer is the top layer over the open message
    // (rendered as the last pane inside .reader-split, above the reader
    // article), so it closes BEFORE close_reader: one Escape peels one layer,
    // preview first, reader second. Everything above (settings…sidebar) keeps
    // its earlier branch because those are full-screen overlays stacked over
    // the preview. In practice AttachmentPreviewModal's own capture listener
    // consumes this Escape first (capture beats App's window-bubble listener);
    // this branch is the shell-level fallback (e.g. while the lazy modal is
    // still mounting) and keeps the chain exhaustive over MODAL_KEYS (WEB-1).
    if (snapshot.attachmentPreviewOpen) return { action: { kind: "close_attachment_preview" }, preventDefault: false };
    // batchDeleteOpen and agentOpen have no branch here on purpose: both
    // install their own capture-phase Escape listener (App's alertdialog and
    // AgentWorkspace) that stops immediate propagation, so the shell chain is
    // unreachable while they are up. Adding fallback branches would restore
    // the WEB-1 double-close if either listener ever stopped firing.
    if (snapshot.selectedId) return { action: { kind: "close_reader" }, preventDefault: false };
    return null;
  }
  // Every backdrop modal/overlay freezes the shortcuts (WEB-5: derived from
  // MODAL_KEYS so a new modal can never be missed here — including the two
  // App owns itself; updatePromptOpen is excluded on purpose because the
  // absorb branch above already swallowed it).
  if (MODAL_KEYS.some((modalKey) => snapshot[modalKey])) return null;
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
  const anchorIndex = snapshot.keyboardSelectionAnchorId
    ? snapshot.filteredMessages.findIndex((message) => message.id === snapshot.keyboardSelectionAnchorId)
    : -1;
  const currentIndex = snapshot.filteredMessages.findIndex((message) => message.id === snapshot.selectedId);
  const direction = key === "j" ? 1 : -1;
  // Shift expansions move from the anchor instead of the opened message:
  // select_range never opens a message, so the anchor is the live position.
  const positionIndex = event.shiftKey && anchorIndex >= 0 ? anchorIndex : currentIndex;
  const nextIndex = positionIndex === -1 ? (direction === 1 ? 0 : snapshot.filteredMessages.length - 1) : positionIndex + direction;
  const nextMessage = snapshot.filteredMessages[nextIndex];
  if (!nextMessage) return null;
  // Shift+J/K selects the span from the expand anchor (or the selected
  // message, or the first/last row) through the navigation target, entering
  // batch mode the same way shift+click does.
  if (event.shiftKey) {
    const startIndex = anchorIndex >= 0
      ? anchorIndex
      : currentIndex >= 0
        ? currentIndex
        : direction === 1 ? 0 : snapshot.filteredMessages.length - 1;
    const [from, to] = startIndex <= nextIndex ? [startIndex, nextIndex] : [nextIndex, startIndex];
    const ids = snapshot.filteredMessages.slice(from, to + 1).map((message) => message.id);
    return { action: { kind: "select_range", ids }, preventDefault: true };
  }
  return { action: { kind: "open_message", message: nextMessage }, preventDefault: true };
}

export interface DialogRoutingState {
  addOpen: boolean;
  composeOpen: boolean;
  composeDraft: ComposeDraft;
  settingsOpen: boolean;
  /** Deep link into the settings modal; the nonce re-applies the switch while it
   *  is open and beats the persisted-category restore on a cold mount. */
  settingsCategoryRequest: { category: SettingsCategoryId; nonce: number } | null;
  contactsOpen: boolean;
  templatesOpen: boolean;
  calendarOpen: boolean;
  accountsOpen: boolean;
  sendingStatusOpen: boolean;
  translationTermsOpen: boolean;
  translationTermsAccepted: boolean;
  attachmentPreview: { message: Message; attachment: MessageAttachment } | null;
  mobileSidebar: boolean;
  /**
   * Any backdrop modal is open (the AutoReply toast stack's behindModal).
   * Overlays listed in TOAST_RAISED_MODAL_KEYS are excluded even when they are
   * real modals — the agent workspace is one, and sinking the toast stack
   * behind it would hide the agent's approval cards.
   */
  anyModalOpen: boolean;
  /**
   * Any snapshot overlay is up, regardless of what it does to the toast
   * stack. This is NOT the shortcut gate — the gate is `MODAL_KEYS.some` at
   * the decision point, a strictly wider list. Its only consumer is App's
   * StartupUpdatePrompt `defer`: an update prompt must not land on top of
   * anything. The mobile sidebar is included explicitly (it is a drawer, not
   * a backdrop modal, so anyModalOpen ignores it), and the toast-raised
   * exceptions (attachment preview, agent workspace) are included too — a
   * deferred prompt is about visual collision, not click interception.
   */
  anyModalOrSidebar: boolean;
  /** Echoes the App-owned flags handed to the hook, for the keydown snapshot. */
  batchDeleteOpen: boolean;
  agentOpen: boolean;
}

export interface DialogRoutingActions {
  openAddAccount: () => void;
  closeAddAccount: () => void;
  openCompose: (draft?: ComposeDraft) => void;
  closeCompose: () => void;
  openSettings: () => void;
  /** Opens the settings modal already on `category` (cross-modal chains are
   *  composed from actions, so this lives beside openSettings). */
  openSettingsTo: (category: SettingsCategoryId) => void;
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
  /**
   * Drops the preview unless it belongs to `messageId` (pass the reader's
   * selected id, or null when the reader is going away). The preview pane is
   * rendered *inside* the reader, so its state must never outlive the message
   * it describes: a leftover entry resurrects as a ghost preview over the
   * next message, and — because `attachmentPreviewOpen` feeds the shortcut
   * gate — silently kills every global shortcut behind an invisible drawer.
   * Functional setState keeps the identity stable, so callers can list it in
   * dependency arrays without re-running effects.
   */
  pruneAttachmentPreviewFor: (messageId: string | null) => void;
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
export function useDialogRouting(appOwnedModals: AppOwnedModals = noAppOwnedModals): DialogRouting {
  const { batchDeleteOpen, agentOpen } = appOwnedModals;
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
    // The public preview uses sample mail with network access disabled by its
    // build's CSP. Defer the startup gate without recording any acceptance;
    // explicitly requesting translation still uses the normal consent flow.
    if (typeof window !== "undefined" && readDemoPresentation(window.location.search)) return false;
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
  const [settingsCategoryRequest, setSettingsCategoryRequest] = useState<{ category: SettingsCategoryId; nonce: number } | null>(null);
  // A deep link names a category, but the same availability filter the sidebar
  // uses still applies: linking to "desktop" on the web must not render an
  // orphan panel the sidebar has no entry for.
  const openSettingsTo = useCallback((category: SettingsCategoryId) => {
    const target = resolveSettingsCategory(category, isDesktopSettingsRuntime());
    setSettingsCategoryRequest((current) => ({ category: target, nonce: (current?.nonce ?? 0) + 1 }));
    setSettingsOpen(true);
  }, []);
  // The request is consumed by the modal it opened: leaving it behind would
  // hijack every later plain open back to the deep-linked category, and the
  // modal would then persist that category over the user's remembered choice.
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsCategoryRequest(null);
  }, []);
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
  const pruneAttachmentPreviewFor = useCallback((messageId: string | null) => {
    setAttachmentPreview((current) => current && current.message.id !== messageId ? null : current);
  }, []);

  // The first-run translation-terms gate renders in the same backdrop +
  // aria-modal shell, so it counts too. Leaving it out kept the toast stack at
  // its raised z-index while the gate was open, and at narrow widths a toast
  // painted over "agree and continue" and swallowed the click.
  //
  // WEB-5: derived from MODAL_KEYS instead of a hand-written OR. The Record is
  // compile-checked exhaustive against MODAL_KEYS, so a modal added to the
  // snapshot without being wired here fails to build. The toast-raised
  // exceptions (TOAST_RAISED_MODAL_KEYS) are skipped in anyModalOpen but still
  // counted by anyModalOrSidebar.
  const modalOpenByKey: Record<ModalKey, boolean> = {
    settingsOpen,
    calendarOpen,
    contactsOpen,
    templatesOpen,
    accountsOpen,
    composeOpen,
    addOpen,
    mobileSidebar,
    sendingStatusOpen,
    translationTermsOpen,
    attachmentPreviewOpen: attachmentPreview !== null,
    batchDeleteOpen,
    agentOpen,
  };
  const anyModalOpen = MODAL_KEYS.some((modalKey) => !TOAST_RAISED_MODAL_KEYS.includes(modalKey) && modalOpenByKey[modalKey]);
  const anyModalOrSidebar = MODAL_KEYS.some((modalKey) => modalOpenByKey[modalKey]);

  // Every member is a stable reference (useCallback with [] deps or a setState
  // function), so the object itself can be memoized once — consumers can list
  // `actions` in hook dependency arrays without re-running effects.
  const actions = useMemo(() => ({
    openAddAccount,
    closeAddAccount,
    openCompose,
    closeCompose,
    openSettings,
    openSettingsTo,
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
    pruneAttachmentPreviewFor,
    setTranslationTermsOpen,
    setTranslationTermsAccepted,
  }), [openAddAccount, closeAddAccount, openCompose, closeCompose, openSettings, openSettingsTo, closeSettings, openContacts, closeContacts, openTemplates, closeTemplates, openCalendar, closeCalendar, openAccounts, closeAccounts, openSendingStatus, closeSendingStatus, openMobileSidebar, closeMobileSidebar, openAttachmentPreview, closeAttachmentPreview, pruneAttachmentPreviewFor]);

  return {
    state: {
      addOpen,
      composeOpen,
      composeDraft,
      settingsOpen,
      settingsCategoryRequest,
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
      /** Mirrors of the App-owned flags, so the snapshot reads one source. */
      batchDeleteOpen,
      agentOpen,
    },
    actions,
    translationTermsPendingRef,
  };
}
