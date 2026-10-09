import { lazy, Suspense, useEffect, useRef, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import {
  Archive,
  ArrowLeft,
  CalendarArrowDown,
  CalendarPlus,
  ChevronDown,
  CircleAlert,
  Clock,
  Copy,
  Download,
  Eye,
  Forward,
  Inbox,
  Languages,
  LoaderCircle,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  Printer,
  RefreshCw,
  Reply,
  ReplyAll,
  ShieldCheck,
  Star,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { AgentMark } from "./AgentMark";
import { MailTextBody } from "./MailTextBody";
import { CustomAvatar, SenderAvatar, accountTone } from "./SenderAvatar";
import DatePicker from "./DatePicker";
import { canPreviewAttachment } from "./attachmentPreview";
import { hideFailedMailImages } from "./mailImageFallback";
import { presentAttachment } from "./attachmentPresentation";
import { AttachmentFileIcon, formatFileSize, isoFromDatetimeLocal, IconButton } from "./mailUi";
import { isIcsAttachment } from "./calendar/calendarUtils";
import MailCalendarInviteBanner from "./calendar/MailCalendarInviteBanner";
import { ErrorBoundary } from "./ErrorBoundary";
import TranslationPanel from "./TranslationPanel";
import { formatFullDate } from "./app/app-utils";
import type { MessageBodyPhase } from "./app/useMessageBody";
import type { splitQuotedMailText } from "./app/app-utils";
import type { useAttachmentExports } from "./app/useAttachmentExports";
import type { useMailTranslation } from "./app/useMailTranslation";
import type { useQuickMessageActions } from "./app/useQuickMessageActions";
import type { MoveTarget } from "./api";
import type { DialogRoutingActions, DialogRoutingState } from "./dialogRouting";
import type { Translate, useI18n } from "./i18n";
import type { Account, AppSettings, Message } from "./types";

// The attachment preview modal is only reachable from the reader, so its lazy
// boundary lives here instead of App.
const AttachmentPreviewModal = lazy(() => import("./AttachmentPreviewModal"));

type AttachmentExportsApi = ReturnType<typeof useAttachmentExports>;
type MailTranslationApi = ReturnType<typeof useMailTranslation>;
type QuickMessageActionsApi = ReturnType<typeof useQuickMessageActions>;
type Locales = ReturnType<typeof useI18n>["locales"];

export interface MailReaderProps {
  state: DialogRoutingState;
  actions: DialogRoutingActions;
  t: Translate;
  locale: string;
  locales: Locales;
  isDemo: boolean;
  settings: AppSettings;
  selected: Message | null;
  selectedThread: Message[] | null;
  selectedMessageAccount: Account | undefined;
  selectedSentRecipient: Message["to"][number] | undefined;
  quickReplySender: string;
  selectedMovePending: boolean;
  selectedMoveLocationUnverified: boolean;
  selectedRemoteActionsBlocked: boolean;
  selectedIsArchived: boolean;
  selectedIsInJunk: boolean;
  selectedIsSnoozed: boolean;
  selectedMoveActionLabel: string | null;
  localizedProviderName: (account: Pick<Account, "provider" | "providerName">) => string;
  closeReader: (restoreFocus?: boolean) => void;
  openReply: () => void;
  openReplyAll: () => void;
  openForward: () => void;
  toggleSelectedSeen: () => void | Promise<void>;
  toggleSelectedStar: () => void | Promise<void>;
  moveSelectedMessage: (target: MoveTarget) => Promise<void>;
  openAgentWorkspace?: () => void;
  openCalendarImport: AttachmentExportsApi["openCalendarImport"];
  exportSelectedEml: AttachmentExportsApi["exportSelectedEml"];
  printSelectedMessage: AttachmentExportsApi["printSelectedMessage"];
  exportContactVcf: AttachmentExportsApi["exportContactVcf"];
  exportCalendarIcs: AttachmentExportsApi["exportCalendarIcs"];
  /** R10: the open message's body-load phase; "error" shows a retry notice. */
  selectedBodyPhase?: MessageBodyPhase;
  onRetryBody?: () => void;
  // Snooze popover (state owned by useQuickMessageActions in App).
  snoozeOpen: boolean;
  setSnoozeOpen: (open: boolean) => void;
  snoozeMounted: boolean;
  snoozeClosing: boolean;
  beginSnoozeClose: () => void;
  snoozeRef: RefObject<HTMLDivElement | null>;
  snoozeCustomUntil: string;
  setSnoozeCustomUntil: (value: string) => void;
  snoozeOptions: QuickMessageActionsApi["snoozeOptions"];
  setSelectedSnoozed: QuickMessageActionsApi["setSelectedSnoozed"];
  clearSelectedSnooze: QuickMessageActionsApi["clearSelectedSnooze"];
  // Reader "more" popover (state owned by App).
  readerMoreOpen: boolean;
  setReaderMoreOpen: (open: boolean) => void;
  readerMoreMounted: boolean;
  readerMoreClosing: boolean;
  beginReaderMoreClose: () => void;
  readerMoreRef: RefObject<HTMLDivElement | null>;
  // Reader header / body UI state (owned by App so closeReader can reset it).
  recipientDetailsOpen: boolean;
  setRecipientDetailsOpen: Dispatch<SetStateAction<boolean>>;
  readerTitleRef: RefObject<HTMLHeadingElement | null>;
  threadCollapsed: boolean;
  threadCollapsible: boolean;
  setThreadCollapsedPref: Dispatch<SetStateAction<boolean>>;
  renderThreadStripItem: (threadMessage: Message) => ReactNode;
  verificationCodes: MailTranslationApi["verificationCodes"];
  copyDetectedVerificationCode: MailTranslationApi["copyDetectedVerificationCode"];
  shouldRenderTranslationPanel: boolean;
  translationAvailability: MailTranslationApi["translationAvailability"];
  translationState: MailTranslationApi["translationState"];
  llmTranslationAvailable: boolean;
  translationMailStyle: MailTranslationApi["translationMailStyle"];
  refreshTranslationAvailability: () => void | Promise<void>;
  translateSelectedMessage: () => void | Promise<void>;
  translateSelectedMessageWithLlm: () => void | Promise<void>;
  showSelectedTranslation: MailTranslationApi["showSelectedTranslation"];
  hideSelectedTranslation: MailTranslationApi["hideSelectedTranslation"];
  cancelTranslation: MailTranslationApi["cancelTranslation"];
  setForceShowTranslationId: MailTranslationApi["setForceShowTranslationId"];
  readerHtml: string;
  readerTextParts: ReturnType<typeof splitQuotedMailText>;
  readerTextSource: string;
  setQuotedExpanded: (expand: boolean) => void;
  visibleAttachments: Message["attachments"];
  attachmentDownloads: AttachmentExportsApi["attachmentDownloads"];
  zipAllPhase: AttachmentExportsApi["zipAllPhase"];
  zipAllAttachments: () => void | Promise<void>;
  downloadAttachment: AttachmentExportsApi["downloadAttachment"];
  handleIcsAttachmentImport: AttachmentExportsApi["handleIcsAttachmentImport"];
  openAttachmentPreview: AttachmentExportsApi["openAttachmentPreview"];
}

/**
 * The reading pane: reader toolbar (reply/star/snooze/more), thread strip,
 * message header, verification codes, translation panel, calendar invite
 * banner, body, attachment list and quick reply. Pure presentation — all
 * state, derivations and actions arrive as props from App.
 */
export function MailReader(props: MailReaderProps) {
  const {
    state,
    actions,
    t,
    locale,
    locales,
    isDemo,
    settings,
    selected,
    selectedThread,
    selectedMessageAccount,
    selectedSentRecipient,
    quickReplySender,
    selectedMovePending,
    selectedMoveLocationUnverified,
    selectedRemoteActionsBlocked,
    selectedIsArchived,
    selectedIsInJunk,
    selectedIsSnoozed,
    selectedMoveActionLabel,
    localizedProviderName,
    closeReader,
    openReply,
    openReplyAll,
    openForward,
    toggleSelectedSeen,
    toggleSelectedStar,
    moveSelectedMessage,
    openAgentWorkspace,
    openCalendarImport,
    exportSelectedEml,
    printSelectedMessage,
    exportContactVcf,
    exportCalendarIcs,
    selectedBodyPhase,
    onRetryBody,
    snoozeOpen,
    setSnoozeOpen,
    snoozeMounted,
    snoozeClosing,
    beginSnoozeClose,
    snoozeRef,
    snoozeCustomUntil,
    setSnoozeCustomUntil,
    snoozeOptions,
    setSelectedSnoozed,
    clearSelectedSnooze,
    readerMoreOpen,
    setReaderMoreOpen,
    readerMoreMounted,
    readerMoreClosing,
    beginReaderMoreClose,
    readerMoreRef,
    recipientDetailsOpen,
    setRecipientDetailsOpen,
    readerTitleRef,
    threadCollapsed,
    threadCollapsible,
    setThreadCollapsedPref,
    renderThreadStripItem,
    verificationCodes,
    copyDetectedVerificationCode,
    shouldRenderTranslationPanel,
    translationAvailability,
    translationState,
    llmTranslationAvailable,
    translationMailStyle,
    refreshTranslationAvailability,
    translateSelectedMessage,
    translateSelectedMessageWithLlm,
    showSelectedTranslation,
    hideSelectedTranslation,
    cancelTranslation,
    setForceShowTranslationId,
    readerHtml,
    readerTextParts,
    readerTextSource,
    setQuotedExpanded,
    visibleAttachments,
    attachmentDownloads,
    zipAllPhase,
    zipAllAttachments,
    downloadAttachment,
    handleIcsAttachmentImport,
    openAttachmentPreview,
  } = props;

  // Remote images now load through /api/images/proxy, which fails closed, so a
  // dead link or a blocked host must cost the reader that one picture and
  // nothing else. See mailImageFallback.ts.
  const mailHtmlRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => hideFailedMailImages(mailHtmlRef.current), [readerHtml]);

  return (
    <section className={`reader-column ${selected ? "has-message" : ""}`}>
      {selected ? (
        <ErrorBoundary key={selected.id} t={t} area={t("mail.readerArea")}>
          <header className="reader-toolbar">
            <IconButton label={t("mail.reader.backToList")} className="reader-back" onClick={() => closeReader(true)}><ArrowLeft size={18} /></IconButton>
            <div className="reader-actions">
              <IconButton label={t("mail.action.reply")} onClick={openReply}><Reply size={18} /></IconButton>
              <IconButton label={t("mail.action.replyAll")} className="reader-action-secondary" onClick={openReplyAll}><ReplyAll size={18} /></IconButton>
              <IconButton label={t("mail.action.forward")} className="reader-action-secondary" onClick={openForward}><Forward size={18} /></IconButton>
              <span className="toolbar-divider" aria-hidden="true" />
              <IconButton label={selectedMoveActionLabel ?? (selected.seen ? t("mail.action.markUnread") : t("mail.action.markRead"))} onClick={() => void toggleSelectedSeen()} disabled={selectedRemoteActionsBlocked}>{selected.seen ? <Mail size={18} /> : <MailOpen size={18} />}</IconButton>
              <IconButton label={selectedMoveActionLabel ?? (selected.flagged ? t("mail.action.unstar") : t("mail.action.star"))} className={selected.flagged ? "active-star" : ""} onClick={() => void toggleSelectedStar()} disabled={selectedRemoteActionsBlocked}><Star size={18} fill={selected.flagged ? "currentColor" : "none"} /></IconButton>
              <IconButton label={selectedMoveActionLabel ?? t("mail.action.archive")} className="reader-action-secondary" onClick={() => void moveSelectedMessage("archive")} disabled={selectedRemoteActionsBlocked || selectedIsArchived}><Archive size={18} /></IconButton>
              <IconButton label={selectedMoveActionLabel ?? t("mail.action.moveToTrash")} className="reader-action-secondary" onClick={() => void moveSelectedMessage("trash")} disabled={selectedRemoteActionsBlocked}><Trash2 size={18} /></IconButton>
              <div className="reader-snooze" ref={snoozeRef}>
                <IconButton label={selectedIsSnoozed ? t("mail.snooze.reschedule") : t("mail.snooze.title")} className={`reader-action-secondary${selectedIsSnoozed ? " snoozed" : ""}`} onClick={() => { if (snoozeOpen) { beginSnoozeClose(); } else { setSnoozeOpen(true); } setSnoozeCustomUntil(""); }} expanded={snoozeOpen} disabled={selectedRemoteActionsBlocked}><Clock size={18} /></IconButton>
                {snoozeMounted && (
                  <div className={`snooze-menu${snoozeClosing ? " closing" : ""}`} role="menu" aria-label={t("mail.snooze.title")}>
                    {selectedIsSnoozed && selected.snoozedUntil && (
                      <>
                        <div className="snooze-current" role="status"><Clock size={14} />{t("mail.snooze.current", { until: formatFullDate(selected.snoozedUntil, locale) })}</div>
                        <button type="button" role="menuitem" onClick={() => void clearSelectedSnooze()}><X size={15} />{t("mail.snooze.clear")}</button>
                      </>
                    )}
                    {snoozeOptions.map((option) => (
                      <button key={option.key} type="button" role="menuitem" onClick={() => void setSelectedSnoozed(option.compute().toISOString())}><Clock size={15} />{option.label}</button>
                    ))}
                    <div className="snooze-custom">
                      <label htmlFor="snooze-custom-input">{t("mail.snooze.customLabel")}</label>
                      <span className="snooze-custom-controls">
                        <DatePicker mode="datetime" value={snoozeCustomUntil} onChange={setSnoozeCustomUntil} aria-label={t("mail.snooze.customLabel")} />
                        <button type="button" onClick={() => { const iso = isoFromDatetimeLocal(snoozeCustomUntil); if (iso) void setSelectedSnoozed(iso); }} disabled={!snoozeCustomUntil}>{t("common.ok")}</button>
                      </span>
                    </div>
                  </div>
                )}
              </div>
              <div className="reader-more" ref={readerMoreRef}>
                <IconButton label={t("mail.action.more")} className="reader-more-toggle" onClick={() => { if (readerMoreOpen) { beginReaderMoreClose(); } else { setReaderMoreOpen(true); } }} expanded={readerMoreOpen}><MoreHorizontal size={19} /></IconButton>
                {readerMoreMounted && (
                  <div className={`reader-more-menu${readerMoreClosing ? " closing" : ""}`} role="menu" aria-label={t("mail.action.more")}>
                    <button type="button" role="menuitem" onClick={() => { setReaderMoreOpen(false); openReplyAll(); }}><ReplyAll size={16} />{t("mail.action.replyAll")}</button>
                    <button type="button" role="menuitem" onClick={() => { setReaderMoreOpen(false); openForward(); }}><Forward size={16} />{t("mail.action.forward")}</button>
                    <button type="button" role="menuitem" disabled={selectedRemoteActionsBlocked || selectedIsArchived} onClick={() => { setReaderMoreOpen(false); void moveSelectedMessage("archive"); }}><Archive size={16} />{t("mail.action.archive")}</button>
                    <button type="button" role="menuitem" disabled={selectedRemoteActionsBlocked} onClick={() => { setReaderMoreOpen(false); void exportSelectedEml(); }}><Download size={16} />{t("mail.action.exportEml")}</button>
                    <button type="button" role="menuitem" onClick={() => { setReaderMoreOpen(false); exportContactVcf(); }}><UserRound size={16} />{t("mail.action.saveVcf")}</button>
                    <button type="button" role="menuitem" onClick={() => { setReaderMoreOpen(false); exportCalendarIcs(); }}><CalendarArrowDown size={16} />{t("mail.action.exportIcs")}</button>
                    {!shouldRenderTranslationPanel && (
                      <button type="button" role="menuitem" onClick={() => { setReaderMoreOpen(false); setForceShowTranslationId(selected.id); }}><Languages size={16} />{t("translation.action", { language: locales.find((item) => item.locale === locale)?.nativeName ?? locale })}</button>
                    )}
                    <button type="button" role="menuitem" disabled={selectedRemoteActionsBlocked} onClick={() => { setReaderMoreOpen(false); printSelectedMessage(); }}><Printer size={16} />{t("mail.action.print")}</button>
                    {!selectedIsInJunk && (
                      <button type="button" role="menuitem" disabled={selectedRemoteActionsBlocked} onClick={() => { setReaderMoreOpen(false); void moveSelectedMessage("junk"); }}><ShieldCheck size={16} />{t("mail.action.reportSpam")}</button>
                    )}
                    {selectedIsInJunk && (
                      <button type="button" role="menuitem" disabled={selectedRemoteActionsBlocked} onClick={() => { setReaderMoreOpen(false); void moveSelectedMessage("inbox"); }}><Inbox size={16} />{t("mail.action.notSpam")}</button>
                    )}
                    <button type="button" role="menuitem" className="reader-more-danger" disabled={selectedRemoteActionsBlocked} onClick={() => { setReaderMoreOpen(false); void moveSelectedMessage("trash"); }}><Trash2 size={16} />{t("mail.action.moveToTrash")}</button>
                  </div>
                )}
              </div>
              {openAgentWorkspace && <button className="agent-launch-button" type="button" onClick={() => openAgentWorkspace()} aria-label={t("agent.open")} data-tooltip={t("agent.open")}><span className="agent-launch-mark" aria-hidden="true"><AgentMark size={19} /></span><span>{t("agent.launch")}</span></button>}
            </div>
          </header>
          {selectedThread && selectedThread.length > 1 && (
            <section className="thread-strip" aria-label={t("mail.thread.label", { count: selectedThread.length })}>
              <span className="thread-strip-caption">{t("mail.thread.label", { count: selectedThread.length })}</span>
              <div className="thread-strip-messages">
                {threadCollapsed
                  ? (<>
                      {renderThreadStripItem(selectedThread[0]!)}
                      <button type="button" className="thread-strip-fold" onClick={() => setThreadCollapsedPref(false)} aria-label={t("mail.thread.expand", { count: selectedThread.length - 2 })} data-tooltip={t("mail.thread.expand", { count: selectedThread.length - 2 })}>
                        <MoreHorizontal size={15} /><span>{t("mail.thread.folded", { count: selectedThread.length - 2 })}</span>
                      </button>
                      {renderThreadStripItem(selectedThread[selectedThread.length - 1]!)}
                    </>)
                  : selectedThread.map((threadMessage) => renderThreadStripItem(threadMessage))}
              </div>
              {threadCollapsible && (
                <button type="button" className={`thread-strip-toggle${threadCollapsed ? "" : " expanded"}`} onClick={() => setThreadCollapsedPref((value) => !value)} aria-expanded={!threadCollapsed}>
                  {t(threadCollapsed ? "mail.thread.expandAll" : "mail.thread.collapse", { count: selectedThread.length })}
                </button>
              )}
            </section>
          )}
          {selectedMoveLocationUnverified && <section className="move-location-notice" role="status"><CircleAlert size={18} /><div><strong>{t("mail.moveLocationUnverified.title")}</strong><p>{t("mail.moveLocationUnverified.description")}</p></div></section>}
          <div className="reader-split">
            <article className="mail-reader">
              <header className="mail-title"><span className="account-badge">{selectedMessageAccount ? localizedProviderName(selectedMessageAccount) : selected.providerName}</span><h2 ref={readerTitleRef} tabIndex={-1}>{selected.subject}</h2><div className="mail-people">{(() => { const headerPerson = selectedSentRecipient ?? selected.from; return <><SenderAvatar name={headerPerson.name} address={headerPerson.address} tone={accountTone(headerPerson.address)} size="large" gravatarEnabled={settings.avatarGravatarEnabled} bimiEnabled={settings.avatarBimiEnabled} /><div className="mail-people-copy"><strong>{headerPerson.name || headerPerson.address}</strong><button className="mail-recipient-toggle" type="button" data-tooltip={headerPerson.address} aria-expanded={recipientDetailsOpen} onClick={() => setRecipientDetailsOpen((value) => !value)}>{selectedSentRecipient ? t("mail.reader.toRecipient", { recipient: headerPerson.name || headerPerson.address }) : t("mail.reader.toMe")} <ChevronDown className={recipientDetailsOpen ? "open" : ""} size={13} /></button>{recipientDetailsOpen && <div className="mail-recipient-details"><span>{t("compose.sender")}</span><strong>{selected.from.name ? `${selected.from.name} <${selected.from.address}>` : selected.from.address}</strong><span>{t("compose.to")}</span><strong>{selected.to.length ? selected.to.map((recipient) => recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address).join(t("common.listSeparator")) : selected.accountEmail}</strong>{selected.cc.length > 0 && <><span>{t("compose.cc")}</span><strong>{selected.cc.map((recipient) => recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address).join(t("common.listSeparator"))}</strong></>}</div>}</div></>; })()}<time>{formatFullDate(selected.sentAt, locale)}</time></div></header>
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
              {shouldRenderTranslationPanel && (
                <TranslationPanel
                  availability={translationAvailability}
                  state={translationState}
                  llmAvailable={llmTranslationAvailable}
                  mailStyle={translationMailStyle}
                  onCheckAvailability={() => void refreshTranslationAvailability()}
                  onTranslate={() => void translateSelectedMessage()}
                  onTranslateWithLlm={() => void translateSelectedMessageWithLlm()}
                  onShow={showSelectedTranslation}
                  onHide={hideSelectedTranslation}
                  onCancel={cancelTranslation}
                />
              )}
              <MailCalendarInviteBanner messageId={selected.id} attachments={selected.attachments} onImportClick={openCalendarImport} onViewCalendar={() => actions.openCalendar()} demoMode={isDemo} />
              {selectedBodyPhase === "error" && (
                <section className="move-location-notice" role="alert">
                  <CircleAlert size={18} />
                  <div>
                    <strong>{t("mail.body.loadFailed")}</strong>
                    {onRetryBody && <button className="secondary-button" type="button" onClick={onRetryBody}>{t("common.retry")}</button>}
                  </div>
                </section>
              )}
              <div className="mail-content">{selected.htmlBody
                ? <div className="mail-html" ref={mailHtmlRef} dangerouslySetInnerHTML={{ __html: readerHtml }} />
                : <div className="mail-text"><MailTextBody body={readerTextParts.quote ? readerTextParts.body : readerTextSource} suffix={readerTextParts.quote ? <button type="button" className="mail-quote-toggle" onClick={() => setQuotedExpanded(true)}>{t("mail.reader.showQuoted")}</button> : null} /></div>}
              </div>
              {visibleAttachments.length > 0 && (
                <section className="attachment-list" aria-label={t("mail.attachment.aria", { count: visibleAttachments.length })}>
                  <div className="attachment-list-heading"><Paperclip size={15} /><span>{t("compose.attachments")}</span><small>{t("mail.attachment.fileCount", { count: visibleAttachments.length })}</small><span className="attachment-heading-actions"><IconButton label={t("mail.attachment.downloadAllZip")} disabled={zipAllPhase === "zipping" || selectedMovePending || selected.movePending || selected.moveLocationUnverified} onClick={() => void zipAllAttachments()}>{zipAllPhase === "zipping" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}</IconButton></span></div>
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
                        <div className="attachment-actions">
                          {canPreviewAttachment(attachment.filename, attachment.contentType) && (
                            <IconButton label={t("mail.attachment.preview", { filename: attachment.filename })} disabled={selectedRemoteActionsBlocked} onClick={() => openAttachmentPreview(selected, attachment)}><Eye size={16} /></IconButton>
                          )}
                          {isIcsAttachment(attachment) && (
                            <IconButton label={t("calendar.importFromEmailAttachment")} disabled={selectedRemoteActionsBlocked} onClick={() => void handleIcsAttachmentImport(selected, attachment)}><CalendarPlus size={16} /></IconButton>
                          )}
                          <IconButton label={selectedMoveActionLabel ?? (download?.phase === "error" ? t("mail.attachment.retryDownload", { filename: attachment.filename }) : t("mail.attachment.download", { filename: attachment.filename }))} disabled={isDownloading || selectedRemoteActionsBlocked} onClick={() => void downloadAttachment(selected, attachment)}>{isDownloading ? <LoaderCircle className="spin" size={16} /> : download?.phase === "error" ? <RefreshCw size={16} /> : <Download size={16} />}</IconButton>
                        </div>
                      </div>
                    );
                  })}
                </section>
              )}
              <footer className="quick-reply"><CustomAvatar name={selected.accountEmail} address={selected.accountEmail} tone={accountTone(selected.accountEmail)} size="small" /><button onClick={openReply}>{t("mail.reader.replyTo", { sender: quickReplySender })}</button></footer>
            </article>
            {state.attachmentPreview && <Suspense fallback={null}><AttachmentPreviewModal messageId={state.attachmentPreview.message.id} attachment={state.attachmentPreview.attachment} onClose={() => actions.closeAttachmentPreview()} /></Suspense>}
          </div>
        </ErrorBoundary>
      ) : (
        <div className="reader-empty"><div className="reader-orb"><Mail size={32} /></div><h2>{t("mail.reader.emptyTitle")}</h2><p>{t("mail.reader.emptyDescription")}</p></div>
      )}
    </section>
  );
}
