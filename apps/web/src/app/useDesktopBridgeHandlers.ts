import { useEffect, useRef } from "react";
import { api } from "../api";
import { autoReplyNoticeKey } from "../AutoReplyToastStack";
import { desktopBridge, type DesktopAutoReplyNotice } from "../desktop";
import { parseMailtoUrl } from "../mailtoLink";
import type { ComposeDraft } from "../mailUi";
import type { MessageListQuery } from "../mailListState";
import type { useToastQueue } from "../notifications/useToastQueue";
import type { Translate } from "../i18n";

type ShowToast = ReturnType<typeof useToastQueue>["showToast"];
type MailView = MessageListQuery["messageView"];

export interface DesktopBridgeHandlersOptions {
  isDemo: boolean;
  t: Translate;
  showToast: ShowToast;
  requestRefresh: () => void;
  openNotifiedMessage: (messageId: string) => Promise<void>;
  chooseView: (next: MailView) => void;
  openCompose: (draft?: ComposeDraft) => void;
  setAutoReplyNotices: (updater: DesktopAutoReplyNotice[] | ((items: DesktopAutoReplyNotice[]) => DesktopAutoReplyNotice[])) => void;
}

/**
 * Desktop-bridge subscriptions and their web-runtime fallbacks. The
 * subscriptions read their collaborators through a ref so they can be
 * installed exactly once (see the comment on `bridgeHandlersRef`).
 */
export function useDesktopBridgeHandlers(options: DesktopBridgeHandlersOptions): void {
  const {
    isDemo,
    t,
    showToast,
    requestRefresh,
    openNotifiedMessage,
    chooseView,
    openCompose,
    setAutoReplyNotices,
  } = options;

  // Latest handlers for the desktop-bridge subscribers below, read at call time.
  // The subscriptions are installed once (their deps are effectively empty),
  // because re-installing them whenever a callback identity changes — a view
  // switch re-creates `chooseView`, a settings edit re-creates the toast helper —
  // leaves a window in which the main process delivers a new-mail notification to
  // nobody. The refresh fallback hides the loss; the alert and the toast do not.
  const bridgeHandlersRef = useRef({
    requestRefresh,
    showToast,
    t,
    openNotifiedMessage,
    chooseView,
    openCompose,
  });
  bridgeHandlersRef.current = {
    requestRefresh,
    showToast,
    t,
    openNotifiedMessage,
    chooseView,
    openCompose,
  };

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge || isDemo) return undefined;
    const unsubscribeNewMail = bridge.onNewMail((notice) => {
      const handlers = bridgeHandlersRef.current;
      handlers.requestRefresh();
      if (!notice.shouldAlert) return;
      // The custom sound (soft/bright) is played by the main process before
      // the native banner goes out; nothing for the renderer to play here.
      handlers.showToast(
        notice.count === 1
          ? handlers.t("mail.notification.singleToast", { sender: notice.fromName || notice.fromAddress || handlers.t("mail.notification.newContact") })
          : handlers.t("mail.notification.multipleToast", { count: notice.count }),
        "info",
        { priority: "low", icon: "mail" },
      );
    });
    const unsubscribeOpenMessage = bridge.onOpenMessage((messageId) => {
      void bridgeHandlersRef.current.openNotifiedMessage(messageId);
    });
    const unsubscribeComposeNew = bridge.onComposeNew?.((mailtoUrl) => {
      bridgeHandlersRef.current.openCompose(parseMailtoUrl(mailtoUrl ?? "") ?? {});
    });
    const unsubscribeOpenInbox = bridge.onOpenInbox?.(() => {
      bridgeHandlersRef.current.chooseView("inbox");
    });
    const unsubscribeAutoReply = bridge.onAutoReply?.((notice) => {
      setAutoReplyNotices((items) => {
        const key = autoReplyNoticeKey(notice);
        if (items.some((item) => autoReplyNoticeKey(item) === key)) return items;
        return [...items.slice(-4), notice];
      });
    });
    const unsubscribeConfirmationResult = bridge.onAgentConfirmationResult?.((result) => {
      if (!result.ok) return;
      // The draft was approved or rejected elsewhere (pending dialog, popup
      // cancel); a stale "awaiting approval" popup must not linger.
      setAutoReplyNotices((items) => items.filter((item) => !(item.kind === "pending" && item.confirmationId === result.confirmationId)));
    });
    return () => {
      unsubscribeNewMail();
      unsubscribeOpenMessage();
      unsubscribeComposeNew?.();
      unsubscribeOpenInbox?.();
      unsubscribeAutoReply?.();
      unsubscribeConfirmationResult?.();
    };
    // The handlers are read through bridgeHandlersRef, so this subscription
    // is installed exactly once.
  }, [isDemo, setAutoReplyNotices]);

  // A mailto link anywhere in the document (sidebar, message body, agent
  // answer) opens a pre-filled compose window instead of the OS default
  // client. Modified clicks and already-handled links pass through untouched.
  useEffect(() => {
    const handleMailtoClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.toLowerCase().startsWith("mailto:")) return;
      event.preventDefault();
      openCompose(parseMailtoUrl(href) ?? {});
    };
    document.addEventListener("click", handleMailtoClick);
    return () => document.removeEventListener("click", handleMailtoClick);
  }, [openCompose]);

  // Plain web sessions have no desktop bridge to push auto-reply events, so
  // poll the pending list and surface newly drafted replies as toasts. The
  // bridge-owned effect above handles the desktop runtime exclusively.
  useEffect(() => {
    if (isDemo || desktopBridge()) return undefined;
    let known = new Set<string>();
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      // A poll that outlives the 20s interval would race its successor: the
      // stale response could re-add already-known notices or prune notices the
      // fresher response just surfaced. Skip while one is still running.
      if (inFlight) return;
      inFlight = true;
      try {
        const { items } = await api.autoReplyPending();
        if (disposed) return;
        const nextKnown = new Set(items.map((item) => item.confirmationId));
        const additions = items
          .filter((item) => !known.has(item.confirmationId))
          .map((item): DesktopAutoReplyNotice => ({
            kind: "pending",
            confirmationId: item.confirmationId,
            requestId: item.requestId,
            accountId: item.accountId,
            messageId: item.messageId,
            subject: item.subject,
            fromName: item.fromName,
            fromAddress: item.fromAddress,
            sensitive: item.sensitive,
            createdAt: item.createdAt,
            expiresAt: item.expiresAt,
            replyPreview: item.preview.summary,
          }));
        known = nextKnown;
        if (additions.length > 0) {
          setAutoReplyNotices((current) => {
            const merged = [...current];
            for (const notice of additions) {
              if (!merged.some((item) => autoReplyNoticeKey(item) === autoReplyNoticeKey(notice))) merged.push(notice);
            }
            return merged.slice(-5);
          });
        }
        // Drafts that were resolved or expired elsewhere must not linger.
        setAutoReplyNotices((current) => current.filter((item) => item.kind === "sent" || nextKnown.has(item.confirmationId)));
      } catch {
        // Polling failures are silent; the review dialog surfaces errors.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      // A hidden tab needs no fresh toast data; the next tick after the user
      // returns catches up (at most one interval stale).
      if (document.hidden) return;
      void poll();
    }, 20_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [isDemo, setAutoReplyNotices]);
}
