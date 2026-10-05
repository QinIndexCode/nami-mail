import { lazy, Suspense, type ComponentProps, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Calendar, Check, CircleAlert, Info, LoaderCircle, Mail, RotateCcw, Trash2, Video, X } from "lucide-react";
import { api, type MoveTarget } from "./api";
import { desktopBridge, type DesktopAutoReplyNotice } from "./desktop";
import { isDemoPromptRequested } from "./demoUpdateMock";
import { AutoReplyToastStack, autoReplyNoticeKey } from "./AutoReplyToastStack";
import type { DialogRoutingActions, DialogRoutingState } from "./dialogRouting";
import type { Translate } from "./i18n";
import type { useToastQueue } from "./notifications/useToastQueue";
import type { useOutboundSubmissions } from "./app/useOutboundSubmissions";
import type { useDesktopUpdateUi } from "./app/useDesktopUpdateUi";
import type { useAttachmentExports } from "./app/useAttachmentExports";
import type { Account, AppSettings, Message, ProviderInfo } from "./types";
import type { AgentBootstrap } from "./agentTypes";

// Dialogs are lazily loaded: their code is only fetched when first opened.
// App's prewarm effect issues the same dynamic imports ahead of time.
const AccountConnectionModal = lazy(() => import("./AddAccountModal"));
const SettingsModal = lazy(() => import("./SettingsModal"));
const AccountsDialog = lazy(() => import("./AccountsDialog"));
const CalendarDialog = lazy(() => import("./CalendarDialog"));
const CalendarImportModal = lazy(() => import("./calendar/CalendarImportModal"));
const ManagementDialogs = lazy(async () => {
  const module = await import("./ManagementDialogs");
  return { default: module.ContactsDialog };
});
const TemplatesDialog = lazy(async () => {
  const module = await import("./ManagementDialogs");
  return { default: module.TemplatesDialog };
});
const SendingStatusModal = lazy(() => import("./SendingStatusModal"));
const StartupUpdatePrompt = lazy(() => import("./StartupUpdatePrompt"));
const TranslationTermsDialog = lazy(() => import("./TranslationTermsDialog"));
const ComposeModal = lazy(async () => {
  const module = await import("./ComposeModal");
  return { default: module.ComposeModal };
});

type ToastApi = ReturnType<typeof useToastQueue>;
type SubmissionsApi = ReturnType<typeof useOutboundSubmissions>;
type UpdateUiApi = ReturnType<typeof useDesktopUpdateUi>;
type AttachmentExportsApi = ReturnType<typeof useAttachmentExports>;
type AgentProviderSnapshot = Pick<AgentBootstrap, "providers" | "defaultProviderId">;

