import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type BatchJobCreatePayload, type BatchJobQuery, type MoveTarget } from "../api";
import { createBatchJobRunner, type BatchJobRunOptions } from "../batchJobRunner";
import { beginSpan } from "../perfTelemetry";
import { useDismissTransition } from "../hooks/useDismissTransition";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { mailErrorToastMessage } from "../errorPresentation";
import {
  type MessageListQuery,
  type MessageListSortOrder,
} from "../mailListState";
import { demoMoveDestination, moveActionKey } from "./app-utils";
import type { MailStore } from "./mailStore";
import type { useToastQueue } from "../notifications/useToastQueue";
import type { Translate } from "../i18n";
import type { AttachmentKind } from "../attachmentPresentation";
import type { Message } from "../types";

type ShowToast = ReturnType<typeof useToastQueue>["showToast"];
type MailView = MessageListQuery["messageView"];

/**
 * The most ids one batch request may carry. The server's `batchMessageIdsSchema`
 * rejects anything longer outright (apps/server/src/schemas.ts), so the renderer
 * splits an explicit selection at this boundary instead of sending a request
 * that is refused as invalid.
 *
 * Deliberately not 100: one request is one local commit and one account-write-slot
 * acquisition, and paying that per hundred messages is what made a large
 * selection wait behind a running sync. A selection that fits stays one request.
 */
const SERVER_BATCH_ID_LIMIT = 5000;

export interface BatchSelectionLoadOptions {
  silent?: boolean;
}

