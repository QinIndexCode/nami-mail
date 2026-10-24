import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type MoveTarget } from "../api";
import { usePopupExitTransition } from "../hooks/usePopupExitTransition";
import { mailErrorToastMessage } from "../errorPresentation";
import { isSnoozedMessage, type MessageListQuery } from "../mailListState";
import { demoMoveDestination, moveActionKey } from "./app-utils";
import type { MailStore } from "./mailStore";
import type { useToastQueue } from "../notifications/useToastQueue";
import type { Translate } from "../i18n";
import type { Message } from "../types";

type ShowToast = ReturnType<typeof useToastQueue>["showToast"];
type MailView = MessageListQuery["messageView"];

export interface QuickActionsLoadOptions {
  silent?: boolean;
}

export interface QuickMessageActionsOptions {
  selected: Message | null;
  selectedRemoteActionsBlocked: boolean;
  isDemo: boolean;
  t: Translate;
  showToast: ShowToast;
  store: MailStore;
  viewRef: { current: MailView };
  /** Reader-domain busy flags stay in App; quick actions just flip them. */
  messageFlagging: boolean;
  messageAction: MoveTarget | null;
  setMessageFlagging: (flagging: boolean) => void;
  setMessageAction: (action: MoveTarget | null) => void;
  batchBusy: boolean;
  applyBatchFlaggedChange: (ids: readonly string[], flagged: boolean) => void;
  loadRequestRef: { current: number };
  load: (options?: QuickActionsLoadOptions) => Promise<void>;
  /**
   * The pagination-preserving silent refresh. A successful write reconciles
   * through this instead of a full list load: `load` replaces the window with
   * the first page and resets the cursor, which drops the pages the user has
   * already scrolled in and jumps the list under them.
   */
  reconcile: () => Promise<void> | void;
  applyLocalSeenChange: (message: Message, nextSeen: boolean) => void;
  updateUnreadViewRecentlyRead: (message: Pick<Message, "id" | "seen">, nextSeen: boolean) => void;
  setSelectedId: (id: string | null) => void;
}

export interface QuickMessageActions {
  snoozeOpen: boolean;
  setSnoozeOpen: (open: boolean) => void;
  snoozeMounted: boolean;
  snoozeClosing: boolean;
  beginSnoozeClose: () => void;
  snoozeRef: { current: HTMLDivElement | null };
  snoozeCustomUntil: string;
  setSnoozeCustomUntil: (value: string) => void;
  snoozeOptions: { key: string; label: string; compute: () => Date }[];
  selectedIsSnoozed: boolean;
  setSelectedSnoozed: (untilIso: string) => Promise<void>;
  clearSelectedSnooze: () => Promise<void>;
  quickToggleStar: (message: Message) => Promise<void>;
  quickToggleSeen: (message: Message) => Promise<void>;
  quickMoveMessage: (message: Message, target: MoveTarget) => Promise<void>;
}

