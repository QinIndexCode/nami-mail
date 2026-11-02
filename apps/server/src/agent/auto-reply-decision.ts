import { randomUUID } from "node:crypto";
import { isAgentErrorShape } from "./provider-common.js";
import { AgentServiceError } from "./agent-shared.js";
import type { LlmProvider, ProviderDecisionAnswer } from "@nami/agent-contracts";
import type { ProviderConfiguration } from "./provider-service.js";
import type { AutoReplyDecisionAttribution } from "./auto-reply-decisions.js";

/**
 * The auto-reply decision stage: its wire-shaped evaluation types, the
 * tolerant JSON parsers for the chat-prompt strategy, and the typed `decide()`
 * strategy for decision models (System One / Jev). Extracted from
 * agent-service.ts so the evaluation strategies own their own file instead of
 * growing a frozen monolith.
 */

export type AutoReplyEvaluationInput = {
  accountEmail: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  textBody: string;
  snippet: string;
  sensitiveKeywords: readonly string[];
  memoryContext: string;
  decisionProviderId?: string | null;
  draftProviderId?: string | null;
  /** Minimum "worth replying" probability for the typed decision strategy. */
  decisionThreshold?: number;
};

export type AutoReplyEvaluationResult = {
  replyValue: "high" | "low";
  sensitive: boolean;
  replyText?: string;
  /** Which model and strategy produced the judgement, for the decision audit. */
  decision?: AutoReplyDecisionAttribution;
};

/**
 * Tolerantly parses the strict JSON object the auto-reply review prompt asks
 * for. Any deviation defaults to a low-value classification so the pipeline
 * never sends a reply it cannot demonstrate was intended.
 */
export function parseAutoReplyEvaluation(output: string): AutoReplyEvaluationResult {
  const cleaned = output.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = undefined;
  }
  const value = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
  const replyValue = value && value.replyValue === "high" ? "high" : "low";
  const sensitive = value?.sensitive === true;
  const rawReply = typeof value?.reply === "string" ? value.reply.trim() : "";
  return {
    replyValue,
    sensitive,
    ...(replyValue === "high" && rawReply.length > 0 ? { replyText: rawReply } : {}),
  };
}

/**
 * Tolerantly parses the decision-only JSON object the decoupled auto-reply
 * review prompt asks for. Any deviation defaults to a low-value classification
 * so the pipeline never sends a reply it cannot demonstrate was intended.
 */
export function parseAutoReplyDecision(output: string): { replyValue: "high" | "low"; sensitive: boolean } {
  const cleaned = output.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = undefined;
  }
  const value = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
  const replyValue = value && value.replyValue === "high" ? "high" : "low";
  const sensitive = value?.sensitive === true;
  return { replyValue, sensitive };
}

/** Backoff schedule for the bounded decision-stage retry: two retries. */
const DECISION_RETRY_DELAYS_MS = [500, 1_000] as const;

/**
 * Two backed-off retries for transient decision failures (timeout, rate
 * limit, unavailable provider). The evaluation stage is a message's last
 * chance — the notify path only fires for newly arrived mail, so a surrendered
 * evaluation is a permanently skipped reply. Errors the provider mapped as
 * non-retryable (bad credentials, cancellation) rethrow immediately.
 */
export async function withDecisionRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const retryable = error instanceof AgentServiceError
        ? error.retryable
        : isAgentErrorShape(error)
          ? error.retryable
          : false;
      if (!retryable || attempt >= DECISION_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, DECISION_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * The calibrated "yes" probability of a `noul` answer. The response carries
 * labelled probabilities when the model reports its legend, and the bare
 * boolean otherwise; the boolean fallback keeps a legend-less answer usable
 * instead of silently reading as a permanent "no".
 */
export function noulYesProbability(answer: ProviderDecisionAnswer): number {
  const yesEntry = Object.entries(answer.probabilities ?? {}).find(([label]) => /\b(yes|true|affirmative)\b/i.test(label));
  if (yesEntry) return yesEntry[1];
  if (typeof answer.score === "number") return answer.score;
  return answer.noul === true ? 1 : 0;
}

/**
 * The typed-decision strategy for auto-reply review: two `noul` questions
 * ("is this worth replying to", "is this sensitive") against a decision model
 * that cannot chat. Worth-replying is thresholded by the user setting;
 * sensitivity uses a fixed 0.5 bar because both outcomes still require user
 * confirmation, so the threshold's cost asymmetry only applies to the
 * reply/no-reply split.
 */
export async function evaluateAutoReplyWithDecisionAdapter(
  adapter: { decide: NonNullable<LlmProvider["decide"]> },
  configuration: ProviderConfiguration,
  state: string,
  decisionThreshold: number | undefined,
): Promise<{ replyValue: "high" | "low"; sensitive: boolean; decision: AutoReplyDecisionAttribution }> {
  const threshold = decisionThreshold ?? 0.7;
  const response = await withDecisionRetry(() => adapter.decide({
    requestId: `auto-reply-decision-${randomUUID()}`,
    providerId: configuration.id,
    model: configuration.model,
    state,
    questions: {
      "worth-replying": {
        type: "noul",
        instructions: "判断这封邮件是否值得自动回复：营销、推广、通知简报、自动消息或明显无需回应的内容答 no；需要收件人回应的来信答 yes。",
      },
      "is-sensitive": {
        type: "noul",
        instructions: "判断这封邮件或对它的回复是否涉及敏感内容：密码、验证码、支付、银行卡、账户安全或可能暴露收件人隐私的内容答 yes。",
      },
    },
  }));
  const worthReplying = response.answers["worth-replying"];
  const isSensitive = response.answers["is-sensitive"];
  const worthProbability = worthReplying ? noulYesProbability(worthReplying) : 0;
  return {
    replyValue: worthProbability >= threshold ? "high" : "low",
    sensitive: isSensitive ? noulYesProbability(isSensitive) >= 0.5 : false,
    decision: {
      providerId: configuration.id,
      strategy: "typed",
      score: worthProbability,
      ...(worthReplying?.confidence !== undefined ? { confidence: worthReplying.confidence } : {}),
    },
  };
}