export interface BatchSelectionOptions {
  isDemo: boolean;
  t: Translate;
  showToast: ShowToast;
  sortOrder: MessageListSortOrder;
  filteredMessages: Message[];
  store: MailStore;
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
  /**
   * The pagination-preserving silent refresh, read through a ref so a running
   * job reconciles against the list on screen without rebuilding the runner
   * (which would abandon its poll loop) every time the view changes.
   */
  reconcileRef: { current: () => Promise<void> | void };
  /** Monotonic epoch of list loads; bumped to invalidate in-flight refreshes. */
  loadRequestRef: { current: number };
  /**
   * Predicate-wide selection and the batch banner state live in App because
   * `load` (declared earlier) resets both on every full switch.
   */
  selectAllPaged: boolean;
  setSelectAllPaged: (value: boolean) => void;
  /** Delete-confirmation dialog flag lives in App ahead of useDialogRouting. */
  pendingBatchDelete: boolean;
  setPendingBatchDelete: (value: boolean) => void;
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
  /**
   * A full list load replaces the view wholesale (folder/account switch, a
   * sync, an account being added). The predicate-wide selection was scoped to
   * the view that just went away, so it goes with it.
   *
   * A batch's own state deliberately does NOT go with it: a delivery does not
   * stop when the list reloads, and the runner owns its deadlines and pins. The
   * only thing a full load used to disturb was the snapshot that kept the bar's
   * actions inert, which the commit-first rule removed (contract §二十六) — the
   * create round trip is what guards against a second batch now, and it is over
   * long before a load could land inside it.
   */
  resetSelectionOnFullLoad: () => void;
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
    store,
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
    reconcileRef,
    loadRequestRef,
    selectAllPaged,
    setSelectAllPaged,
    pendingBatchDelete,
    setPendingBatchDelete,
  } = options;

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  // Monotonic batch identity. Overlapping batches are legitimate; completion
  // handling compares against this so only the newest one retires shared state.
  const batchOperationRef = useRef(0);
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
    setPendingBatchDelete(false);
  }, [setPendingBatchDelete, setSelectAllPaged]);

  const resetSelectionOnFullLoad = useCallback(() => {
    // The predicate selection was scoped to the view that is being replaced.
    setSelectAllPaged(false);
  }, [setSelectAllPaged]);

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

  /**
   * Releases the destination pins of a batch's move. The runner calls it when the
   * batch's delivery ends, which is the last moment that is still BEFORE its
   * reconciling reload: the reload is what brings the rows the server refused
   * back into the list, and a pin still holding them would hide exactly the
   * messages a partial-failure toast is about. Clearing them in `onSettled`
   * instead would be one reload too late.
   *
   * The local commit is not what ends a batch any more (contract §二十六) — it is
   * what ends the user's wait, and the pins deliberately outlive it: the rows a
   * refused push leaves behind must not be held against the refresh that reports
   * them.
   */
  const releaseMovePinsRef = useRef<(() => void) | null>(null);
  const handleDeliverySettled = useCallback(() => {
    releaseMovePinsRef.current?.();
    releaseMovePinsRef.current = null;
  }, []);

  // Batch job state machine lives in batchJobRunner.ts (unit-tested there);
  // the caller wires the React-side callbacks: busy state, toasts, reload, the
  // acceptance-time reconcile and the delivery release.
  const batchJobRunner = useMemo(() => createBatchJobRunner({
    showToast,
    t,
    reload: (opts) => loadRef.current(opts),
    reconcile: () => reconcileRef.current(),
    exitSelectionMode,
    onDeliverySettled: handleDeliverySettled,
    onBusy: setBatchBusy,
  }), [exitSelectionMode, handleDeliverySettled, loadRef, reconcileRef, showToast, t]);

  const startBatchJob = useCallback((payload: BatchJobCreatePayload, opts: BatchJobRunOptions) => {
    batchJobRunner.start(payload, opts);
  }, [batchJobRunner]);

  const applyBatchSeenChange = useCallback((ids: readonly string[], seen: boolean) => {
    store.applySeen(ids, seen);
  }, [store]);

  const applyBatchFlaggedChange = useCallback((ids: readonly string[], flagged: boolean) => {
    store.applyFlag(ids, flagged);
  }, [store]);

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
    // Pins are counted holders, and this operation is ONE holder per id: it
    // releases exactly what it took, exactly once. Releasing twice would drop
    // the holder of an overlapping batch that is still in flight.
    const held = new Set<string>();
    const pin = (list: readonly string[]) => {
      for (const id of list) {
        store.pinFlags([id]);
        held.add(id);
      }
    };
    const unpin = (list: readonly string[]) => {
      for (const id of list) {
        if (!held.delete(id)) continue;
        store.unpinFlags([id]);
      }
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
    // Every batch carries its own identity. Overlapping batches are possible —
    // the toolbar stays interactive while a request is in flight — so a batch
    // that finishes must only report ITS work as done: an older completion may
    // neither clear the busy flag nor drop the selection a newer action owns.
    const operationId = ++batchOperationRef.current;
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
        // response never queues behind a running sync or batch. Only the
        // request size is bounded, so a selection past the cap is split into
        // requests of exactly the cap: a flag commit is local work with no
        // per-command failure to bound, so there is nothing to gain from
        // chunking it any finer than the server's own limit.
        let updated = 0;
        let failed = 0;
        const failedIds: string[] = [];
        for (let offset = 0; offset < ids.length; offset += SERVER_BATCH_ID_LIMIT) {
          const result = await api.batchUpdateMessageFlags(ids.slice(offset, offset + SERVER_BATCH_ID_LIMIT), patch);
          updated += result.updated;
          failed += result.failed;
          for (const failure of result.failures ?? []) failedIds.push(failure.id);
        }
        if (failed) {
          applied = false;
          // Drop the pins *before* the reconciling reload so it restores the
          // server's truth for the refused rows instead of re-applying the
          // optimistic value. The server reports per-id failures when it can;
          // when it does not, no row may keep an unconfirmed value, so every
          // pin of this batch drops and the reload settles all of them.
          unpin(failedIds.length ? failedIds : ids);
          showToast(t("mail.selection.partialFailure", { done: updated, failed }), "error");
        }
      }
      // A partial failure already reported itself; claiming success on top of
      // it would be the last word the user sees.
      if (applied) showToast(t(successKey, { count: ids.length }));
    } catch (error) {
      // The server owns the authoritative flags; reload to restore truth.
      applied = false;
      showToast(mailErrorToastMessage(error, t("mail.error.batchUpdate"), t), "error");
    } finally {
      finishBatch({ count: ids.length });
      // The reconciling reload doubles as the pin barrier, but which side of it
      // the pins drop on depends on whether the write landed. On success they
      // must outlive the reload: an in-flight refresh that started before the
      // local commit would otherwise land after it and flip the rows back. On
      // failure there is no commit to protect, and pins that outlive the reload
      // would pin the optimistic value over the server's authoritative one —
      // the rejected write would look like it succeeded.
      if (!applied) unpin(ids);
      try {
        await load({ silent: true });
      } catch {
        // load handles its own errors; the pins still clear below.
      }
      unpin(ids);
      // The action landed and the list is reconciled, so the selection is spent:
      // drop it (and leave multi-select) rather than leaving rows armed for an
      // accidental second batch. A failed action keeps the selection so the user
      // can retry it. Both wait for the newest batch: an older one finishing
      // must not retire a selection its successor is still using.
      if (batchOperationRef.current === operationId) {
        if (applied) exitSelectionMode();
        setBatchBusy(false);
      }
    }
  };

  const batchMoveMessages = async (target: MoveTarget) => {
    const ids = [...selectedMessageIds];
    if (!ids.length && !selectAllPaged) return;
    if (batchBusy) showToast(t("mail.action.queued"), "info");
    // Predicate scope: the server moves every matching id behind a job, and —
    // like the flag path above — its acceptance commits locally, so the rows on
    // screen leave now instead of when IMAP confirms. The pending destination IS
    // the destination as far as every reader is concerned: the job row records
    // the goal for the whole selection (not just the page the renderer holds) in
    // one transaction, so a message is out of this view from the moment the
    // create resolves.
    if (selectionJobQuery) {
      const movedIds = filteredMessages.map((message) => message.id);
      // Invalidate any in-flight reload so it cannot resurrect the removed rows
      // from pre-acceptance server state, and hold them out of every snapshot
      // that starts afterwards too — a background refresh or a poll tick lands
      // between this click and the acceptance.
      loadRequestRef.current += 1;
      for (const message of filteredMessages) {
        store.pinMovedAway([message.id], demoMoveDestination(store.getState().accounts, message.accountId, target));
      }
      store.removeMessages(movedIds);
      // A pin may outlive the acceptance and the local commit, never the
      // delivery: the messages the server gave back are reported in the source
      // folder again, and a pin still holding them would hide exactly the rows a
      // partial-failure toast tells the user to look for. Both hooks below
      // release, and both are needed — the delivery release fires before the
      // job's reconciling reload (the one that must see the restored rows), while
      // `onSettled` is the backstop for the paths that end without one.
      releaseMovePinsRef.current = () => store.unpinMovedAway(movedIds);
      startBatchJob({ kind: "move", target, query: selectionJobQuery }, {
        successKey: moveActionKey(target, true),
        exitOnSuccess: true,
        onSettled: () => store.unpinMovedAway(movedIds),
      });
      return;
    }
    setBatchBusy(true);
    const operationId = ++batchOperationRef.current;
    // The selection leaves the list and the toolbar immediately; failures are
    // rolled back (re-inserted and re-selected) once the server responds.
    exitSelectionMode();
    // Set when the inner settle throws so the success toast below cannot
    // overwrite the error toast on the shared toast slot.
    let settleFailed = false;
    try {
      if (isDemo) {
        for (const id of ids) {
          const current = store.getMessages().find((item) => item.id === id);
          if (!current) continue;
          const destination = demoMoveDestination(store.getState().accounts, current.accountId, target);
          store.applyMove([id], destination);
        }
      } else {
        // Optimistic: drop the selection from the list immediately; whatever
        // the server cannot move is rolled back into the list at its sorted
        // position, re-selected, and explained in the toast.
        const selectedSet = new Set(ids);
        const snapshots = store.getMessages().filter((item) => selectedSet.has(item.id));
        const snapshotById = new Map<string, Message>(snapshots.map((item) => [item.id, item]));
        // Invalidate any in-flight reload so it cannot resurrect the removed
        // rows from pre-move server state.
        loadRequestRef.current += 1;
        const requestAtStart = loadRequestRef.current;
        const currentAccounts = store.getState().accounts;
        store.removeMessages(ids);
        // The epoch bump only discards requests that were already in flight.
        // Hold the rows out of every snapshot that starts afterwards too — a
        // reload triggered by another operation finishing, or a poll tick —
        // until the server reports them at the destination.
        for (const id of ids) {
          const snapshot = snapshotById.get(id);
          if (snapshot) store.pinMovedAway([id], demoMoveDestination(currentAccounts, snapshot.accountId, target));
        }

        const rollback = (failedIds: ReadonlySet<string>) => {
          const failed = ids
            .filter((id) => failedIds.has(id))
            .map((id) => snapshotById.get(id))
            .filter((message): message is Message => Boolean(message));
          if (failed.length) {
            // A reload that landed mid-flight already owns the authoritative
            // total (which still includes the failed messages); only restore
            // the optimistic decrement when it is still the live value.
            store.restoreMessages(failed, sortOrder, { adjustTotal: loadRequestRef.current === requestAtStart });
          }
          if (failed.length) {
            // Re-arming the failed rows is this batch's own business: an older
            // move must not take the selection away from a batch the user
            // started afterwards, which is why this is the one state write the
            // liveness check gates.
            if (batchOperationRef.current === operationId) {
              setSelectionMode(true);
              setSelectedMessageIds(new Set(failedIds));
            }
          }
        };

        // The server accepts up to SERVER_BATCH_ID_LIMIT ids per request, but a
        // move is split far below that on purpose. A flag commit is local
        // bookkeeping; a move is a real MOVE per (account, mailbox) group, each
        // one taking the account's write lock, so the chunk size is what decides
        // how many messages a refused or lost command can strand at once and how
        // long those locks are held (a group that fails falls back to
        // per-message moves, which strands less still). The counters live outside
        // the try so the catch can distinguish processed chunks from unprocessed
        // ones.
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
          // Release the destination pins for the rows going back into the list
          // BEFORE the reconciling reload: a pinned id is dropped from any
          // snapshot that still reports it at the old mailbox, so reloading
          // first would re-remove the very rows this rollback restored.
          store.unpinMovedAway([...unreconciled]);
          await load({ silent: true });
          showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
        }
      }
      if (!settleFailed) showToast(t(moveActionKey(target, true), { count: ids.length }));
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.move"), t), "error");
    } finally {
      store.unpinMovedAway(ids);
      // Only the newest batch retires the busy flag; an older move finishing
      // must not report a newer action as done.
      if (batchOperationRef.current === operationId) setBatchBusy(false);
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
    resetSelectionOnFullLoad,
    applyBatchFlaggedChange,
    batchUpdateFlags,
    batchMoveMessages,
  };
}
