import type { AgentError, CallerContext, ProviderChatRequest } from "@nami/agent-contracts";
import type { AgentRuntime } from "@nami/agent-core";

/**
 * The host makes a few model calls that no user turn asked for: naming a
 * conversation after its first message, reviewing an inbound mail before the
 * auto-reply pipeline drafts anything. They are ordinary provider chats and
 * they belong on the same seam as a conversation turn — `AgentRuntime
 * .streamChat` — for one concrete reason: a test that stubs that one method
 * must never be surprised by a real outbound request. A side door around it is
 * how a hermetic suite quietly starts paying DNS latency it never budgeted
 * for, and it also means a future call added next to these can miss the seam
 * without anything noticing.
 *
 * They still carry a caller because the runtime's request type asks for one.
 * `service` is the honest kind (the host asked, not a user or a paired
 * caller), and the call authorizes nothing: empty scopes and no account scope,
 * because this request invokes no tool and reaches no mailbox.
 */
const auxiliaryCaller: CallerContext = {
  callerId: "agent-host-chat",
  kind: "service",
  entryPoint: "service",
  accessLevel: "read-only",
  scopes: [],
  accountScope: { mode: "none" },
  interactive: false,
  canRequestConfirmation: false,
};

/** What an auxiliary stream produced: its text, or the error that ended it. */
export type AuxiliaryChatOutcome =
  | { status: "text"; text: string }
  | { status: "error"; error: AgentError; text: string };

/**
 * Runs one auxiliary chat to completion and reduces the runtime's event stream
 * to what the caller cares about. The first `error` event wins; the text
 * accumulated up to that point rides along in the outcome so each caller
 * decides what an error means for it — the retrieval expander salvages the
 * terms that arrived before the abort.
 *
 * The optional knobs exist because the host's auxiliary calls are not all the
 * same shape, and none of them may reach for the provider adapter to get their
 * shape back:
 *
 * - `signal` cancels the stream. The runtime turns a cancelled stream into an
 *   `error` event rather than a throw, so a caller that treats cancellation as
 *   "keep what you have" must recognise it by its own signal.
 * - `onDelta` forwards each token as it lands, for a transport that streams
 *   progress instead of waiting for the whole answer.
 * - `maxCharacters` stops consuming once the answer is long enough to be worth
 *   parsing. Breaking out of the loop returns the runtime's generator, which
 *   closes the provider stream underneath it.
 */
export async function collectAuxiliaryChatText(input: {
  runtime: AgentRuntime;
  requestId: string;
  chat: ProviderChatRequest;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  maxCharacters?: number;
}): Promise<AuxiliaryChatOutcome> {
  let text = "";
  for await (const event of input.runtime.streamChat({
    requestId: input.requestId,
    caller: auxiliaryCaller,
    chat: input.chat,
    ...(input.signal ? { signal: input.signal } : {}),
  })) {
    if (event.type === "text_delta") {
      text += event.delta;
      input.onDelta?.(event.delta);
      if (input.maxCharacters !== undefined && text.length >= input.maxCharacters) break;
    }
    if (event.type === "error") return { status: "error", error: event.error, text };
  }
  return { status: "text", text };
}
