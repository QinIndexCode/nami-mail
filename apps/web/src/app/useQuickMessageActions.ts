import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type MoveTarget } from "../api";
import { usePopupExitTransition } from "../hooks/usePopupExitTransition";
import { mailErrorToastMessage } from "../errorPresentation";
import {
  applyMessageMove,
  isSnoozedMessage,
  isInboxMessage,
  matchesServerMessageQuery,
  nextMessageTotalForMove,
  revertMessageMove,
  pinFlagOverride,
  unpinFlagOverride,
  type MessageListQuery,
  type MutablePendingLocalState,
} from "../mailListState";
import { demoMoveDestination, moveActionKey } from "./app-utils";
import type { useToastQueue } from "../notifications/useToastQueue";
import type { Translate } from "../i18n";
import type { Account, Message, Stats } from "../types";

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
  accounts: Account[];
  messages: Message[];
  stats: Stats;
  filteredMessages: Message[];
  filterQuery: MessageListQuery;
  viewRef: { current: MailView };
  /** Reader-domain busy flags stay in App; quick actions just flip them. */
  messageFlagging: boolean;
  messageAction: MoveTarget | null;
  setMessageFlagging: (flagging: boolean) => void;
  setMessageAction: (action: MoveTarget | null) => void;
  batchBusy: boolean;
  applyBatchFlaggedChange: (ids: readonly string[], flagged: boolean) => void;
  pendingLocalStateRef: { current: MutablePendingLocalState };
  messagesRef: { current: Message[] };
  loadRequestRef: { current: number };
  load: (options?: QuickActionsLoadOptions) => Promise<void>;
  pinMovedAway: (ids: Iterable<string>, destination: string) => void;
  unpinMovedAway: (ids: Iterable<string>) => void;
  setMessages: (updater: Message[] | ((items: Message[]) => Message[])) => void;
  setAccounts: (updater: Account[] | ((items: Account[]) => Account[])) => void;
  setStats: (updater: Stats | ((current: Stats) => Stats)) => void;
  setMessageTotal: (updater: number | ((total: number) => number)) => void;
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
    accounts,
    messages,
    stats,
    filteredMessages,
    filterQuery,
    viewRef,
    messageFlagging,
    messageAction,
    setMessageFlagging,
    setMessageAction,
    batchBusy,
    applyBatchFlaggedChange,
    pendingLocalStateRef,
    messagesRef,
    loadRequestRef,
    load,
    pinMovedAway,
    unpinMovedAway,
    setMessages,
    setAccounts,
    setStats,
    setMessageTotal,
    applyLocalSeenChange,
    updateUnreadViewRecentlyRead,
    setSelectedId,
  } = options;

  const quickToggleStar = useCallback(async (message: Message) => {
    if (selectedRemoteActionsBlocked) return;
    if (messageFlagging || messageAction) showToast(t("mail.action.queued"), "info");
    const nextFlagged = !message.flagged;
    setMessageFlagging(true);
    pinFlagOverride(pendingLocalStateRef.current, message.id);
    applyBatchFlaggedChange([message.id], nextFlagged);
    try {
      if (!isDemo) await api.updateMessageFlags(message.id, { flagged: nextFlagged });
      showToast(nextFlagged ? t("mail.action.starred") : t("mail.action.unstarred"));
    } catch (error) {
      applyBatchFlaggedChange([message.id], message.flagged);
      showToast(mailErrorToastMessage(error, t("mail.error.updateStar"), t), "error");
    } finally {
      unpinFlagOverride(pendingLocalStateRef.current, message.id);
      setMessageFlagging(false);
    }
  }, [applyBatchFlaggedChange, isDemo, messageAction, messageFlagging, pendingLocalStateRef, selectedRemoteActionsBlocked, setMessageFlagging, showToast, t]);

  const quickToggleSeen = useCallback(async (message: Message) => {
    if (selectedRemoteActionsBlocked) return;
    // The seen queue allows one in-flight mutation per message; a second
    // click on the same row while the first is still pending is ignored.
    if (pendingLocalStateRef.current.flagOverrides.has(message.id)) return;
    if (messageFlagging || messageAction) showToast(t("mail.action.queued"), "info");
    const nextSeen = !message.seen;
    pinFlagOverride(pendingLocalStateRef.current, message.id);
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
      unpinFlagOverride(pendingLocalStateRef.current, message.id);
    }
  }, [applyLocalSeenChange, isDemo, messageAction, messageFlagging, pendingLocalStateRef, selectedRemoteActionsBlocked, showToast, t, updateUnreadViewRecentlyRead]);

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
    pinMovedAway([message.id], demoMoveDestination(accounts, message.accountId, target));
    try {
      if (isDemo) {
        const destination = demoMoveDestination(accounts, message.accountId, target);
        setMessages((items) => {
          const next = applyMessageMove(accounts, items, stats, message.id, destination).messages;
          messagesRef.current = next;
          return next;
        });
        setAccounts((items) => {
          const current = messages.find((item) => item.id === message.id);
          if (!current) return items;
          const destination2 = demoMoveDestination(items, current.accountId, target);
          return applyMessageMove(items, [current], stats, message.id, destination2).accounts;
        });
        setStats((current) => {
          const msg = messages.find((item) => item.id === message.id);
          if (!msg) return current;
          const destination3 = demoMoveDestination(accounts, msg.accountId, target);
          return applyMessageMove(accounts, [msg], current, message.id, destination3).stats;
        });
      } else {
        const destination = demoMoveDestination(accounts, message.accountId, target);
        // Optimistic: map the row to its destination before the provider
        // round-trip; a failure restores the original snapshot and counts.
        const optimisticSnapshot = destination && destination !== message.mailbox
          ? applyMessageMove(accounts, [message], stats, message.id, destination).messages[0]
          : undefined;
        const optimisticAccounts = optimisticSnapshot
          ? applyMessageMove(accounts, [message], stats, message.id, destination).accounts
          : null;
        const optimisticStats = optimisticSnapshot
          ? applyMessageMove(accounts, [message], stats, message.id, destination).stats
          : null;
        if (optimisticSnapshot) {
          const wasIncluded = filteredMessages.some((item) => item.id === message.id);
          const remainsIncluded = matchesServerMessageQuery(optimisticSnapshot, accounts, filterQuery);
          if (wasIncluded !== remainsIncluded) {
            setMessageTotal((total) => nextMessageTotalForMove(total, wasIncluded, remainsIncluded));
          }
          // Sync the ref synchronously (like load) so a fast failure can gate
          // its rollback on the exact optimistic state it must reverse.
          messagesRef.current = applyMessageMove(accounts, messagesRef.current, stats, message.id, destination).messages;
          setMessages(messagesRef.current);
          setAccounts((items) => applyMessageMove(items, [message], stats, message.id, destination).accounts);
          setStats((current) => applyMessageMove(accounts, [message], current, message.id, destination).stats);
        }
        try {
          const result = await api.moveMessage(message.id, target);
          if (!result.ok) throw new Error(t("mail.error.move"));
          void load({ silent: true });
        } catch (error) {
          if (optimisticSnapshot && optimisticAccounts && optimisticStats) {
            // A reload that landed mid-flight already holds server truth (the
            // message restored at its source); leave it alone in that case.
            if (messagesRef.current.some((item) => item.id === message.id && item.mailbox === destination)) {
              const restored = revertMessageMove(optimisticAccounts, messagesRef.current, optimisticStats, message, destination);
              messagesRef.current = restored.messages;
              setMessages(restored.messages);
              setAccounts(restored.accounts);
              setStats(restored.stats);
            }
          }
          if (loadRequestRef.current === requestAtStart && optimisticSnapshot) {
            const wasIncluded = filteredMessages.some((item) => item.id === message.id);
            const remainsIncluded = matchesServerMessageQuery(optimisticSnapshot, accounts, filterQuery);
            if (wasIncluded !== remainsIncluded) {
              setMessageTotal((total) => nextMessageTotalForMove(total, remainsIncluded, wasIncluded));
            }
          }
          showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
          return;
        }
      }
      showToast(t(moveActionKey(target, false)));
    } catch (error) {
      void load({ silent: true });
      showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
    } finally {
      unpinMovedAway([message.id]);
      setMessageAction(null);
    }
  }, [accounts, batchBusy, filteredMessages, filterQuery, isDemo, load, loadRequestRef, messageAction, messageFlagging, messages, messagesRef, pinMovedAway, setMessageAction, setMessageTotal, setMessages, setAccounts, setStats, showToast, stats, t, unpinMovedAway]);

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

  const applyLocalSnooze = useCallback((messageId: string, until: string | null, previousUntil: string | null) => {
    const wasSnoozed = Boolean(previousUntil && new Date(previousUntil).getTime() > Date.now());
    const willBeSnoozed = Boolean(until && new Date(until).getTime() > Date.now());
    const current = messagesRef.current.find((item) => item.id === messageId);
    if (!current) return;
    setMessages((items) => {
      const next = items.map((item) => item.id === messageId ? { ...item, snoozedUntil: until } : item);
      messagesRef.current = next;
      return next;
    });
    if (wasSnoozed === willBeSnoozed || !isInboxMessage(current, accounts)) return;
    // Leaving the inbox for a snooze, or returning from one, adjusts the
    // unified inbox counts exactly like an archive move.
    const isSnoozing = !wasSnoozed && willBeSnoozed;
    const unseenDelta = current.seen ? 0 : isSnoozing ? -1 : 1;
    setStats((currentStats) => ({
      ...currentStats,
      messages: Math.max(0, currentStats.messages + (isSnoozing ? -1 : 1)),
      unread: Math.max(0, currentStats.unread + unseenDelta),
    }));
  }, [accounts, messagesRef, setMessages, setStats]);

  const setSelectedSnoozed = async (untilIso: string) => {
    if (!selected || selectedRemoteActionsBlocked) return;
    const previousUntil = selected.snoozedUntil ?? null;
    setSnoozeOpen(false);
    setSnoozeCustomUntil("");
    // Optimistic: apply the local snooze before the provider round-trip; a
    // failure restores the previous state and counts.
    applyLocalSnooze(selected.id, untilIso, previousUntil);
    try {
      if (!isDemo) await api.snoozeMessage(selected.id, untilIso);
      showToast(t("mail.snooze.scheduled"));
    } catch (error) {
      applyLocalSnooze(selected.id, previousUntil, untilIso);
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
    applyLocalSnooze(selected.id, null, previousUntil);
    try {
      if (!isDemo) await api.clearMessageSnooze(selected.id);
      showToast(t("mail.snooze.cleared"));
    } catch (error) {
      applyLocalSnooze(selected.id, previousUntil, null);
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
