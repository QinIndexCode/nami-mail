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
  });
});
