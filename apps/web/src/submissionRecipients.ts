import type { OutboundSubmission, MessageDetail } from "./types";
import type { Translate } from "./i18n";

export type MailRecipientInput = { to: string[]; cc?: string[]; bcc?: string[] };

export function draftRecipientFields(message: Pick<MessageDetail, "to" | "cc" | "bcc">) {
  const text = (addresses: MessageDetail["to"] = []) => addresses.map((recipient) => recipient.address).filter(Boolean).join(", ");
  return { to: text(message.to), cc: text(message.cc), bcc: text(message.bcc) };
}

export function hasRejectedRecipients(submission: Pick<OutboundSubmission, "recipientDelivery">): boolean {
  return Boolean(submission.recipientDelivery?.rejected.length);
}

export function rejectedRecipientsMessage(submission: Pick<OutboundSubmission, "recipientDelivery">, t: Translate): string | null {
  const rejected = submission.recipientDelivery?.rejected;
  return rejected?.length ? t("sending.partialRecipients", { count: rejected.length, recipients: rejected.map((item) => `${item.address}${item.responseCode ? ` (${item.responseCode})` : ""}`).join(", ") }) : null;
}

/** A partial retry must not include addresses the SMTP server already accepted. */
export function retryRecipientGroups(submission: OutboundSubmission): { to: string[]; cc: string[]; bcc: string[] } {
  const rejected = submission.recipientDelivery?.rejected;
  const filter = (addresses: string[]) => rejected?.length
    ? addresses.filter((address) => rejected.some((item) => item.address.toLowerCase() === address.toLowerCase())) : addresses;
  return {
    to: filter(submission.toRecipients ?? submission.recipients),
    cc: filter(submission.ccRecipients ?? []),
    bcc: filter(submission.bccRecipients ?? []),
  };
}
