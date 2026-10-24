import { translate, type Translate } from "./i18n";
import type { OutboundSubmission, OutboundSubmissionStatus } from "./types";

export type SubmissionStatusPresentation = {
  label: string;
  detail: string;
  tone: "neutral" | "progress" | "success" | "warning" | "danger";
};

const presentationKeys: Record<OutboundSubmissionStatus, { tone: SubmissionStatusPresentation["tone"]; label: string; detail: string }> = {
  pending: { tone: "neutral", label: "sending.pending.label", detail: "sending.pending.detail" },
  submitting: { tone: "progress", label: "sending.submitting.label", detail: "sending.submitting.detail" },
  submitted: { tone: "progress", label: "sending.submitted.label", detail: "sending.submitted.detail" },
  confirmed: { tone: "success", label: "sending.confirmed.label", detail: "sending.confirmed.detail" },
  unknown_delivery: { tone: "warning", label: "sending.unknownDelivery.label", detail: "sending.unknownDelivery.detail" },
  failed: { tone: "danger", label: "sending.failed.label", detail: "sending.failed.detail" },
};

const defaultTranslate: Translate = (key, values) => translate("zh-CN", key, values);

export function submissionStatusPresentation(status: OutboundSubmissionStatus, t: Translate = defaultTranslate): SubmissionStatusPresentation {
  const presentation = presentationKeys[status];
  return {
    tone: presentation.tone,
    label: t(presentation.label),
    detail: t(presentation.detail),
  };
}

/**
 * How far along a submission is. Sent-folder verification only ever advances a
 * record, so this ordering doubles as the tie-break when two snapshots carry the
 * same timestamp: the further-along status wins.
 */
const submissionStatusRank: Record<OutboundSubmissionStatus, number> = {
  pending: 0,
  submitting: 1,
  submitted: 2,
  confirmed: 3,
  unknown_delivery: 3,
  failed: 3,
};

/** True when `next` describes the same submission as of an older moment. */
export function isStaleSubmissionSnapshot(next: OutboundSubmission, current: OutboundSubmission): boolean {
  const nextAt = new Date(next.updatedAt).getTime();
  const currentAt = new Date(current.updatedAt).getTime();
  if (Number.isFinite(nextAt) && Number.isFinite(currentAt) && nextAt !== currentAt) return nextAt < currentAt;
  return submissionStatusRank[next.deliveryStatus] < submissionStatusRank[current.deliveryStatus];
}

/**
 * Merges a freshly fetched submission snapshot into the rows already on screen.
 *
 * The list is refetched from several independent triggers (an action
 * finishing, the delivery-verification poll, a manual refresh) and the
 * responses can land out of order. A slower snapshot describing an earlier
 * moment must therefore not put a row back — a send that was already confirmed
 * reverting to "sending", or a cancelled scheduled send reappearing — while
 * every other row still comes from the server.
 */
export function mergeSubmissionSnapshots(
  incoming: readonly OutboundSubmission[],
  current: readonly OutboundSubmission[],
  { cancelledIds }: { cancelledIds?: ReadonlySet<string> } = {},
): OutboundSubmission[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  const merged: OutboundSubmission[] = [];
  for (const next of incoming) {
    if (cancelledIds?.has(next.id)) continue;
    const previous = currentById.get(next.id);
    merged.push(previous && isStaleSubmissionSnapshot(next, previous) ? previous : next);
  }
  return merged;
}

export function sortSubmissions(items: OutboundSubmission[]): OutboundSubmission[] {
  return [...items].sort((left, right) => {
    const timeDifference = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    return Number.isFinite(timeDifference) && timeDifference !== 0
      ? timeDifference
      : right.id.localeCompare(left.id);
  });
}

const submissionStatusesNeedingRefresh = new Set<OutboundSubmission["deliveryStatus"]>([
  "submitting",
  "submitted",
  "unknown_delivery",
]);

/**
 * While Sent-folder verification can still change the record, the UI keeps
 * polling those statuses instead of freezing the row on a transient state.
 *
 * `pending` is deliberately absent, and not because it is settled: it is the
 * column value for "no attempt has happened yet", which a send parked on a
 * future `sendAt` also holds -- for hours. Polling it here would have the
 * sending-status view re-arm its bounded poll over every parked scheduled mail.
 * The wait for an *immediate* send's first attempt is the composer's own poll
 * (`pollSubmittingSubmission`, entered on `submissionInFlight`), not this one.
 */
export function submissionStatusNeedsRefresh(status: OutboundSubmission["deliveryStatus"]): boolean {
  return submissionStatusesNeedingRefresh.has(status);
}

/**
 * True while a send has not been given up on but no attempt has finished:
 * `pending` (accepted, queued, not yet claimed) and `submitting` (an attempt is
 * running). The single definition behind every "keep waiting" question -- the
 * composer's poll entry, its timeout branch, and the poll's own loop condition --
 * so the three cannot drift apart.
 */
export function submissionInFlight(status: OutboundSubmission["deliveryStatus"]): boolean {
  return status === "pending" || status === "submitting";
}

export function submissionMessageIdSuffix(messageId: string): string {
  const normalized = messageId.replace(/^</, "").replace(/>$/, "");
  const localPart = normalized.split("@")[0] || normalized;
  return localPart.length > 10 ? localPart.slice(-10) : localPart;
}

export function recipientSummary(recipients: string[], maxVisible = 3, t: Translate = defaultTranslate): string | null {
  // `OutboundSubmission.recipients` is a compile-time contract only: api.ts
  // hands the raw response body to it as a bare type assertion, so a
  // malformed payload arrives as undefined/null. This is the runtime floor
  // that keeps one bad row from taking the whole sending-status modal down
  // (the call sites only guard the *empty* case with `?? "recipientsMissing"`).
  const normalized = (recipients ?? []).map((recipient) => recipient.trim()).filter(Boolean);
  if (!normalized.length) return null;
  const visible = normalized.slice(0, maxVisible).join(t("common.listSeparator"));
  return normalized.length > maxVisible ? t("sending.recipientsMore", { recipients: visible, count: normalized.length }) : visible;
}

export function newMessageDraftFromSubmission(submission: OutboundSubmission): {
  accountId: string;
  to?: string;
  subject?: string;
} {
  return {
    accountId: submission.accountId,
    // subject/recipients are required on the wire (the server always emits
    // them), so the old null/undefined guards are dead.
    ...(submission.recipients.length ? { to: submission.recipients.join(", ") } : {}),
    subject: submission.subject,
  };
}

/**
 * Follows a send the acceptance only queued until an attempt gives it a real
 * outcome, then returns whatever the ledger holds.
 *
 * It starts on `pending` too: the route commits the ledger row and its dispatch
 * task and returns before any attempt exists, so the first lookup a few hundred
 * milliseconds later is normally what turns `pending` into `submitting`. A run
 * that exhausts its attempts returns the last record -- still in flight, and the
 * caller decides what to say about that.
 */
export async function pollSubmittingSubmission(
  initial: OutboundSubmission,
  lookup: (id: string) => Promise<OutboundSubmission>,
  {
    attempts = 12,
    intervalMs = 750,
    wait = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)),
  }: {
    attempts?: number;
    intervalMs?: number;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<OutboundSubmission> {
  let current = initial;
  for (let attempt = 0; attempt < attempts && submissionInFlight(current.deliveryStatus); attempt += 1) {
    await wait(intervalMs);
    current = await lookup(current.id);
  }
  return current;
}
