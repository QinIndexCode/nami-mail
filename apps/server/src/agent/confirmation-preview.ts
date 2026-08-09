import { agentT, type AgentMessageKey } from "./agent-messages.js";
import { defaultLocale, type SupportedLocale } from "../localization.js";

/**
 * Localized confirmation-preview builders for the write tools. Previews are
 * rendered in the caller's locale on the server so the in-app confirmation card
 * and the native desktop dialog always show the same localized copy.
 */

export type ConfirmationPreview = {
  title: string;
  summary: string;
  fields: Array<{ label: string; value: string }>;
};

type Recipient = { name?: string; address: string };

type DraftLikeInput = {
  accountId: string;
  to?: ReadonlyArray<Recipient>;
  cc?: ReadonlyArray<Recipient>;
  subject?: string;
  text: string;
  attachmentTokens?: readonly string[];
  /**
   * Display filenames resolved from the attachment tokens by the host, in the
   * same order. When absent or shorter than the token list the preview falls
   * back to showing just the attachment count.
   */
  attachmentNames?: readonly string[];
};

function localeOf(locale: string | undefined): SupportedLocale {
  return locale === "zh-CN" || locale === "en-US" ? locale : defaultLocale;
}

function clipped(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(0, maximum) : value;
}

function recipientPreview(locale: SupportedLocale, recipients: readonly Recipient[]): string {
  const value = recipients
    .map((recipient) => (recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address))
    .join(", ");
  return clipped(value, 1_800) || agentT(locale, "confirmation.value.none");
}

function bodyPreview(locale: SupportedLocale, text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const preview = clipped(normalized, 800);
  if (!preview) return agentT(locale, "confirmation.value.empty");
  return preview === normalized ? preview : `${preview}...`;
}

function field(locale: SupportedLocale, key: AgentMessageKey, value: string): { label: string; value: string } {
  return { label: agentT(locale, key), value };
}

/** Adds an attachment row to a confirmation card when tokens are present. */
function attachmentField(
  locale: SupportedLocale,
  input: Pick<DraftLikeInput, "attachmentTokens" | "attachmentNames">,
): { label: string; value: string } | null {
  const tokens = input.attachmentTokens;
  if (!tokens?.length) return null;
  const names = input.attachmentNames;
  const value = names && names.length === tokens.length && names.every((name) => name.length > 0)
    ? clipped(names.join("、"), 600)
    : agentT(locale, "confirmation.value.attachments_count", { count: tokens.length });
  return field(locale, "confirmation.field.attachments", value);
}

/** create-draft and update-draft share the same field layout. */
export function draftConfirmationPreview(
  locale: string | undefined,
  input: DraftLikeInput,
  draftId?: string,
): ConfirmationPreview {
  const resolved = localeOf(locale);
  const updating = Boolean(draftId);
  const attachments = attachmentField(resolved, input);
  return {
    title: agentT(resolved, updating ? "confirmation.title.update_draft" : "confirmation.title.create_draft"),
    summary: agentT(resolved, updating ? "confirmation.summary.update_draft" : "confirmation.summary.create_draft"),
    fields: [
      ...(draftId ? [field(resolved, "confirmation.field.draft_id", draftId)] : []),
      field(resolved, "confirmation.field.account", input.accountId),
      field(resolved, "confirmation.field.to", recipientPreview(resolved, input.to ?? [])),
      field(resolved, "confirmation.field.cc", recipientPreview(resolved, input.cc ?? [])),
      field(resolved, "confirmation.field.subject", input.subject || agentT(resolved, "confirmation.value.no_subject")),
      {
        label: agentT(resolved, "confirmation.field.body_preview", { count: input.text.length }),
        value: bodyPreview(resolved, input.text),
      },
      ...(attachments ? [attachments] : []),
    ],
  };
}

export function deleteDraftConfirmationPreview(
  locale: string | undefined,
  input: { accountId: string; draftId: string },
): ConfirmationPreview {
  const resolved = localeOf(locale);
  return {
    title: agentT(resolved, "confirmation.title.delete_draft"),
    summary: agentT(resolved, "confirmation.summary.delete_draft"),
    fields: [
      field(resolved, "confirmation.field.account", input.accountId),
      field(resolved, "confirmation.field.draft_id", input.draftId),
    ],
  };
}

export function deleteAccountConfirmationPreview(
  locale: string | undefined,
  input: { accountId: string },
): ConfirmationPreview {
  const resolved = localeOf(locale);
  return {
    title: agentT(resolved, "confirmation.title.delete_account"),
    summary: agentT(resolved, "confirmation.summary.delete_account"),
    fields: [
      field(resolved, "confirmation.field.account", input.accountId),
    ],
  };
}

export function moveMailConfirmationPreview(
  locale: string | undefined,
  input: { messageId: string; target: string },
): ConfirmationPreview {
  const resolved = localeOf(locale);
  return {
    title: agentT(resolved, "confirmation.title.move_mail"),
    summary: agentT(resolved, "confirmation.summary.move_mail", { target: input.target }),
    fields: [
      field(resolved, "confirmation.field.message_id", input.messageId),
      field(resolved, "confirmation.field.target", input.target),
    ],
  };
}

export function setFlagConfirmationPreview(
  locale: string | undefined,
  input: { messageId: string; flag: string; value: boolean },
): ConfirmationPreview {
  const resolved = localeOf(locale);
  const titleKey = input.value ? "confirmation.title.set_flag" : "confirmation.title.clear_flag";
  const summaryKey = input.value ? "confirmation.summary.set_flag" : "confirmation.summary.clear_flag";
  return {
    title: agentT(resolved, titleKey),
    summary: agentT(resolved, summaryKey, { flag: input.flag }),
    fields: [
      field(resolved, "confirmation.field.message_id", input.messageId),
      field(resolved, "confirmation.field.flag", input.flag),
      field(resolved, "confirmation.field.value", input.value ? agentT(resolved, "confirmation.value.set") : agentT(resolved, "confirmation.value.cleared")),
    ],
  };
}