export interface AppDialogsProps {
  state: DialogRoutingState;
  actions: DialogRoutingActions;
  t: Translate;
  isDemo: boolean;
  syncing: boolean;
  agentOpen: boolean;
  accounts: Account[];
  providers: ProviderInfo[];
  settings: AppSettings;
  mobileMenuButtonRef: RefObject<HTMLButtonElement | null>;
  toast: ToastApi["toast"];
  showToast: ToastApi["showToast"];
  dismissToast: ToastApi["dismissToast"];
  handleAccountAdded: ComponentProps<typeof AccountConnectionModal>["onAdded"];
  /** List load; awaited after compose-driven syncs so the list reflects the sent mail. */
  load: (options?: { silent?: boolean }) => Promise<void>;
  setThreadRefreshTick: Dispatch<SetStateAction<number>>;
  setMessages: (updater: Message[] | ((items: Message[]) => Message[])) => void;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  applySettings: ComponentProps<typeof SettingsModal>["onSettingsChange"];
  testDesktopNotification: ComponentProps<typeof SettingsModal>["onTestNotification"];
  testNotificationSound: ComponentProps<typeof SettingsModal>["onTestSound"];
  refreshTranslationAvailability: ComponentProps<typeof SettingsModal>["onTranslationConfigurationChanged"];
  acceptTranslationTerms: () => void;
  declineTranslationTerms: () => void;
  agentProviderSnapshot: AgentProviderSnapshot | null;
  preloadedAgentBootstrap: AgentBootstrap | null;
  setAgentProviderSnapshot: (snapshot: AgentProviderSnapshot | null) => void;
  setPreloadedAgentBootstrap: Dispatch<SetStateAction<AgentBootstrap | null>>;
  setAgentProviderListVersion: Dispatch<SetStateAction<number>>;
  calendarImportPayload: AttachmentExportsApi["calendarImportPayload"];
  setCalendarImportPayload: AttachmentExportsApi["setCalendarImportPayload"];
  submissions: SubmissionsApi["submissions"];
  submissionLoading: SubmissionsApi["submissionLoading"];
  submissionLoadError: SubmissionsApi["submissionLoadError"];
  refreshSubmissions: SubmissionsApi["refreshSubmissions"];
  cancelScheduledSubmission: SubmissionsApi["cancelScheduledSubmission"];
  removeAccountFromView: ComponentProps<typeof AccountsDialog>["onAccountRemoved"];
  updateAccountSignatureInState: ComponentProps<typeof AccountsDialog>["onAccountSignatureChanged"];
  retryAccountSync: NonNullable<ComponentProps<typeof AccountsDialog>["onAccountSync"]>;
  desktopUpdateStatus: UpdateUiApi["desktopUpdateStatus"];
  setDesktopUpdateStatus: UpdateUiApi["setDesktopUpdateStatus"];
  setUpdatePromptOpen: (open: boolean) => void;
  autoReplyNotices: DesktopAutoReplyNotice[];
  setAutoReplyNotices: Dispatch<SetStateAction<DesktopAutoReplyNotice[]>>;
  // Batch delete confirmation (state owned by useBatchSelection in App).
  pendingBatchDelete: boolean;
  batchDeleteConfirmClosing: boolean;
  batchBusy: boolean;
  requestBatchDeleteConfirmClose: () => void;
  batchDeleteDialogRef: { current: HTMLElement | null };
  selectAllPaged: boolean;
  currentMessageTotal: number;
  selectedMessageIds: ReadonlySet<string>;
  setPendingBatchDelete: (value: boolean) => void;
  batchMoveMessages: (target: MoveTarget) => Promise<void>;
}

/**
 * Every modal dialog, confirmation, toast and overlay rendered at the tail of
 * the App tree. Pure presentation: all state and actions arrive as props from
 * App (mostly via the dialog-routing, batch-selection and submissions hooks).
 */
