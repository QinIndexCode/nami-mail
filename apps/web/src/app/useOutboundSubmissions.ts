import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { ensureDemoLoaded } from "../demo-loader";
import { mailErrorToastMessage } from "../errorPresentation";
import { mergeSubmissionSnapshots, sortSubmissions, submissionStatusNeedsRefresh } from "../sendingStatus";
import type { useToastQueue } from "../notifications/useToastQueue";
import type { Translate } from "../i18n";
import type { Account, OutboundSubmission } from "../types";

type ShowToast = ReturnType<typeof useToastQueue>["showToast"];

export interface OutboundSubmissionsOptions {
  isDemo: boolean;
  locale: string;
  t: Translate;
  showToast: ShowToast;
  accounts: Account[];
}

export interface OutboundSubmissions {
  submissions: OutboundSubmission[];
  submissionLoading: boolean;
  submissionLoadError: string | null;
  submissionAttentionCount: number;
  submissionOutstandingCount: number;
  refreshSubmissions: (targetAccounts: Account[], options?: { silent?: boolean }) => Promise<void>;
  cancelScheduledSubmission: (submissionId: string) => Promise<void>;
  /** Seed demo submissions; `markReady` also clears the loading/error flags (initial load path). */
  applyDemoSubmissions: (items: OutboundSubmission[], markReady?: boolean) => void;
  /** Mark the pipeline as failed with a preformatted message (list load catch path). */
  reportLoadFailure: (message: string) => void;
}

