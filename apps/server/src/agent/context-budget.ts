import type { AgentToolDescriptor, ProviderChatMessage } from "@nami/agent-contracts";

/**
 * Heuristic token estimation and context budget management for Agent runs.
 * Supports token estimation (CJK & Latin aware), tool output pruning,
 * and conversational history compaction.
 */

const CJK_REGEX = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g;

/**
 * Fast, conservative token estimator.
 * CJK characters typically consume ~1.2 to 1.5 tokens each in modern tokenizers.
 * Latin/alphanumeric characters typically consume ~1 token per 3.5 to 4 characters.
 */
export function estimateTokens(data: unknown): number {
  if (data === null || data === undefined) return 0;
  if (typeof data === "number" || typeof data === "boolean") return 1;

  let str: string;
  if (typeof data === "string") {
    str = data;
  } else {
    try {
      str = JSON.stringify(data);
    } catch {
      str = String(data);
    }
  }

  if (!str) return 0;

  const cjkMatches = str.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = str.length - cjkCount;

  const cjkTokens = cjkCount * 1.35;
  const nonCjkTokens = nonCjkCount / 3.8;

  return Math.ceil(cjkTokens + nonCjkTokens);
}

/**
 * Estimate the total tokens of all provider chat messages and available tools.
 */
export function estimateMessagesTokens(
  messages: readonly ProviderChatMessage[],
  tools?: readonly AgentToolDescriptor[],
): number {
  let total = 0;

  for (const message of messages) {
    // Role & message framing overhead (~4 tokens)
    total += 4;

    if (message.content) {
      total += estimateTokens(message.content);
    }

    if (message.reasoningContent) {
      total += estimateTokens(message.reasoningContent);
    }

    if (message.name) {
      total += estimateTokens(message.name);
    }

    if (message.toolCallId) {
      total += estimateTokens(message.toolCallId);
    }

    if (Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        total += 6; // framing
        total += estimateTokens(call.id);
        total += estimateTokens(call.toolName);
        total += estimateTokens(call.input);
      }
    }
  }

  if (Array.isArray(tools) && tools.length > 0) {
    for (const tool of tools) {
      total += 8; // definition framing
      total += estimateTokens(tool.name);
      total += estimateTokens(tool.title);
      total += estimateTokens(tool.description);
      if (tool.parameters) {
        total += estimateTokens(tool.parameters);
      }
    }
  }

  return total;
}

/**
 * Check if the current context is approaching the configured token limit.
 */
export function isApproachingContextLimit(
  messages: readonly ProviderChatMessage[],
  contextWindow: number,
  maxOutputTokens: number,
  thresholdRatio = 0.75,
  tools?: readonly AgentToolDescriptor[],
): {
  approaching: boolean;
  currentTokens: number;
  availableBudget: number;
  ratio: number;
} {
  const availableBudget = Math.max(1_000, contextWindow - maxOutputTokens);
  const currentTokens = estimateMessagesTokens(messages, tools);
  const ratio = currentTokens / availableBudget;

  return {
    approaching: ratio >= thresholdRatio,
    currentTokens,
    availableBudget,
    ratio,
  };
}

/**
 * Prune a single tool's output to prevent exploding the context window.
 * Retains essential structures and summaries while truncating giant payloads.
 */
