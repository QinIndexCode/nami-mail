import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type BatchJobCreatePayload, type BatchJobQuery, type BatchJobSnapshot, type MoveTarget } from "../api";
import { createBatchJobRunner, type BatchJobRunOptions } from "../batchJobRunner";
import { beginSpan } from "../perfTelemetry";
import { useDismissTransition } from "../hooks/useDismissTransition";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { mailErrorToastMessage } from "../errorPresentation";
import {
  applyBatchSeenChange as applyBatchSeenChangeState,
  mergeRolledBackMessages,
  applyMessageMove,
  pinFlagOverride,
  unpinFlagOverride,
  type MessageListQuery,
  type MessageListSortOrder,
  type MutablePendingLocalState,
} from "../mailListState";
import { demoMoveDestination, moveActionKey } from "./app-utils";
import type { useToastQueue } from "../notifications/useToastQueue";
import type { Translate } from "../i18n";
import type { AttachmentKind } from "../attachmentPresentation";
import type { Account, Message, Stats } from "../types";

type ShowToast = ReturnType<typeof useToastQueue>["showToast"];
type MailView = MessageListQuery["messageView"];

export interface BatchSelectionLoadOptions {
  silent?: boolean;
}

export interface BatchSelectionOptions {
  isDemo: boolean;
  t: Translate;
  showToast: ShowToast;
  sortOrder: MessageListSortOrder;
  filteredMessages: Message[];
  messages: Message[];
  accounts: Account[];
  stats: Stats;
  loadedServerMessageCount: number;
  currentMessageTotal: number;
  searchScope: "view" | "all";
  debouncedQuery: string;
  selectedAccount: string;
  selectedFolder: string;
  view: MailView;
  attachmentKindFilter: AttachmentKind | undefined;
  dateBounds: { after: string | undefined; before: string | undefined };
  /** List load; awaited as the reconciliation barrier after a batch lands. */
  load: (options?: BatchSelectionLoadOptions) => Promise<void>;
  /** Latest `load`, read through a ref so a running job reloads the list on screen. */
  loadRef: { current: (options?: BatchSelectionLoadOptions) => Promise<void> };
  /** Monotonic epoch of list loads; bumped to invalidate in-flight refreshes. */
  loadRequestRef: { current: number };
  messagesRef: { current: Message[] };
  pendingLocalStateRef: { current: MutablePendingLocalState };
  /** Live view, read through a ref for the unread-view badge correction. */
  viewRef: { current: MailView };
  /**
   * Predicate-wide selection and the batch banner state live in App because
   * `load` (declared earlier) resets both on every full switch.
   */
  selectAllPaged: boolean;
  setSelectAllPaged: (value: boolean) => void;
  setBatchJob: (job: BatchJobSnapshot | null) => void;
  /** Delete-confirmation dialog flag lives in App ahead of useDialogRouting. */
  pendingBatchDelete: boolean;
  setPendingBatchDelete: (value: boolean) => void;
  pinMovedAway: (ids: Iterable<string>, destination: string) => void;
  unpinMovedAway: (ids: Iterable<string>) => void;
  setMessages: (updater: Message[] | ((items: Message[]) => Message[])) => void;
  setAccounts: (updater: Account[] | ((items: Account[]) => Account[])) => void;
  setStats: (updater: Stats | ((current: Stats) => Stats)) => void;
  setMessageTotal: (updater: number | ((total: number) => number)) => void;
}

export interface BatchSelection {
  selectionMode: boolean;
  selectedMessageIds: ReadonlySet<string>;
  batchBusy: boolean;
  batchDeleteConfirmClosing: boolean;
  requestBatchDeleteConfirmClose: () => void;
  resetBatchDeleteConfirmClosing: () => void;
  batchDeleteDialogRef: { current: HTMLElement | null };
  toggleSelectionMode: () => void;
  toggleMessageSelected: (id: string) => void;
  selectMessageRange: (ids: string[]) => void;
  selectAllVisibleMessages: () => void;
  exitSelectionMode: () => void;
  applyBatchFlaggedChange: (ids: readonly string[], flagged: boolean) => void;
  batchUpdateFlags: (patch: { seen?: boolean; flagged?: boolean }, successKey: string) => Promise<void>;
  batchMoveMessages: (target: MoveTarget) => Promise<void>;
}