export function useOutboundSubmissions({ isDemo, locale, t, showToast, accounts }: OutboundSubmissionsOptions): OutboundSubmissions {
  const [submissions, setSubmissions] = useState<OutboundSubmission[]>([]);
  const [submissionLoading, setSubmissionLoading] = useState(true);
  const [submissionLoadError, setSubmissionLoadError] = useState<string | null>(null);
  const submissionLoadRequestRef = useRef(0);
  const cancelledSubmissionIdsRef = useRef(new Set<string>());
  // The polling effect reads accounts through a ref on purpose: a refresh swaps
  // the array identity on every list load, which would restart the effect
  // (resetting the timer and the attempt budget) before the first poll fired.
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const cancelScheduledSubmission = useCallback(async (submissionId: string) => {
    // Two guards, because the server's own list can lag the cancel by a moment:
    // invalidate any list refresh already in flight (it was fetched before the
    // cancellation), and remember the id so a snapshot that still reports it
    // cannot re-add the row. The registration clears itself once every account
    // answers without it (see refreshSubmissions).
    submissionLoadRequestRef.current += 1;
    cancelledSubmissionIdsRef.current.add(submissionId);
    const forget = () => cancelledSubmissionIdsRef.current.delete(submissionId);
    if (isDemo) {
      setSubmissions((current) => current.filter((item) => item.id !== submissionId));
      showToast(t("sending.cancelled.success"));
      return;
    }
    const result = await api.cancelScheduledSend(submissionId).catch((error: unknown) => {
      // The row is still on the server, so stop hiding it.
      forget();
      throw error;
    });
    if (!result.cancelled) {
      forget();
      throw new ApiError(t("sending.error.cancel"), "scheduled_send_not_cancellable");
    }
    setSubmissions((current) => current.filter((item) => item.id !== submissionId));
    showToast(t("sending.cancelled.success"));
  }, [isDemo, showToast, t]);

  const refreshSubmissions = useCallback(async (
    targetAccounts: Account[],
    { silent = false }: { silent?: boolean } = {},
  ): Promise<void> => {
    const requestId = ++submissionLoadRequestRef.current;
    if (!silent) setSubmissionLoading(true);
    if (isDemo || targetAccounts.length === 0) {
      setSubmissions(isDemo ? sortSubmissions((await ensureDemoLoaded()).createDemoSubmissions(locale)) : []);
      setSubmissionLoadError(null);
      setSubmissionLoading(false);
      return;
    }

    const settled = await Promise.allSettled(targetAccounts.map(async (account) => ({
      accountId: account.id,
      items: (await api.submissions(account.id, 100)).items,
    })));
    if (requestId !== submissionLoadRequestRef.current) return;

    const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const failedAccountIds = new Set(targetAccounts
      .filter((_, index) => settled[index]?.status === "rejected")
      .map((account) => account.id));
    const currentAccountIds = new Set(targetAccounts.map((account) => account.id));
    const incoming = fulfilled.flatMap((result) => result.items);
    // The list is refetched from several independent triggers, so responses land
    // out of order; only drop a cancellation registration once every account has
    // answered without that row, or a partial snapshot would un-hide it.
    if (cancelledSubmissionIdsRef.current.size > 0 && failedAccountIds.size === 0) {
      const presentIds = new Set(incoming.map((item) => item.id));
      for (const id of [...cancelledSubmissionIdsRef.current]) {
        if (!presentIds.has(id)) cancelledSubmissionIdsRef.current.delete(id);
      }
    }
    setSubmissions((current) => {
      const merged = mergeSubmissionSnapshots(incoming, current, { cancelledIds: cancelledSubmissionIdsRef.current });
      const keptFromFailedAccounts = current.filter((item) => currentAccountIds.has(item.accountId)
        && failedAccountIds.has(item.accountId)
        && !cancelledSubmissionIdsRef.current.has(item.id));
      return sortSubmissions([...merged, ...keptFromFailedAccounts]);
    });

    const firstFailure = settled.find((result) => result.status === "rejected");
    setSubmissionLoadError(firstFailure?.status === "rejected"
      ? t("sending.loadError", {
        count: failedAccountIds.size,
        message: mailErrorToastMessage(firstFailure.reason, t("error.localServiceUnavailable.title"), t),
      })
      : null);
    setSubmissionLoading(false);
  }, [isDemo, locale, t]);

  const applyDemoSubmissions = useCallback((items: OutboundSubmission[], markReady = false) => {
    setSubmissions(items);
    if (markReady) {
      setSubmissionLoadError(null);
      setSubmissionLoading(false);
    }
  }, []);

  const reportLoadFailure = useCallback((message: string) => {
    setSubmissionLoading(false);
    setSubmissionLoadError(message);
  }, []);

  const submissionStatusRefreshIdsKey = submissions
    .filter((submission) => submissionStatusNeedsRefresh(submission.deliveryStatus))
    .map((submission) => submission.id)
    .sort()
    .join("|");
  const submissionAttentionCount = submissions.filter((submission) => ["unknown_delivery", "failed"].includes(submission.deliveryStatus)).length;
  const submissionActiveCount = submissions.filter((submission) => ["pending", "submitting", "submitted"].includes(submission.deliveryStatus)).length;
  const submissionOutstandingCount = submissionAttentionCount + submissionActiveCount;
  const accountIdsKey = accounts.map((account) => account.id).sort().join("|");

  useEffect(() => {
    if (isDemo || !submissionStatusRefreshIdsKey || !accountIdsKey) return undefined;
    let cancelled = false;
    let attempts = 0;
    let timer = 0;
    const targetAccounts = accountsRef.current;
    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      await refreshSubmissions(targetAccounts, { silent: true });
      if (!cancelled && attempts < 12) timer = window.setTimeout(() => void poll(), 1_250);
    };
    timer = window.setTimeout(() => void poll(), 750);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `accounts` is deliberately read through the ref: a refresh swaps the array
    // identity on every list load, which would restart this effect (resetting
    // the timer and the attempt budget) before the first poll ever fired.
  }, [accountIdsKey, isDemo, refreshSubmissions, submissionStatusRefreshIdsKey]);

  return {
    submissions,
    submissionLoading,
    submissionLoadError,
    submissionAttentionCount,
    submissionOutstandingCount,
    refreshSubmissions,
    cancelScheduledSubmission,
    applyDemoSubmissions,
    reportLoadFailure,
  };
}