export function AppDialogs(props: AppDialogsProps) {
  const {
    state,
    actions,
    t,
    isDemo,
    syncing,
    agentOpen,
    accounts,
    providers,
    settings,
    mobileMenuButtonRef,
    toast,
    showToast,
    dismissToast,
    handleAccountAdded,
    load,
    setThreadRefreshTick,
    setMessages,
    setSelectedId,
    applySettings,
    testDesktopNotification,
    testNotificationSound,
    refreshTranslationAvailability,
    acceptTranslationTerms,
    declineTranslationTerms,
    agentProviderSnapshot,
    preloadedAgentBootstrap,
    setAgentProviderSnapshot,
    setPreloadedAgentBootstrap,
    setAgentProviderListVersion,
    calendarImportPayload,
    setCalendarImportPayload,
    submissions,
    submissionLoading,
    submissionLoadError,
    refreshSubmissions,
    cancelScheduledSubmission,
    removeAccountFromView,
    updateAccountSignatureInState,
    retryAccountSync,
    desktopUpdateStatus,
    setDesktopUpdateStatus,
    setUpdatePromptOpen,
    autoReplyNotices,
    setAutoReplyNotices,
    pendingBatchDelete,
    batchDeleteConfirmClosing,
    batchBusy,
    requestBatchDeleteConfirmClose,
    batchDeleteDialogRef,
    selectAllPaged,
    currentMessageTotal,
    selectedMessageIds,
    setPendingBatchDelete,
    batchMoveMessages,
  } = props;

  return (
    <>
      {state.addOpen && <Suspense fallback={null}><AccountConnectionModal providers={providers} existingAccounts={accounts} onClose={() => actions.closeAddAccount()} onAdded={handleAccountAdded} fallbackFocusRef={mobileMenuButtonRef} demoMode={isDemo} /></Suspense>}
      {state.composeOpen && <Suspense fallback={null}><ComposeModal accounts={accounts} draft={state.composeDraft} onClose={() => actions.closeCompose()} onSent={(message, kind, undoDraft, sentAccountId) => { if (undoDraft) showToast(message, kind, { label: t("compose.undo"), icon: "undo", run: () => { window.setTimeout(() => { actions.openCompose(undoDraft); }, 0); } }); else showToast(message, kind); if (sentAccountId && !isDemo) { void api.sync(sentAccountId).then(() => load({ silent: true })).catch(() => undefined).finally(() => setThreadRefreshTick((value) => value + 1)); } }} onDraftSaved={(accountId) => { if (!isDemo) void api.sync(accountId).then(() => load({ silent: true })).catch(() => undefined); }} onDraftDiscarded={(messageId) => { setMessages((items) => items.filter((message) => message.id !== messageId)); setSelectedId((current) => current === messageId ? null : current); }} onSubmissionChanged={() => void refreshSubmissions(accounts, { silent: true })} fallbackFocusRef={mobileMenuButtonRef} /></Suspense>}
      {state.settingsOpen && <Suspense fallback={null}><SettingsModal settings={settings} accounts={accounts} onClose={() => actions.closeSettings()} onSettingsChange={applySettings} onTestNotification={testDesktopNotification} onTestSound={testNotificationSound} onTranslationConfigurationChanged={refreshTranslationAvailability} agentProviderSeed={agentProviderSnapshot ?? preloadedAgentBootstrap ?? undefined} categoryRequest={state.settingsCategoryRequest} onAgentProviderListChanged={(snapshot) => { setAgentProviderSnapshot({ providers: snapshot.items, defaultProviderId: snapshot.defaultProviderId }); setPreloadedAgentBootstrap((current) => current && { ...current, providers: snapshot.items, defaultProviderId: snapshot.defaultProviderId, configured: snapshot.items.some((provider) => provider.configured) }); setAgentProviderListVersion((version) => version + 1); }} fallbackFocusRef={mobileMenuButtonRef} demoMode={isDemo} /></Suspense>}
      {state.contactsOpen && <Suspense fallback={null}><ManagementDialogs demoMode={isDemo} onClose={() => actions.closeContacts()} fallbackFocusRef={mobileMenuButtonRef} /></Suspense>}
      {state.templatesOpen && <Suspense fallback={null}><TemplatesDialog demoMode={isDemo} onClose={() => actions.closeTemplates()} fallbackFocusRef={mobileMenuButtonRef} /></Suspense>}
      {state.calendarOpen && <Suspense fallback={null}><CalendarDialog demoMode={isDemo} onClose={() => actions.closeCalendar()} fallbackFocusRef={mobileMenuButtonRef} /></Suspense>}
      {calendarImportPayload?.open && (
        <Suspense fallback={null}><CalendarImportModal
          open={calendarImportPayload.open}
          initialIcsContent={calendarImportPayload.content}
          initialFileName={calendarImportPayload.filename}
          onClose={() => setCalendarImportPayload(null)}
          onSuccess={(count, replaced) => showToast(t(replaced ? "calendar.importSuccessReplace" : "calendar.importSuccessAppend", { count }), "success")}
        /></Suspense>
      )}
      {state.accountsOpen && <Suspense fallback={null}><AccountsDialog accounts={accounts} demoMode={isDemo} onClose={() => actions.closeAccounts()} onAddAccount={() => { actions.closeAccounts(); actions.openAddAccount(); }} onAccountRemoved={removeAccountFromView} onAccountSignatureChanged={updateAccountSignatureInState} onAccountSync={retryAccountSync} fallbackFocusRef={mobileMenuButtonRef} /></Suspense>}
      {state.sendingStatusOpen && <Suspense fallback={null}><SendingStatusModal accounts={accounts} submissions={submissions} loading={submissionLoading} loadError={submissionLoadError} onClose={() => actions.closeSendingStatus()} onRefresh={() => refreshSubmissions(accounts)} onSyncAccount={async (accountId) => { await retryAccountSync(accountId); }} onCreateNewMessage={(draft) => { actions.closeSendingStatus(); actions.openCompose(draft); }} onCancelScheduled={cancelScheduledSubmission} fallbackFocusRef={mobileMenuButtonRef} /></Suspense>}
      <Suspense fallback={null}><TranslationTermsDialog open={state.translationTermsOpen} onAccept={acceptTranslationTerms} onDecline={declineTranslationTerms} /></Suspense>
      <Suspense fallback={null}><StartupUpdatePrompt
        snapshot={desktopUpdateStatus}
        onSnapshot={setDesktopUpdateStatus}
        defer={state.anyModalOrSidebar || syncing || (isDemo && !desktopBridge() && !isDemoPromptRequested())}
        onVisibilityChange={setUpdatePromptOpen}
      /></Suspense>
      {pendingBatchDelete && (
        <div
          className={`modal-backdrop confirmation-backdrop${batchDeleteConfirmClosing ? " closing" : ""}`}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !batchBusy) {
              requestBatchDeleteConfirmClose();
            }
          }}
        >
          <section
            ref={batchDeleteDialogRef}
            className={`confirmation-card${batchDeleteConfirmClosing ? " closing" : ""}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="batch-delete-confirmation-title"
            aria-describedby="batch-delete-confirmation-description"
            tabIndex={-1}
          >
            <span className="eyebrow">{t("mail.selection.deleteConfirmEyebrow")}</span>
            <h3 id="batch-delete-confirmation-title">{t("mail.selection.deleteConfirmTitle", { count: selectAllPaged ? currentMessageTotal : selectedMessageIds.size })}</h3>
            <p id="batch-delete-confirmation-description">{t("mail.selection.deleteConfirmDescription", { count: selectAllPaged ? currentMessageTotal : selectedMessageIds.size })}</p>
            <div className="confirmation-actions">
              <button className="secondary-button" type="button" data-dialog-initial-focus disabled={batchBusy} onClick={requestBatchDeleteConfirmClose}>
                {t("common.cancel")}
              </button>
              <button className="secondary-button danger-button" type="button" disabled={batchBusy} onClick={() => { setPendingBatchDelete(false); void batchMoveMessages("trash"); }}>
                {batchBusy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
                {t("mail.selection.deleteConfirmAction")}
              </button>
            </div>
          </section>
        </div>
      )}
      {state.mobileSidebar && <button className="mobile-scrim" aria-label={t("navigation.closeMenu")} onClick={() => actions.closeMobileSidebar()} />}
      {toast && (
        <div className={`toast ${toast.kind}`} role={toast.kind === "error" || toast.kind === "warning" ? "alert" : "status"} aria-atomic="true">
          <span className="toast-icon" aria-hidden="true">
            {toast.icon === "mail" ? <Mail size={17} /> : toast.icon === "video" ? <Video size={17} /> : toast.icon === "calendar" ? <Calendar size={17} /> : toast.icon === "undo" ? <RotateCcw size={17} /> : toast.kind === "error" || toast.kind === "warning" ? <CircleAlert size={17} /> : toast.kind === "info" || toast.icon === "info" ? <Info size={17} /> : <Check size={17} />}
          </span>
          <span className="toast-message">{toast.message}</span>
          {toast.action && (
            <button className="toast-action" type="button" onClick={() => { dismissToast(); toast.action?.run(); }}>
              {toast.action.icon === "undo" && <RotateCcw size={13} aria-hidden="true" />}
              <span>{toast.action.label}</span>
            </button>
          )}
          <button className="toast-dismiss" type="button" aria-label={t("common.closeNotification")} data-tooltip={t("common.closeNotification")} onClick={dismissToast}><X size={16} /></button>
        </div>
      )}
      {autoReplyNotices.length > 0 && <AutoReplyToastStack behindModal={state.anyModalOpen} inAgent={agentOpen} notices={autoReplyNotices} onDismiss={(notice) => setAutoReplyNotices((items) => items.filter((item) => autoReplyNoticeKey(item) !== autoReplyNoticeKey(notice)))} />}
    </>
  );
}