export function useBatchSelection(options: BatchSelectionOptions): BatchSelection {
  const {
    isDemo,
    t,
    showToast,
    sortOrder,
    filteredMessages,
    messages,
    accounts,
    stats,
    loadedServerMessageCount,
    currentMessageTotal,
    searchScope,
    debouncedQuery,
    selectedAccount,
    selectedFolder,
    view,
    attachmentKindFilter,
    dateBounds,
    load,
    loadRef,
    loadRequestRef,
    messagesRef,
    pendingLocalStateRef,
    viewRef,
    selectAllPaged,
    setSelectAllPaged,
    setBatchJob,
    pendingBatchDelete,
    setPendingBatchDelete,
    pinMovedAway,
    unpinMovedAway,
    setMessages,
    setAccounts,
    setStats,
    setMessageTotal,
  } = options;

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const { closing: batchDeleteConfirmClosing, requestClose: requestBatchDeleteConfirmClose, reset: resetBatchDeleteConfirmClosing } = useDismissTransition(
    useCallback(() => setPendingBatchDelete(false), [setPendingBatchDelete]),
  );
  const batchDeleteDialogRef = useRef<HTMLElement | null>(null);
  useDialogFocus(pendingBatchDelete, batchDeleteDialogRef);

  useEffect(() => {
    if (!pendingBatchDelete) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!batchBusy) requestBatchDeleteConfirmClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [batchBusy, pendingBatchDelete, requestBatchDeleteConfirmClose]);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((current) => {
      const next = !current;
      if (!next) setSelectedMessageIds(new Set());
      return next;
    });
  }, []);

  const toggleMessageSelected = useCallback((id: string) => {
    // Any manual toggle (Ctrl/Shift click included) enters selection mode and
    // exits a predicate-wide selection back to explicit ids.
    setSelectionMode(true);
    setSelectAllPaged(false);
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [setSelectAllPaged]);

  const selectMessageRange = useCallback((ids: string[]) => {
    // Shift+click range: merge the whole span into the selection. Re-entering
    // selection mode is a no-op when it is already active.
    setSelectionMode(true);
    setSelectAllPaged(false);
    setSelectedMessageIds((current) => {
      if (ids.every((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });
  }, [setSelectAllPaged]);

  const selectAllVisibleMessages = useCallback(() => {
    setSelectedMessageIds(new Set(filteredMessages.map((message) => message.id)));
    // Gmail-style two-step select-all: once every loaded row is selected and
    // more matches exist on the server, the next click upgrades to the whole
    // matching view (handled server-side as a batch job).
    if (!isDemo && loadedServerMessageCount < currentMessageTotal) setSelectAllPaged(true);
  }, [currentMessageTotal, filteredMessages, isDemo, loadedServerMessageCount, setSelectAllPaged]);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
    setSelectAllPaged(false);
    setBatchJob(null);
    setPendingBatchDelete(false);
  }, [setBatchJob, setPendingBatchDelete, setSelectAllPaged]);

  // The current view expressed as a server-side filter scope for predicate
  // batch operations. Mirrors buildMessageQuery so the job touches exactly
  // what the list shows.
  const selectionJobQuery = useMemo<BatchJobQuery | null>(() => {
    if (!selectAllPaged || isDemo) return null;
    if (searchScope === "all" && debouncedQuery.trim()) {
      // Global search selection: no account/folder/view restriction, the
      // server matches the same FTS candidate set the list shows. Kind and
      // date refinements still narrow the selection like the visible list.
      return {
        q: debouncedQuery.trim(),
        scope: "all",
        attachmentKind: attachmentKindFilter,
        after: dateBounds.after,
        before: dateBounds.before,
      };
    }
    return {
      accountId: selectedAccount === "all" ? undefined : selectedAccount,
      folder: selectedFolder || undefined,
      q: debouncedQuery || undefined,
      unread: view === "unread" ? true : undefined,
      archived: view === "archived" ? true : undefined,
      starred: view === "starred" ? true : undefined,
      snoozed: view === "snoozed" ? true : undefined,
      hasAttachments: view === "attachments" ? true : undefined,
      attachmentKind: attachmentKindFilter,
      after: dateBounds.after,
      before: dateBounds.before,
    };
  }, [attachmentKindFilter, dateBounds, debouncedQuery, isDemo, searchScope, selectAllPaged, selectedAccount, selectedFolder, view]);

  // Batch job state machine lives in batchJobRunner.ts (unit-tested there);
  // the caller wires the React-side callbacks: snapshot/busy state, toasts,
  // reload.
  const batchJobRunner = useMemo(() => createBatchJobRunner({
    showToast,
    t,
    reload: (opts) => loadRef.current(opts),
    exitSelectionMode,
    onSnapshot: setBatchJob,
    onBusy: setBatchBusy,
  }), [exitSelectionMode, loadRef, setBatchJob, showToast, t]);

  const startBatchJob = useCallback((payload: BatchJobCreatePayload, opts: BatchJobRunOptions) => {
    batchJobRunner.start(payload, opts);
  }, [batchJobRunner]);

  const applyBatchSeenChange = useCallback((ids: readonly string[], seen: boolean) => {
    const result = applyBatchSeenChangeState(accounts, messages, stats, ids, seen);
    messagesRef.current = result.messages;
    setMessages(result.messages);
    setAccounts(result.accounts);
    setStats(result.stats);
    if (viewRef.current === "unread" && result.changedCount) {
      setMessageTotal((total) => Math.max(0, total + (seen ? -result.changedCount : result.changedCount)));
    }
  }, [accounts, messages, messagesRef, setAccounts, setMessageTotal, setMessages, setStats, stats, viewRef]);

  const applyBatchFlaggedChange = useCallback((ids: readonly string[], flagged: boolean) => {
    setMessages((items) => {
      const selected = new Set(ids);
      const next = items.map((item) => {
        if (!selected.has(item.id) || item.flagged === flagged) return item;
        const flags = new Set(item.flags);
        if (flagged) flags.add("\\Flagged");
        else flags.delete("\\Flagged");
        return { ...item, flagged, flags: [...flags] };
      });
      messagesRef.current = next;
      return next;
    });
  }, [messagesRef, setMessages]);

  const batchUpdateFlags = async (patch: { seen?: boolean; flagged?: boolean }, successKey: string) => {
    const ids = [...selectedMessageIds];
    if ((!ids.length && !selectAllPaged) || !Object.keys(patch).length) return;
    if (batchBusy) showToast(t("mail.action.queued"), "info");
    // Every path applies the patch optimistically to the loaded rows: the user
    // must see the effect (and not re-trigger it) while the server catches up.
    // The optimistic state is pinned so refreshes racing the server commit
    // cannot flip the rows back mid-batch.
    const affectedIds = selectionJobQuery ? filteredMessages.map((message) => message.id) : ids;
    if (!affectedIds.length && !selectionJobQuery) return;
    const pin = (list: readonly string[]) => {
      for (const id of list) pinFlagOverride(pendingLocalStateRef.current, id);
    };
    const unpin = (list: readonly string[]) => {
      for (const id of list) unpinFlagOverride(pendingLocalStateRef.current, id);
    };
    // Predicate scope: the server resolves every matching id behind a job (the
    // local list only holds a page of them).
    if (selectionJobQuery) {
      pin(affectedIds);
      if (patch.seen !== undefined) applyBatchSeenChange(affectedIds, patch.seen);
      if (patch.flagged !== undefined) applyBatchFlaggedChange(affectedIds, patch.flagged);
      startBatchJob({ kind: "flags", patch, query: selectionJobQuery }, {
        successKey,
        // The action is done, so the selection has no further purpose; leaving
        // it armed means the next click on any row fires another batch.
        exitOnSuccess: true,
        onSettled: () => unpin(affectedIds),
      });
      return;
    }
    setBatchBusy(true);
    pin(ids);
    // Telemetry: the optimistic apply runs on the main thread for every
    // selected row and the chunk loop paces server work — both are the
    // suspected jank sources of a bulk operation, before and after it lands.
    const finishApply = beginSpan("batch.apply-optimistic");
    if (patch.seen !== undefined) applyBatchSeenChange(ids, patch.seen);
    if (patch.flagged !== undefined) applyBatchFlaggedChange(ids, patch.flagged);
    finishApply({ count: ids.length });
    const finishBatch = beginSpan("batch.flags");
    // Cleared on any failure so a selection the user may want to retry stays
    // armed; a completed action drops it below.
    let applied = true;
    try {
      if (!isDemo) {
        // One request = one local commit = milliseconds. The IMAP STORE is
        // pushed server-side by the durable write-behind queue, so the
        // response never queues behind a running sync or batch.
        const result = await api.batchUpdateMessageFlags(ids, patch);
        if (result.failed) {
          applied = false;
          // The rows the server refused never got their optimistic flags. Drop
          // their pins *before* the reconciling reload so it restores the
          // server's truth for them instead of re-applying the optimistic value.
          unpin((result.failures ?? []).map((failure) => failure.id));
          showToast(t("mail.selection.partialFailure", { done: result.updated, failed: result.failed }), "error");
        }
      }
      showToast(t(successKey, { count: ids.length }));
    } catch (error) {
      // The server owns the authoritative flags; reload to restore truth.
      applied = false;
      showToast(mailErrorToastMessage(error, t("mail.error.batchUpdate"), t), "error");
    } finally {
      finishBatch({ count: ids.length });
      // The reconciling reload doubles as the pin barrier: it bumps the load
      // epoch (discarding any in-flight stale refresh) and lands a server
      // snapshot taken after the local commit. Only then may pins drop.
      try {
        await load({ silent: true });
      } catch {
        // load handles its own errors; pins still clear below.
      }
      unpin(ids);
      // The action landed and the list is reconciled, so the selection is spent:
      // drop it (and leave multi-select) rather than leaving rows armed for an
      // accidental second batch. A failed action keeps the selection so the user
      // can retry it.
      if (applied) exitSelectionMode();
      setBatchBusy(false);
    }
  };

  const batchMoveMessages = async (target: MoveTarget) => {
    const ids = [...selectedMessageIds];
    if (!ids.length && !selectAllPaged) return;
    if (batchBusy) showToast(t("mail.action.queued"), "info");
    // Predicate scope: server moves every matching id behind a job.
    if (selectionJobQuery) {
      startBatchJob({ kind: "move", target, query: selectionJobQuery }, { successKey: moveActionKey(target, true), exitOnSuccess: true });
      return;
    }
    setBatchBusy(true);
    // The selection leaves the list and the toolbar immediately; failures are
    // rolled back (re-inserted and re-selected) once the server responds.
    exitSelectionMode();
    // Set when the inner settle throws so the success toast below cannot
    // overwrite the error toast on the shared toast slot.
    let settleFailed = false;
    try {
      if (isDemo) {
        setMessages((items) => {
          let next = items;
          for (const id of ids) {
            const current = next.find((item) => item.id === id);
            if (!current) continue;
            const destination = demoMoveDestination(accounts, current.accountId, target);
            next = applyMessageMove(accounts, next, stats, id, destination).messages;
          }
          messagesRef.current = next;
          return next;
        });
        setAccounts((items) => {
          let next = items;
          for (const id of ids) {
            const current = messages.find((item) => item.id === id);
            if (!current) continue;
            const destination = demoMoveDestination(accounts, current.accountId, target);
            next = applyMessageMove(next, [current], stats, id, destination).accounts;
          }
          return next;
        });
        setStats((current) => {
          let next = current;
          for (const id of ids) {
            const msg = messages.find((item) => item.id === id);
            if (!msg) continue;
            const destination = demoMoveDestination(accounts, msg.accountId, target);
            next = applyMessageMove(accounts, [msg], next, id, destination).stats;
          }
          return next;
        });
      } else {
        // Optimistic: drop the selection from the list immediately; whatever
        // the server cannot move is rolled back into the list at its sorted
        // position, re-selected, and explained in the toast.
        const selectedSet = new Set(ids);
        const snapshots = messagesRef.current.filter((item) => selectedSet.has(item.id));
        const snapshotById = new Map<string, Message>(snapshots.map((item) => [item.id, item]));
        const inViewById = new Map<string, boolean>(ids.map((id) => [id, filteredMessages.some((item) => item.id === id)]));
        const inViewCount = ids.reduce((count, id) => count + (inViewById.get(id) ? 1 : 0), 0);
        // Invalidate any in-flight reload so it cannot resurrect the removed
        // rows from pre-move server state.
        loadRequestRef.current += 1;
        const requestAtStart = loadRequestRef.current;
        messagesRef.current = messagesRef.current.filter((item) => !selectedSet.has(item.id));
        setMessages(messagesRef.current);
        // The epoch bump only discards requests that were already in flight.
        // Hold the rows out of every snapshot that starts afterwards too — a
        // reload triggered by another operation finishing, or a poll tick —
        // until the server reports them at the destination.
        for (const id of ids) {
          const snapshot = snapshotById.get(id);
          if (snapshot) pinMovedAway([id], demoMoveDestination(accounts, snapshot.accountId, target));
        }
        if (inViewCount) setMessageTotal((total) => Math.max(0, total - inViewCount));

        const rollback = (failedIds: ReadonlySet<string>) => {
          const failed = ids
            .filter((id) => failedIds.has(id))
            .map((id) => snapshotById.get(id))
            .filter((message): message is Message => Boolean(message));
          if (failed.length) {
            setMessages((items) => {
              const next = mergeRolledBackMessages(items, failed, sortOrder);
              messagesRef.current = next;
              return next;
            });
          }
          // A reload that landed mid-flight already owns the authoritative
          // total (which still includes the failed messages); only restore
          // the optimistic decrement when it is still the live value.
          if (loadRequestRef.current === requestAtStart) {
            const restoredInView = ids.reduce((count, id) => count + (failedIds.has(id) && inViewById.get(id) ? 1 : 0), 0);
            if (restoredInView) setMessageTotal((total) => total + restoredInView);
          }
          if (failed.length) {
            setSelectionMode(true);
            setSelectedMessageIds(new Set(failedIds));
          }
        };

        // The server caps a single batch at 100 ids; split large selections
        // into chunks exactly like batchUpdateFlags so moves never fail with
        // a 400 for size alone. The counters live outside the try so the
        // catch can distinguish processed chunks from unprocessed ones.
        const CHUNK_SIZE = 100;
        let updated = 0;
        let failed = 0;
        let processed = 0;
        const failedIds = new Set<string>();
        const failureReasons: string[] = [];
        try {
          for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
            const chunk = ids.slice(offset, offset + CHUNK_SIZE);
            const result = await api.batchMoveMessages(chunk, target);
            updated += result.updated;
            failed += result.failed;
            for (const failure of result.failures ?? []) {
              failedIds.add(failure.id);
              if (failureReasons.length < 1 && failure.message) failureReasons.push(failure.message);
            }
            processed += chunk.length;
          }
          if (failedIds.size) {
            rollback(failedIds);
            const detail = failureReasons[0] ? ` — ${failureReasons[0]}` : "";
            showToast(`${t("mail.selection.partialFailure", { done: updated, failed })}${detail}`, "error");
            return;
          }
          // The list already reflects the move; reload to reconcile the
          // server-side truth (mapped UIDs, folder counts). Await it: the pins
          // are released in the `finally` below, and dropping them before this
          // snapshot lands would let an older in-flight refresh re-add the rows
          // — the same barrier order batchUpdateFlags uses.
          await load({ silent: true });
        } catch (error) {
          // A mid-stream failure leaves earlier chunks moved server-side; roll
          // back only the unprocessed remainder plus any recorded failures,
          // then let a reload settle the rest. Same pin barrier as above.
          settleFailed = true;
          const unreconciled = new Set(ids.slice(processed));
          for (const id of failedIds) unreconciled.add(id);
          rollback(unreconciled);
          await load({ silent: true });
          showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
        }
      }
      if (!settleFailed) showToast(t(moveActionKey(target, true), { count: ids.length }));
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
    } finally {
      unpinMovedAway(ids);
      setBatchBusy(false);
    }
  };

  return {
    selectionMode,
    selectedMessageIds,
    batchBusy,
    batchDeleteConfirmClosing,
    requestBatchDeleteConfirmClose,
    resetBatchDeleteConfirmClosing,
    batchDeleteDialogRef,
    toggleSelectionMode,
    toggleMessageSelected,
    selectMessageRange,
    selectAllVisibleMessages,
    exitSelectionMode,
    applyBatchFlaggedChange,
    batchUpdateFlags,
    batchMoveMessages,
  };
}
