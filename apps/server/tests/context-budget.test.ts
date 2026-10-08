import { describe, expect, it } from "vitest";
import {
  compressContextHistory,
  estimateMessagesTokens,
  estimateTokens,
  isApproachingContextLimit,
  pruneToolOutput,
} from "../src/agent/context-budget.js";
import type { ProviderChatMessage } from "@nami/agent-contracts";

describe("context-budget", () => {
  describe("estimateTokens", () => {
    it("estimates empty or falsy data as 0", () => {
      expect(estimateTokens("")).toBe(0);
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
    });

    it("estimates Latin alphanumeric text", () => {
      const text = "Hello world! This is a test sentence for token calculation.";
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(10);
      expect(tokens).toBeLessThan(30);
    });

    it("estimates CJK characters with appropriate density", () => {
      const text = "你好，世界！这是一段用于测试中文 Token 计数的长句子。";
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(20);
    });

    it("estimates objects and arrays via JSON serialization", () => {
      const obj = { id: 123, name: "Alice", tags: ["vip", "client"] };
      const tokens = estimateTokens(obj);
      expect(tokens).toBeGreaterThan(5);
    });
  });

  describe("estimateMessagesTokens", () => {
    it("sums tokens across messages with framing overhead", () => {
      const messages: ProviderChatMessage[] = [
        { role: "system", content: "You are a helpful mail assistant." },
        { role: "user", content: "Summarize my unread emails." },
      ];
      const total = estimateMessagesTokens(messages);
      expect(total).toBeGreaterThan(15);
    });
  });

  describe("isApproachingContextLimit", () => {
    it("detects when context approaches the limit ratio", () => {
      const messages: ProviderChatMessage[] = [
        { role: "system", content: "System prompt ".repeat(300) },
        { role: "user", content: "User prompt ".repeat(300) },
      ];
      const result = isApproachingContextLimit(messages, 2_000, 500, 0.7);
      expect(result.approaching).toBe(true);
      expect(result.ratio).toBeGreaterThan(0.7);
    });

    it("reports false when well within budget", () => {
      const messages: ProviderChatMessage[] = [
        { role: "system", content: "Short system" },
        { role: "user", content: "Short user" },
      ];
      const result = isApproachingContextLimit(messages, 8_192, 2_048, 0.75);
      expect(result.approaching).toBe(false);
      expect(result.ratio).toBeLessThan(0.1);
    });
  });

  describe("pruneToolOutput", () => {
    it("returns output unchanged if within budget", () => {
      const small = { status: "ok", count: 2 };
      expect(pruneToolOutput(small, 500)).toEqual(small);
    });

    it("truncates long strings with head, tail, and pruning note", () => {
      const longText = "A".repeat(5000) + "B".repeat(5000);
      const pruned = pruneToolOutput(longText, 200) as string;
      expect(typeof pruned).toBe("string");
      expect(pruned.length).toBeLessThan(longText.length);
      expect(pruned).toContain("已剪枝");
      expect(pruned.startsWith("AAAA")).toBe(true);
      expect(pruned.endsWith("BBBB")).toBe(true);
    });

    it("prunes arrays and includes omitted items note", () => {
      const list = Array.from({ length: 50 }, (_, i) => ({
        id: `mail-${i}`,
        subject: `Test subject ${i} with long description `.repeat(5),
      }));
      const pruned = pruneToolOutput(list, 300) as Array<Record<string, unknown>>;
      expect(Array.isArray(pruned)).toBe(true);
      expect(pruned.length).toBeLessThan(list.length);
      const last = pruned[pruned.length - 1];
      expect(last?._pruned).toBe(true);
      expect(last?.omittedCount).toBeGreaterThan(0);
    });
  });

  describe("compressContextHistory", () => {
    it("compresses intermediate tool messages when over budget", () => {
      const messages: ProviderChatMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "First question" },
        { role: "assistant", content: "Looking up..." },
        { role: "tool", content: "Extremely long tool output ".repeat(100) },
        { role: "assistant", content: "Here is your answer." },
        { role: "user", content: "Second question" },
      ];

      const compressed = compressContextHistory(messages, 150);
      expect(compressed.length).toBeLessThanOrEqual(messages.length);
      const toolMsg = compressed.find((m) => m.role === "tool");
      if (toolMsg) {
        expect(toolMsg.content).toContain("折叠");
      }
    });

    it("keeps every tool result paired with its assistant declaration (R06a)", () => {
      // The reported reproduction: system, a long user turn, one assistant
      // declaring three calls, three tool results. The old compression could
      // splice away the declaration and leave orphaned tool results behind.
      const messages: ProviderChatMessage[] = [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Long question ".repeat(400) },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-a", toolName: "messages.list", input: {}, requestedAt: "2026-10-09T00:00:00.000Z" },
            { id: "call-b", toolName: "messages.get", input: {}, requestedAt: "2026-10-09T00:00:01.000Z" },
            { id: "call-c", toolName: "messages.search", input: {}, requestedAt: "2026-10-09T00:00:02.000Z" },
          ],
        },
        { role: "tool", toolCallId: "call-a", content: "output a ".repeat(200) },
        { role: "tool", toolCallId: "call-b", content: "output b ".repeat(200) },
        { role: "tool", toolCallId: "call-c", content: "output c ".repeat(200) },
      ];

      const compressed = compressContextHistory(messages, 150);

      const declaredIds = new Set(
        compressed
          .filter((message) => message.role === "assistant")
          .flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)),
      );
      const toolMessages = compressed.filter((message) => message.role === "tool");
      // Whatever survives compression, no tool result may lose the assistant
      // declaration that owns it.
      for (const message of toolMessages) {
        expect(typeof message.toolCallId === "string" && declaredIds.has(message.toolCallId)).toBe(true);
      }
      // The current turn's user message is never deleted.
      expect(compressed.some((message) => message.role === "user" && message.content.includes("Long question"))).toBe(true);
    });

    it("collapses older turns as whole units and never mutates the input", () => {
      const longTurn = (index: number): ProviderChatMessage[] => [
        { role: "user", content: `Question ${index} `.repeat(200) },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: `call-${index}`, toolName: "messages.list", input: {}, requestedAt: "2026-10-09T00:00:00.000Z" }],
        },
        { role: "tool", toolCallId: `call-${index}`, content: `Tool output ${index} `.repeat(200) },
        { role: "assistant", content: `Answer ${index}` },
      ];
      const messages: ProviderChatMessage[] = [
        { role: "system", content: "System prompt" },
        ...longTurn(1),
        ...longTurn(2),
        ...longTurn(3),
      ];
      const snapshot = structuredClone(messages);

      const compressed = compressContextHistory(messages, 200);

      expect(messages).toEqual(snapshot);
      // Protocol closure: every surviving tool result still has its
      // declaration.
      const declaredIds = new Set(
        compressed
          .filter((message) => message.role === "assistant")
          .flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)),
      );
      for (const message of compressed.filter((item) => item.role === "tool")) {
        expect(typeof message.toolCallId === "string" && declaredIds.has(message.toolCallId)).toBe(true);
      }
      // The current turn is intact: its user message and its declaration.
      expect(compressed.some((message) => message.content?.includes("Question 3"))).toBe(true);
      expect(declaredIds.has("call-3")).toBe(true);
    });

    it("counts the tool's parametersSchema against the budget (R06b)", () => {
      const bigSchema = { type: "object", description: "模式描述".repeat(1000) };
      const baseTools = [{
        name: "messages.list",
        title: "List messages",
        description: "List mail",
        category: "messages",
        executionMode: "read",
        requiredScopes: [],
        accountAccess: "required",
        confirmationPolicy: "never",
        availableToExternal: false,
      }] as unknown as Parameters<typeof estimateMessagesTokens>[1];
      const withSchema = baseTools!.map((tool) => ({ ...tool, parametersSchema: bigSchema }));

      const without = estimateMessagesTokens([], baseTools);
      const with_ = estimateMessagesTokens([], withSchema);
      // A 3000-CJK-character schema adds well over a thousand estimated
      // tokens; the old code read a non-existent field and counted nothing.
      expect(with_ - without).toBeGreaterThan(1000);
    });
  });
});
