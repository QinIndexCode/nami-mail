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

// While Sent-folder verification can still change the record, the UI keeps
// polling those statuses instead of freezing the row on a transient state.
export function submissionStatusNeedsRefresh(status: OutboundSubmission["deliveryStatus"]): boolean {
  return submissionStatusesNeedingRefresh.has(status);
}

export function submissionMessageIdSuffix(messageId: string): string {
  const normalized = messageId.replace(/^</, "").replace(/>$/, "");
  const localPart = normalized.split("@")[0] || normalized;
  return localPart.length > 10 ? localPart.slice(-10) : localPart;
}

export function recipientSummary(recipients: string[] | undefined, maxVisible = 3, t: Translate = defaultTranslate): string | null {
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
    ...(submission.recipients?.length ? { to: submission.recipients.join(", ") } : {}),
    ...(submission.subject !== undefined && submission.subject !== null ? { subject: submission.subject } : {}),
  };
}

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
  for (let attempt = 0; attempt < attempts && current.deliveryStatus === "submitting"; attempt += 1) {
    await wait(intervalMs);
    current = await lookup(current.id);
  }
  return current;
}