export function sendMailConfirmationPreview(locale: string | undefined, input: DraftLikeInput): ConfirmationPreview {
  const resolved = localeOf(locale);
  const attachments = attachmentField(resolved, input);
  return {
    title: agentT(resolved, "confirmation.title.send_mail"),
    summary: agentT(resolved, "confirmation.summary.send_mail"),
    fields: [
      field(resolved, "confirmation.field.account", input.accountId),
      field(resolved, "confirmation.field.to", recipientPreview(resolved, input.to ?? [])),
      field(resolved, "confirmation.field.cc", recipientPreview(resolved, input.cc ?? [])),
      field(resolved, "confirmation.field.subject", input.subject || agentT(resolved, "confirmation.value.no_subject")),
      {
        label: agentT(resolved, "confirmation.field.body_preview", { count: input.text.length }),
        value: bodyPreview(resolved, input.text),
      },
      ...(attachments ? [attachments] : []),
    ],
  };
}

export function replyMailConfirmationPreview(
  locale: string | undefined,
  input: DraftLikeInput & { messageId: string },
): ConfirmationPreview {
  const resolved = localeOf(locale);
  const attachments = attachmentField(resolved, input);
  return {
    title: agentT(resolved, "confirmation.title.reply_mail"),
    summary: agentT(resolved, "confirmation.summary.reply_mail"),
    fields: [
      field(resolved, "confirmation.field.account", input.accountId),
      field(resolved, "confirmation.field.replying_to", input.messageId),
      field(resolved, "confirmation.field.to", recipientPreview(resolved, input.to ?? [])),
      field(resolved, "confirmation.field.cc", recipientPreview(resolved, input.cc ?? [])),
      field(resolved, "confirmation.field.subject", input.subject || agentT(resolved, "confirmation.value.derived_subject")),
      {
        label: agentT(resolved, "confirmation.field.body_preview", { count: input.text.length }),
        value: bodyPreview(resolved, input.text),
      },
      ...(attachments ? [attachments] : []),
    ],
  };
}

export function mcpWriteConfirmationPreview(
  locale: string | undefined,
  name: string,
  serverLabel: string,
  input: unknown,
): ConfirmationPreview {
  const resolved = localeOf(locale);
  const fields = input && typeof input === "object" && !Array.isArray(input)
    ? Object.entries(input as Record<string, unknown>).slice(0, 10).map(([key, value]) => ({
      label: key,
      value: typeof value === "string" ? value.slice(0, 2_000) : JSON.stringify(value).slice(0, 2_000),
    }))
    : [];
  return {
    title: agentT(resolved, "confirmation.title.mcp_write", { name }),
    summary: agentT(resolved, "confirmation.summary.mcp_write", { server: serverLabel }),
    fields,
  };
}

// Update inputs may change only some fields, so every calendar field is
// optional here and only present values are rendered in the preview.
type CalendarEventInput = {
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
};

function calendarEventFields(resolved: SupportedLocale, input: CalendarEventInput): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];
  if (input.title) fields.push(field(resolved, "confirmation.field.event_title", clipped(input.title, 1_800)));
  if (input.startAt) fields.push(field(resolved, "confirmation.field.starts_at", input.startAt));
  if (input.endAt) fields.push(field(resolved, "confirmation.field.ends_at", input.endAt));
  if (input.location) fields.push(field(resolved, "confirmation.field.event_location", clipped(input.location, 1_800)));
  if (input.description) {
    const normalized = input.description.replace(/\s+/g, " ").trim();
    const preview = clipped(normalized, 800);
    fields.push({
      label: agentT(resolved, "confirmation.field.event_description"),
      value: preview === normalized ? preview || agentT(resolved, "confirmation.value.empty") : `${preview}...`,
    });
  }
  return fields;
}

export function createCalendarEventConfirmationPreview(
  locale: string | undefined,
  input: CalendarEventInput,
): ConfirmationPreview {
  const resolved = localeOf(locale);
  return {
    title: agentT(resolved, "confirmation.title.create_calendar_event"),
    summary: agentT(resolved, "confirmation.summary.create_calendar_event"),
    fields: calendarEventFields(resolved, input),
  };
}

export function updateCalendarEventConfirmationPreview(
  locale: string | undefined,
  input: CalendarEventInput & { eventId: string },
): ConfirmationPreview {
  const resolved = localeOf(locale);
  return {
    title: agentT(resolved, "confirmation.title.update_calendar_event"),
    summary: agentT(resolved, "confirmation.summary.update_calendar_event"),
    fields: [
      field(resolved, "confirmation.field.event_id", input.eventId),
      ...calendarEventFields(resolved, input),
    ],
  };
}

export function deleteCalendarEventConfirmationPreview(
  locale: string | undefined,
  input: { eventId: string; title?: string },
): ConfirmationPreview {
  const resolved = localeOf(locale);
  return {
    title: agentT(resolved, "confirmation.title.delete_calendar_event"),
    summary: agentT(resolved, "confirmation.summary.delete_calendar_event"),
    fields: [
      field(resolved, "confirmation.field.event_id", input.eventId),
      ...(input.title ? [field(resolved, "confirmation.field.event_title", input.title)] : []),
    ],
  };
}