export function useQuickMessageActions(options: QuickMessageActionsOptions): QuickMessageActions {
  const {
    selected,
    selectedRemoteActionsBlocked,
    isDemo,
    t,
    showToast,
    store,
    viewRef,
    messageFlagging,
    messageAction,
    setMessageFlagging,
    setMessageAction,
    batchBusy,
    applyBatchFlaggedChange,
    loadRequestRef,
    load,
    reconcile,
    applyLocalSeenChange,
    updateUnreadViewRecentlyRead,
    setSelectedId,
  } = options;

  const quickToggleStar = useCallback(async (message: Message) => {
    if (selectedRemoteActionsBlocked) return;
    // One in-flight mutation per row, exactly like quickToggleSeen: without this
    // guard a second click starts a second PATCH, and whichever request fails
    // last writes its own rollback over the other's optimistic value. The row
    // count lives in the pending registry, so a batch's overlapping flag write
    // also blocks a click here instead of being clobbered by it.
    if (store.getState().pendingTargets.flagOverrides.has(message.id)) return;
    if (messageFlagging || messageAction) showToast(t("mail.action.queued"), "info");
    // The rollback baseline is the row's current value, not the caller's
    // captured copy: `message` may predate another write accepted between the
    // click and the request, and reverting to it would undo that newer state.
    const previousFlagged = store.getMessages().find((item) => item.id === message.id)?.flagged ?? message.flagged;
    const nextFlagged = !previousFlagged;
    setMessageFlagging(true);
    store.pinFlags([message.id]);
    applyBatchFlaggedChange([message.id], nextFlagged);
    try {
      if (!isDemo) await api.updateMessageFlags(message.id, { flagged: nextFlagged });
      showToast(nextFlagged ? t("mail.action.starred") : t("mail.action.unstarred"));
    } catch (error) {
      applyBatchFlaggedChange([message.id], previousFlagged);
      showToast(mailErrorToastMessage(error, t("mail.error.updateStar"), t), "error");
    } finally {
      store.unpinFlags([message.id]);
      setMessageFlagging(false);
    }
  }, [applyBatchFlaggedChange, isDemo, messageAction, messageFlagging, selectedRemoteActionsBlocked, setMessageFlagging, showToast, store, t]);

  const quickToggleSeen = useCallback(async (message: Message) => {
    if (selectedRemoteActionsBlocked) return;
    // The seen queue allows one in-flight mutation per message; a second
    // click on the same row while the first is still pending is ignored.
    if (store.getState().pendingTargets.flagOverrides.has(message.id)) return;
    if (messageFlagging || messageAction) showToast(t("mail.action.queued"), "info");
    const nextSeen = !message.seen;
    store.pinFlags([message.id]);
    updateUnreadViewRecentlyRead(message, nextSeen);
    applyLocalSeenChange(message, nextSeen);
    try {
      if (!isDemo) await api.updateMessageFlags(message.id, { seen: nextSeen });
      showToast(nextSeen ? t("mail.action.markedRead") : t("mail.action.markedUnread"));
    } catch (error) {
      const changedMessage = { ...message, seen: nextSeen, flags: nextSeen ? [...new Set([...message.flags, "\\Seen"])] : message.flags.filter((flag) => flag !== "\\Seen") };
      updateUnreadViewRecentlyRead(changedMessage, message.seen);
      applyLocalSeenChange(changedMessage, message.seen);
      showToast(mailErrorToastMessage(error, t("mail.error.updateRead"), t), "error");
    } finally {
      store.unpinFlags([message.id]);
    }
  }, [applyLocalSeenChange, isDemo, messageAction, messageFlagging, selectedRemoteActionsBlocked, showToast, store, t, updateUnreadViewRecentlyRead]);

  const quickMoveMessage = useCallback(async (message: Message, target: MoveTarget) => {
    // The server queues a second write behind the in-flight one; surface that
    // instead of silently dropping the click.
    if (batchBusy || messageAction !== null || messageFlagging) showToast(t("mail.action.queued"), "info");
    // Keep an in-flight reload from resurrecting the row from pre-move state
    // while the optimistic apply is live.
    if (!isDemo) loadRequestRef.current += 1;
    const requestAtStart = loadRequestRef.current;
    setMessageAction(target);
    // Same hold as the reader path: without it, a refresh triggered by a
    // *different* operation finishing re-adds this row from pre-move server
    // state even though it was already removed optimistically.
    const destination = demoMoveDestination(store.getState().accounts, message.accountId, target);
    store.pinMovedAway([message.id], destination);
    try {
      if (isDemo) {
        store.applyMove([message.id], destination);
      } else {
        // Optimistic: map the row to its destination before the provider
        // round-trip; a failure restores the original row and the total.
        if (destination && destination !== message.mailbox) store.applyMove([message.id], destination);
        try {
          const result = await api.moveMessage(message.id, target);
          if (!result.ok) throw new Error(t("mail.error.move"));
          // The route already committed the destination locally, so the row is
          // settled where it is; reconcile merges the server's first page and
          // counters without replacing the loaded window, while a full `load`
          // would reset the pages and the scroll position under the user.
          void reconcile();
        } catch (error) {
          // A reload that landed mid-flight already owns the authoritative
          // total; restore the optimistic decrement only while it is still live.
          store.restoreMove(message.id, message, destination, { adjustTotal: loadRequestRef.current === requestAtStart });
          showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
          return;
        }
      }
      showToast(t(moveActionKey(target, false)));
    } catch (error) {
      void load({ silent: true });
      showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
    } finally {
      store.unpinMovedAway([message.id]);
      setMessageAction(null);
    }
  }, [batchBusy, isDemo, load, loadRequestRef, messageAction, messageFlagging, reconcile, setMessageAction, showToast, store, t]);

  // Snooze popup: the open flag, the custom datetime draft, and the popup's
  // exit transition all live here with the actions that close them.
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeCustomUntil, setSnoozeCustomUntil] = useState("");
  const { mounted: snoozeMounted, closing: snoozeClosing, beginClose: beginSnoozeClose } = usePopupExitTransition(snoozeOpen, () => setSnoozeOpen(false));
  const snoozeRef = useRef<HTMLDivElement>(null);

  const snoozeOptions = useMemo(() => [
    { key: "inOneHour", label: t("mail.snooze.inOneHour"), compute: () => new Date(Date.now() + 60 * 60_000) },
    { key: "tonight", label: t("mail.snooze.tonight"), compute: () => {
      const date = new Date();
      date.setHours(23, 0, 0, 0);
      if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
      return date;
    } },
    { key: "tomorrowMorning", label: t("mail.snooze.tomorrowMorning"), compute: () => {
      const date = new Date();
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
      return date;
    } },
    { key: "nextWeek", label: t("mail.snooze.nextWeek"), compute: () => {
      const date = new Date();
      date.setDate(date.getDate() + 7);
      date.setHours(9, 0, 0, 0);
      return date;
    } },
  ], [t]);

  useEffect(() => {
    if (!snoozeOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (snoozeRef.current?.contains(event.target as Node)) return;
      beginSnoozeClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") beginSnoozeClose();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [snoozeOpen, beginSnoozeClose]);

  // The row's snooze timestamp is local target state. The inbox counters that
  // follow from it (the Snoozed badge, the unified inbox pair) are derived from
  // that state — by the server in a real session, by the fixture in demo — so
  // this only ever shifts the row.
  const applyLocalSnooze = useCallback((messageId: string, until: string | null) => {
    store.applySnooze(messageId, until);
  }, [store]);

  const setSelectedSnoozed = async (untilIso: string) => {
    if (!selected || selectedRemoteActionsBlocked) return;
    const previousUntil = selected.snoozedUntil ?? null;
    setSnoozeOpen(false);
    setSnoozeCustomUntil("");
    // Optimistic: apply the local snooze before the provider round-trip; a
    // failure restores the previous state.
    applyLocalSnooze(selected.id, untilIso);
    try {
      if (!isDemo) await api.snoozeMessage(selected.id, untilIso);
      showToast(t("mail.snooze.scheduled"));
    } catch (error) {
      applyLocalSnooze(selected.id, previousUntil);
      showToast(mailErrorToastMessage(error, t("mail.error.snooze"), t), "error");
    }
  };

  const clearSelectedSnooze = async () => {
    if (!selected) return;
    const previousUntil = selected.snoozedUntil ?? null;
    setSnoozeOpen(false);
    // Optimistic: the row leaves the snoozed view (and the reader closes)
    // immediately; a failure restores both.
    if (viewRef.current === "snoozed") setSelectedId(null);
    applyLocalSnooze(selected.id, null);
    try {
      if (!isDemo) await api.clearMessageSnooze(selected.id);
      showToast(t("mail.snooze.cleared"));
    } catch (error) {
      applyLocalSnooze(selected.id, previousUntil);
      if (viewRef.current === "snoozed") setSelectedId(selected.id);
      showToast(mailErrorToastMessage(error, t("mail.error.snooze"), t), "error");
    }
  };

  const selectedIsSnoozed = selected ? isSnoozedMessage(selected) : false;

  return {
    snoozeOpen,
    setSnoozeOpen,
    snoozeMounted,
    snoozeClosing,
    beginSnoozeClose,
    snoozeRef,
    snoozeCustomUntil,
    setSnoozeCustomUntil,
    snoozeOptions,
    selectedIsSnoozed,
    setSelectedSnoozed,
    clearSelectedSnooze,
    quickToggleStar,
    quickToggleSeen,
    quickMoveMessage,
  };
}