export function pruneToolOutput(output: unknown, maxTokens = 1_500): unknown {
  const currentTokens = estimateTokens(output);
  if (currentTokens <= maxTokens) return output;

  if (typeof output === "string") {
    const targetChars = Math.max(200, Math.floor(maxTokens * 2.8));
    const headChars = Math.floor(targetChars * 0.7);
    const tailChars = Math.floor(targetChars * 0.15);
    return `${output.slice(0, headChars)}\n\n... [已剪枝: 原始输出过长，已截断省略中间部分以控制上下文预算] ...\n\n${output.slice(-tailChars)}`;
  }

  if (Array.isArray(output)) {
    const prunedItems: unknown[] = [];
    let accumulatedTokens = 0;
    const perItemBudget = Math.max(100, Math.floor(maxTokens / Math.min(output.length, 5)));

    for (let i = 0; i < output.length; i++) {
      const item = output[i];
      const itemPruned = pruneToolOutput(item, perItemBudget);
      const itemTokens = estimateTokens(itemPruned);

      if (accumulatedTokens + itemTokens > maxTokens - 80 && prunedItems.length > 0) {
        prunedItems.push({
          _pruned: true,
          omittedCount: output.length - i,
          note: `已剪枝: 原始结果共 ${output.length} 项，已省略后续 ${output.length - i} 项以控制上下文预算。`,
        });
        break;
      }

      prunedItems.push(itemPruned);
      accumulatedTokens += itemTokens;
    }

    return prunedItems;
  }

  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    const copy: Record<string, unknown> = {};

    // Common array fields in mail/search tool outputs
    for (const [key, value] of Object.entries(record)) {
      if (Array.isArray(value)) {
        copy[key] = pruneToolOutput(value, Math.floor(maxTokens * 0.7));
      } else if (typeof value === "string" && value.length > 800) {
        copy[key] = pruneToolOutput(value, Math.floor(maxTokens * 0.3));
      } else if (value && typeof value === "object") {
        copy[key] = pruneToolOutput(value, Math.floor(maxTokens * 0.4));
      } else {
        copy[key] = value;
      }
    }

    if (estimateTokens(copy) > maxTokens) {
      // If still too large, stringify and truncate
      try {
        const serialized = JSON.stringify(copy);
        return pruneToolOutput(serialized, maxTokens);
      } catch {
        return copy;
      }
    }

    return copy;
  }

  return output;
}

/**
 * Automatically compress conversation history when approaching token budgets.
 * 1. Preserves the system message (index 0).
 * 2. Preserves the latest turn (the most recent user prompt and ongoing tool loop).
 * 3. Prunes older tool results first (often reclaiming 80%+ tokens).
 * 4. If still exceeding budget, collapses earliest multi-turn dialogue into a concise summary.
 */
export function compressContextHistory(
  messages: readonly ProviderChatMessage[],
  targetBudgetTokens: number,
): ProviderChatMessage[] {
  if (messages.length <= 3) return [...messages];
  if (estimateMessagesTokens(messages) <= targetBudgetTokens) return [...messages];

  const result: ProviderChatMessage[] = messages.map((msg) => ({ ...msg }));

  // Keep first message if system
  const hasSystem = result.length > 0 && result[0]!.role === "system";
  const protectedStart = hasSystem ? 1 : 0;
  // Protect latest 2 messages (e.g. current user query and immediate context)
  const protectedEnd = Math.max(protectedStart, result.length - 2);

  // Phase 1: Prune intermediate tool result messages
  for (let i = protectedStart; i < protectedEnd; i++) {
    const msg = result[i]!;
    if (msg.role === "tool" && msg.content && estimateTokens(msg.content) > 150) {
      msg.content = "[此前工具调用已完成，详细输出已折叠以节约上下文预算]";
    }
  }

  if (estimateMessagesTokens(result) <= targetBudgetTokens) {
    return result;
  }

  // Phase 2: If still exceeding budget, collapse older conversation turns into a summary
  const collapsibleTurnsCount = protectedEnd - protectedStart;
  if (collapsibleTurnsCount >= 2) {
    const turnsToSummarize = result.slice(protectedStart, protectedStart + Math.min(collapsibleTurnsCount, 4));
    const snippets = turnsToSummarize.map((m) => {
      const preview = (m.content || "").replace(/\s+/g, " ").slice(0, 80);
      return `${m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "工具"}: ${preview}`;
    });

    const summaryMessage: ProviderChatMessage = {
      role: "user",
      content: `[早期多轮对话上下文已折叠摘要: 共 ${turnsToSummarize.length} 轮互动。${snippets.join("; ")}]`,
    };

    result.splice(protectedStart, turnsToSummarize.length, summaryMessage);
  }

  return result;
}
