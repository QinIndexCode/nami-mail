// @vitest-environment jsdom
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailReader, type MailReaderProps } from "./MailReader";
import type { DialogRoutingState } from "./dialogRouting";
import { I18nProvider, translate } from "./i18n";
import { defaultAppSettings, type Message } from "./types";

const t = ((key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values)) as unknown as MailReaderProps["t"];

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    accountId: "acc-1",
    accountEmail: "me@example.com",
    providerName: "example",
    mailbox: "INBOX",
    uid: 42,
    subject: "Hello",
    from: { name: "Sender", address: "sender@example.com" },
    to: [{ name: "Me", address: "me@example.com" }],
    cc: [],
    sentAt: "2026-08-01T09:00:00.000Z",
    snippet: "",
    textBody: "",
    flags: [],
    seen: true,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 100,
    ...overrides,
  };
}

const routingState: DialogRoutingState = {
  addOpen: false,
  composeOpen: false,
  composeDraft: {} as never,
  settingsOpen: false,
  settingsCategoryRequest: null,
  contactsOpen: false,
  templatesOpen: false,
  calendarOpen: false,
  accountsOpen: false,
  sendingStatusOpen: false,
  translationTermsOpen: false,
  translationTermsAccepted: false,
  attachmentPreview: null,
  mobileSidebar: false,
  anyModalOpen: false,
  anyModalOrSidebar: false,
  batchDeleteOpen: false,
  agentOpen: false,
};

/** Props the reader only reads at runtime for these tests; absent callbacks are
 *  never invoked by a body-loading/subject render. */
function readerProps(overrides: Partial<MailReaderProps> = {}): MailReaderProps {
  const base = {
    state: routingState,
    actions: { openCalendar: () => {}, closeAttachmentPreview: () => {} },
    t,
    locale: "zh-CN",
    locales: [{ locale: "zh-CN", nativeName: "简体中文" }],
    isDemo: false,
    settings: { ...defaultAppSettings, avatarGravatarEnabled: false, avatarBimiEnabled: false },
    selected: makeMessage(),
    selectedThread: null,
    selectedMessageAccount: undefined,
    selectedSentRecipient: undefined,
    quickReplySender: "Sender",
    selectedMovePending: false,
    selectedMoveLocationUnverified: false,
    selectedRemoteActionsBlocked: false,
    selectedIsArchived: false,
    selectedIsInJunk: false,
    selectedIsSnoozed: false,
    selectedMoveActionLabel: null,
    localizedProviderName: (account: { providerName: string }) => account.providerName,
    closeReader: () => {},
    openReply: () => {},
    openReplyAll: () => {},
    openForward: () => {},
    toggleSelectedSeen: () => {},
    toggleSelectedStar: () => {},
    moveSelectedMessage: () => Promise.resolve(),
    openCalendarImport: () => {},
    exportSelectedEml: () => Promise.resolve(),
    printSelectedMessage: () => {},
    exportContactVcf: () => {},
    exportCalendarIcs: () => Promise.resolve(),
    selectedBodyPhase: "loaded",
    onRetryBody: () => {},
    snoozeOpen: false,
    setSnoozeOpen: () => {},
    snoozeMounted: false,
    snoozeClosing: false,
    beginSnoozeClose: () => {},
    snoozeRef: { current: null },
    snoozeCustomUntil: "",
    setSnoozeCustomUntil: () => {},
    snoozeOptions: [],
    setSelectedSnoozed: () => Promise.resolve(),
    clearSelectedSnooze: () => Promise.resolve(),
    readerMoreOpen: true,
    setReaderMoreOpen: () => {},
    readerMoreMounted: true,
    readerMoreClosing: false,
    beginReaderMoreClose: () => {},
    readerMoreRef: { current: null },
    recipientDetailsOpen: false,
    setRecipientDetailsOpen: () => {},
    readerTitleRef: { current: null },
    threadCollapsed: false,
    threadCollapsible: false,
    setThreadCollapsedPref: () => {},
    renderThreadStripItem: () => null,
    verificationCodes: [],
    copyDetectedVerificationCode: () => {},
    shouldRenderTranslationPanel: false,
    translationAvailability: "available",
    translationState: { phase: "idle" },
    llmTranslationAvailable: false,
    translationMailStyle: "",
    refreshTranslationAvailability: () => Promise.resolve(),
    translateSelectedMessage: () => Promise.resolve(),
    translateSelectedMessageWithLlm: () => Promise.resolve(),
    showSelectedTranslation: () => {},
    hideSelectedTranslation: () => {},
    cancelTranslation: () => {},
    setForceShowTranslationId: () => {},
    readerHtml: "",
    readerTextParts: { body: "", quote: "" },
    readerTextSource: "",
    setQuotedExpanded: () => {},
    visibleAttachments: [],
    attachmentDownloads: {},
    zipAllPhase: "idle",
    zipAllAttachments: () => Promise.resolve(),
    downloadAttachment: () => Promise.resolve(),
    handleIcsAttachmentImport: () => Promise.resolve(),
    openAttachmentPreview: () => {},
    ...overrides,
  };
  return base as unknown as MailReaderProps;
}

describe("MailReader body loading and blank subjects", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: MailReaderProps) {
    act(() => {
      root.render(
        <I18nProvider>
          <MailReader {...props} />
        </I18nProvider>,
      );
    });
  }

  function buttonByText(label: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(label)) ?? null;
  }

  it("renders a loading state instead of the list row's preview while the body is in flight", () => {
    const message = makeMessage({ snippet: "PREVIEW-SNIPPET", textBody: "" });
    render(readerProps({ selected: message, selectedBodyPhase: "loading", readerTextSource: "PREVIEW-SNIPPET" }));

    expect(container.querySelector(".mail-body-loading"), "a visible loading state").not.toBeNull();
    expect(container.querySelector(".mail-text"), "the preview must not stand in for the body").toBeNull();
    expect(container.textContent, "the truncated preview text must not leak into the reader").not.toContain("PREVIEW-SNIPPET");
    expect(container.textContent).toContain("正在加载邮件正文");
  });

  it("withholds the body-dependent export and print actions until the body lands", () => {
    const message = makeMessage({ subject: "Hello" });
    render(readerProps({ selected: message, selectedBodyPhase: "loading" }));
    expect(buttonByText("导出 EML 文件"), "raw export needs the full body").toBeNull();
    expect(buttonByText("打印"), "printing needs the full body").toBeNull();

    render(readerProps({ selected: message, selectedBodyPhase: "loaded", readerTextSource: "FULL-BODY-TEXT" }));
    expect(buttonByText("导出 EML 文件"), "the action is back once the body is loaded").not.toBeNull();
    expect(buttonByText("打印"), "the action is back once the body is loaded").not.toBeNull();
    expect(container.querySelector(".mail-body-loading")).toBeNull();
    expect(container.querySelector(".mail-text")?.textContent).toContain("FULL-BODY-TEXT");
  });

  it("renders the localized placeholder for a blank or whitespace-only subject", () => {
    render(readerProps({ selected: makeMessage({ subject: "" }) }));
    expect(container.querySelector("h2")?.textContent).toBe("无主题");

    render(readerProps({ selected: makeMessage({ subject: "   " }) }));
    expect(container.querySelector("h2")?.textContent).toBe("无主题");

    render(readerProps({ selected: makeMessage({ subject: "Quarterly report" }) }));
    expect(container.querySelector("h2")?.textContent).toBe("Quarterly report");
  });
});
