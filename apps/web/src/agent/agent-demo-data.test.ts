import { describe, expect, it } from "vitest";
import { createDemoConversation, createDemoSourceMessages } from "./agent-demo-data";

describe("Agent demo conversation", () => {
  it("keeps the full fixture for the regular demo", () => {
    const conversation = createDemoConversation("zh-CN");

    expect(conversation.messages.at(-1)?.state).toBe("streaming");
    expect(conversation.messages.some((message) => message.confirmation?.state === "pending")).toBe(true);
    expect(conversation.messages.some((message) => message.error !== undefined)).toBe(true);
  });

  it("uses four completed, source-backed messages for the site preview", () => {
    const conversation = createDemoConversation("zh-CN", true);
    const sources = createDemoSourceMessages("zh-CN");
    const sourceIds = new Set(sources.map((source) => source.id));

    expect(conversation.messages.map((message) => message.id)).toEqual([
      "demo-msg-1",
      "demo-msg-2",
      "demo-msg-3",
      "demo-msg-4",
    ]);
    expect(conversation.messages.every((message) => message.state === "complete")).toBe(true);
    expect(conversation.messages.every((message) => !message.error && !message.confirmation)).toBe(true);
    expect(
      conversation.messages.flatMap((message) => message.citations).every((citation) => sourceIds.has(citation.messageId)),
    ).toBe(true);
    expect(conversation.preview).toBe(conversation.messages[3]?.content);
  });
});
