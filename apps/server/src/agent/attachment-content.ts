import type { ProviderChatMessageContent, ProviderContentPart } from "@nami/agent-contracts";

export type AgentMessageAttachmentInput = {
  name: string;
  type: string;
  /** Outbound attachment token when the file was uploaded as a mail attachment. */
  token?: string;
  /** Account the uploaded attachment is bound to (sender account). */
  accountId?: string;
  /** Extracted file text sent to the model. Not shown in the transcript; the
   *  client renders file chips from `name`/`type` instead. */
  text?: string;
  path?: string;
  /** Base64 data URL for native multimodal model input. */
  dataUrl?: string;
  mimeType?: string;
};

// The web client truncates extracted file text at this length (fileProcessor.ts).
export const AGENT_ATTACHMENT_TEXT_LIMIT = 32_000;

/** Renders attachment text in the same `[file: …]` framing the client used to
 *  inline, so model-facing content is unchanged while the transcript keeps
 *  only the user's clean text. */
export function composeAttachmentContent(
  content: string,
  attachments: readonly AgentMessageAttachmentInput[] | undefined,
): string {
  if (!attachments || attachments.length === 0) return content;
  const blocks = attachments
    .filter((attachment) => typeof attachment.text === "string" && attachment.text.length > 0)
    .map((attachment) => {
      const marker = attachment.text!.length >= AGENT_ATTACHMENT_TEXT_LIMIT ? " (truncated)" : "";
      return `[file: ${attachment.name}${marker}]\n${attachment.text}\n[/file]`;
    });
  if (blocks.length === 0) return content;
  return `${blocks.join("\n\n")}\n\n${content}`;
}

export function composeProviderChatMessageContent(
  content: string,
  attachments: readonly AgentMessageAttachmentInput[] | undefined,
): ProviderChatMessageContent {
  if (!attachments || attachments.length === 0) return content;
  const multimodal = attachments.filter((att) => typeof att.dataUrl === "string" && att.dataUrl.length > 0);
  if (multimodal.length === 0) {
    return composeAttachmentContent(content, attachments);
  }
  const parts: ProviderContentPart[] = [];
  const textContent = composeAttachmentContent(content, attachments);
  if (textContent.trim().length > 0) {
    parts.push({ type: "text", text: textContent });
  }
  for (const attachment of multimodal) {
    const dataUrl = attachment.dataUrl!;
    const mime = attachment.mimeType || "application/octet-stream";
    if (mime.startsWith("image/")) {
      parts.push({
        type: "image_url",
        imageUrl: { url: dataUrl },
      });
    } else {
      parts.push({
        type: "document",
        document: {
          url: dataUrl,
          mimeType: mime,
          name: attachment.name,
        },
      });
    }
  }
  return parts.length > 0 ? parts : content;
}
