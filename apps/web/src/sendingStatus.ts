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

export function sortSubmissions(items: OutboundSubmission[]): OutboundSubmission[] {
  return [...items].sort((left, right) => {
    const timeDifference = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    return Number.isFinite(timeDifference) && timeDifference !== 0
      ? timeDifference
      : right.id.localeCompare(left.id);
  });
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
