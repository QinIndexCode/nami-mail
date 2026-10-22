import type { ProviderChatRequest } from "@nami/agent-contracts";

/**
 * Converts the unified message content into the chat-completions shape.
 * Documents travel as image URLs because this endpoint has no document part.
 */
export function formatOpenAiContent(content: ProviderChatRequest["messages"][number]["content"]): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part.type === "text") {
        return { type: "text", text: part.text };
      }
      if (part.type === "image_url") {
        return {
          type: "image_url",
          image_url: {
            url: part.imageUrl.url,
            ...(part.imageUrl.detail ? { detail: part.imageUrl.detail } : {}),
          },
        };
      }
      if (part.type === "document") {
        return {
          type: "image_url",
          image_url: {
            url: part.document.url,
          },
        };
      }
      return part;
    });
  }
  return content;
}
