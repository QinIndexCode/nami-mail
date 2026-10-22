/**
 * The shapes one agent turn reports outward.
 *
 * Everything here is a pure projection: it turns an internal record, a raw tool
 * payload or an error into the stable shape the client and the next provider
 * request consume. Keeping these out of the run engine lets the engine read as
 * the turn's control flow (retry, tool rounds, persistence) instead of a mix of
 * control flow and payload assembly.
 */

import type {
  AgentCitation,
  AgentConfirmation,
  AgentError,
  ConfirmationRequest,
} from "@nami/agent-contracts";
import type { AgentRagSearchResult } from "../agent-rag-worker.js";
import { canonicalAgentJson } from "./store-crypto.js";

/** The error shape stored on an assistant message and streamed to the client. */
export type AgentMessageError = { code: string; message: string; suggestion?: string; retryable?: boolean };

/** One-line preview used for conversation summaries and tool details. */
export function shortPreview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117).trimEnd()}...`;
}

/** The query a search-class tool was invoked with, defensively extracted from
 *  the model-provided tool input (arrives as unknown). */
export function searchQueryDetail(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim() !== "") return shortPreview(input.trim());
  const record = (input && typeof input === "object") ? (input as Record<string, unknown>) : undefined;
  const query = record?.query ?? record?.keyword ?? record?.q ?? record?.text ?? record?.subject ?? record?.searchTerm;
  return typeof query === "string" && query.trim() !== "" ? shortPreview(query.trim()) : undefined;
}

/** The result count a search tool reported, defensively extracted from the
 *  tool output (arrives as unknown). */
export function searchResultCount(output: unknown): number | undefined {
  const total = (output as { total?: unknown } | null | undefined)?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

// Unified cap for tool results fed back to the model on the next turn. Built-in
// mail tools and MCP tools already bound their own outputs; this is a final
// safety net so any tool (or future tool) can never push an unbounded payload
// into the provider conversation context.
const maximumToolResultCharacters = 64 * 1024;

export function toolResultMessage(ok: boolean, value: unknown): string {
  const serialized = canonicalAgentJson(ok ? { ok: true, data: value } : { ok: false, error: value });
  if (serialized.length <= maximumToolResultCharacters) return serialized;
  return canonicalAgentJson({
    ok,
    ...(ok
      ? { data: { truncated: true, message: `The tool result exceeded the ${maximumToolResultCharacters} character safety limit and was truncated.` } }
      : { error: value }),
  });
}

export function messageForRag(result: AgentRagSearchResult): AgentCitation {
  return {
    id: result.citation.id,
    messageId: result.citation.messageId,
    accountId: result.citation.accountId,
    subject: result.citation.subject ?? "",
    sender: result.citation.sender ?? "",
    sentAt: result.citation.sentAt ?? "",
    excerpt: result.citation.excerpt ?? "",
    ...(result.citation.confidence !== undefined ? { confidence: result.citation.confidence } : {}),
  };
}

export function stableUserFacingError(error: AgentError): AgentMessageError {
  return {
    code: error.code,
    message: error.message,
    ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    retryable: error.retryable,
  };
}

export function confirmationView(request: ConfirmationRequest, state: AgentConfirmation["state"]): AgentConfirmation {
  return {
    id: request.id,
    title: request.preview.title,
    summary: request.preview.summary,
    fields: request.preview.fields.map((field) => ({ label: field.label, value: field.value })),
    expiresAt: request.expiresAt,
    state,
  };
}

/**
 * Tool errors are fed back to the model as canonical JSON. Keep that payload
 * deliberately small: `details` may contain arbitrary provider values, while
 * canonical persistence rejects undefined or otherwise unstable values.
 */
export function modelToolError(error: AgentError): AgentMessageError {
  return stableUserFacingError(error);
}
