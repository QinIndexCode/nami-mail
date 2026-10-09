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
      // The contract field is parametersSchema (R06b): a large tool schema
      // must count against the context budget or the request can silently
      // exceed the model's window.
      const schema = tool.parametersSchema;
      if (schema) {
        total += estimateTokens(schema);
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
 *
 * The transcript is partitioned into turns: every real user message starts a
 * new turn, and everything up to the next user message belongs to it
 * (assistant tool-call declarations, their tool results, interim assistant
 * text). The partition is the protocol boundary — an assistant message that
 * declares tool calls and the tool results answering it must always move,
 * prune, or collapse TOGETHER, or the provider rejects the request for a
 * tool result with no declaration behind it.
 *
 * 1. Preserves the system message.
 * 2. Preserves the latest (current) turn wholesale — the ongoing tool loop.
 * 3. Prunes older turns' tool-result contents first (role and toolCallId are
 *    kept, so the declaration/result pairing stays closed).
 * 4. If still exceeding budget, collapses the OLDEST WHOLE TURNS into a
 *    summary user message — never a message range that could cut a turn in
 *    half. The current turn is collapsed only as a last resort, and even
 *    then only by pruning large tool-result contents (structure preserved).
 */
export function compressContextHistory(
  messages: readonly ProviderChatMessage[],
  targetBudgetTokens: number,
): ProviderChatMessage[] {
  if (messages.length <= 3) return [...messages];
  if (estimateMessagesTokens(messages) <= targetBudgetTokens) return [...messages];

  const system: ProviderChatMessage[] = [];
  const turns: ProviderChatMessage[][] = [];
  for (const message of messages) {
    if (system.length === 0 && turns.length === 0 && message.role === "system") {
      system.push({ ...message });
      continue;
    }
    if (message.role === "user") {
      turns.push([{ ...message }]);
      continue;
    }
    if (turns.length > 0) turns[turns.length - 1]!.push({ ...message });
    else system.push({ ...message });
  }
  if (turns.length === 0) return [...messages];

  const pruneToolResultContent = (message: ProviderChatMessage): void => {
    if (message.role === "tool" && message.content && estimateTokens(message.content) > 150) {
      message.content = "[此前工具调用已完成，详细输出已折叠以节约上下文预算]";
    }
  };
  const assemble = (): ProviderChatMessage[] => [...system, ...turns.flat()];
  const fits = (): boolean => estimateMessagesTokens(assemble()) <= targetBudgetTokens;

  // Phase 1: prune large tool-result contents in OLDER turns only. The
  // current turn is the ongoing tool loop — its results are what the model
  // is actively working with.
  for (const turn of turns.slice(0, -1)) {
    for (const message of turn) pruneToolResultContent(message);
  }
  if (fits()) return assemble();

  // Phase 2: collapse the oldest whole turns into one summary user message.
  // Each collapse consumes entire turns, so no assistant declaration can be
  // separated from its results. The collapse stays bounded at ~4 messages —
  // the previous single-shot behavior — so the amount of retained history
  // does not shrink just because the partition is coarser.
  if (turns.length > 1) {
    let summarizedTurns = 0;
    let summarizedMessages = 0;
    const snippets: string[] = [];
    while (turns.length > 1 && !fits()) {
      const nextTurn = turns[0]!;
      if (summarizedMessages > 0 && summarizedMessages + nextTurn.length > 4) break;
      const oldest = turns.shift()!;
      summarizedTurns += 1;
      summarizedMessages += oldest.length;
      for (const message of oldest) {
        const preview = (message.content || "").replace(/\s+/g, " ").slice(0, 80);
        snippets.push(`${message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : "工具"}: ${preview}`);
      }
    }
    const summaryMessage: ProviderChatMessage = {
      role: "user",
      content: `[早期多轮对话上下文已折叠摘要: 共 ${summarizedTurns} 轮互动、${summarizedMessages} 条消息。${snippets.join("; ")}]`,
    };
    turns.unshift([summaryMessage]);
    if (fits()) return assemble();
  }

  // Last resort: only the current turn remains and it alone exceeds the
  // budget. Prune its large tool-result contents — the role/toolCallId
  // structure stays intact, so the request remains protocol-valid; the model
  // just loses older detail.
  for (const turn of turns) {
    for (const message of turn) pruneToolResultContent(message);
  }
  return assemble();
}
