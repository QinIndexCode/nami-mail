import type { MailTemplate } from "./types";

export type TemplateInsertResult = {
  subject: string;
  body: string;
  /** True when the template's subject was written into an empty subject field. */
  filledSubject: boolean;
  /** True when the template body was appended to existing text. */
  appendedBody: boolean;
};

/**
 * Applies a mail template to a compose draft. The template subject only fills
 * an empty subject; the template body replaces an empty body and is appended
 * below existing text otherwise, so a quick reply never destroys what was
 * already written.
 */
export function applyTemplateToDraft(
  current: { subject: string; body: string },
  template: MailTemplate,
): TemplateInsertResult {
  const hasSubject = template.subject.trim().length > 0;
  const filledSubject = hasSubject && current.subject.trim().length === 0;
  const subject = filledSubject ? template.subject : current.subject;
  const templateBody = template.body.trim();
  const currentBody = current.body.trim();
  const appendedBody = currentBody.length > 0;
  const body = appendedBody ? `${currentBody}\n\n${templateBody}` : templateBody;
  return { subject, body, filledSubject, appendedBody };
}
