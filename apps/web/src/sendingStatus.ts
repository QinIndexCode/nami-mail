import type { OutboundSubmission, OutboundSubmissionStatus } from "./types";

export type SubmissionStatusPresentation = {
  label: string;
  detail: string;
  tone: "neutral" | "progress" | "success" | "warning" | "danger";
};

const presentations: Record<OutboundSubmissionStatus, SubmissionStatusPresentation> = {
  pending: {
    label: "等待发送",
    detail: "邮件已准备就绪，正在连接发件服务器。",
    tone: "neutral",
  },
  submitting: {
    label: "正在发送",
    detail: "正在等待邮件服务商的最终响应，Nami Mail 会短时自动核对结果。",
    tone: "progress",
  },
  submitted: {
    label: "已交给服务器",
    detail: "邮件服务商已接收这封邮件，Nami Mail 正在“已发送”中自动核对。",
    tone: "progress",
  },
  confirmed: {
    label: "已核对",
    detail: "已在邮箱的“已发送”文件夹中核对到这封邮件。此状态不代表收件人已读。",
    tone: "success",
  },
  unknown_delivery: {
    label: "结果待核对",
    detail: "连接中断时，暂时无法确认邮件服务商是否已接收邮件。Nami Mail 会继续检查“已发送”；为避免重复邮件，此记录不能直接重新发送。",
    tone: "warning",
  },
  failed: {
    label: "发送失败",
    detail: "邮件服务商未接受这封邮件，或尚未建立发送所需的连接。处理相关问题后，请新建一封邮件再试。",
    tone: "danger",
  },
};

export function submissionStatusPresentation(status: OutboundSubmissionStatus): SubmissionStatusPresentation {
  return presentations[status];
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

export function recipientSummary(recipients: string[] | undefined, maxVisible = 3): string | null {
  const normalized = (recipients ?? []).map((recipient) => recipient.trim()).filter(Boolean);
  if (!normalized.length) return null;
  const visible = normalized.slice(0, maxVisible).join("、");
  return normalized.length > maxVisible ? `${visible} 等 ${normalized.length} 人` : visible;
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
