// @vitest-environment jsdom
/**
 * Unit tests for useAgentSession — the streaming conversation state machine
 * lifted out of AgentWorkspace.tsx.
 *
 * Scope: the hook's run lifecycle (streaming/streamStatus flags, the per-run
 * session buffer and its teardown, CONFLICT retry, stop/interrupt affordances,
 * background buffering + re-entry replay, and the pickup poll). No UI is
 * rendered: a tiny harness component owns `active`/`setActive` exactly the way
 * AgentWorkspace does (injection-driven boundary) and hands the hook a live
 * activeIdRef, exposing the result + on-screen state for assertions.
 *
 * requestAnimationFrame is stubbed to a manually-drained queue so the
 * frame-batched fold pipeline (flushPendingStreamPieces) runs deterministically
 * instead of depending on jsdom's 16ms frame timer.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type {
  AgentCitation,
  AgentConversation,
  AgentMessage,
  AgentStreamEvent,
  AgentToolActivity,
} from "../agentTypes";
import { useAgentSession, type UseAgentSessionResult } from "./useAgentSession";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  agentConversation: vi.fn<typeof import("../api").api.agentConversation>(async () => ({ id: "x", title: "", preview: "", updatedAt: "", providerId: "p", scope: { mode: "all_accounts", accountIds: [], messageIds: [] }, messages: [] })),
  streamAgentMessage: vi.fn<typeof import("../api").api.streamAgentMessage>(() => new Promise(() => undefined)),
  cancelAgentRun: vi.fn<typeof import("../api").api.cancelAgentRun>(async () => ({ ok: true })),
}));

vi.mock("../api", () => ({
  ApiError: class ApiError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  },
  api: {
    agentConversation: h.agentConversation,
    streamAgentMessage: h.streamAgentMessage,
    cancelAgentRun: h.cancelAgentRun,
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const scope = { mode: "all_accounts" as const, accountIds: [], messageIds: [] };
function userQ(id: string, content: string): AgentMessage {
  return { id, role: "user", content, createdAt: "2026-08-10T00:00:00.000Z", state: "complete", citations: [], toolActivities: [] };
}
function assistant(id: string, content: string, state: AgentMessage["state"]): AgentMessage {
  return { id, role: "assistant", content, createdAt: "2026-08-10T00:00:01.000Z", state, citations: [] as AgentCitation[], toolActivities: [] as AgentToolActivity[] };
}
function conv(id: string, messages: AgentMessage[]): AgentConversation {
  return { id, title: `Conversation ${id}`, preview: "", updatedAt: "2026-08-10T00:00:00.000Z", providerId: "provider-1", scope, messages };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
type Box = {
  result: UseAgentSessionResult | null;
  active: AgentConversation | null;
};
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let ctx: { activeIdRef: { current: string | null }; box: Box };
const refreshSpy = vi.fn(async () => undefined);

function Harness(): ReactElement | null {
  const [active, setActive] = useState<AgentConversation | null>(ctx.box.active);
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [, setSuggestions] = useState<string[]>([]);
  const result = useAgentSession({
    demoMode: false,
    active,
    setActive,
    activeIdRef: ctx.activeIdRef,
    setConversations: setConversations as never,
    refreshConversations: refreshSpy,
    conversationSearch: "",
    setPendingMemorySuggestions: setSuggestions,
    getT: () => (key: string) => key,
  });
  ctx.box.result = result;
  ctx.box.active = active;
  return null;
}

function renderHarness(initialConversation: AgentConversation | null): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  ctx = {
    activeIdRef: { current: initialConversation ? initialConversation.id : null },
    box: { result: null, active: initialConversation },
  };
  act(() => {
    root.render(<Harness />);
  });
}

// ---------------------------------------------------------------------------
// Controlled rAF queue + helpers
// ---------------------------------------------------------------------------
let rafQueue: Array<(t: number) => void>;

async function drain(): Promise<void> {
  await act(async () => {
    // Yield enough microtasks inside one act scope so async continuations
    // (pickup poll ticks, runStream teardown) run and their renders flush.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    let guard = 0;
    while (rafQueue.length > 0 && guard < 5000) {
      const frames = rafQueue;
      rafQueue = [];
      for (const cb of frames) cb(performance.now());
      guard += 1;
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    }
  });
}

/** A stream script: emits the given events in order, then (optionally) holds
 *  the SSE open until the signal aborts (which rejects like a real fetch). */
function streamScript(events: AgentStreamEvent[], hold = false): typeof import("../api").api.streamAgentMessage {
  return async (_id, _payload, onEvent, signal) => {
    for (const event of events) onEvent(event);
    if (!hold) return;
    await new Promise<void>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
}

const streamPayload = { content: "hello" } as unknown as Parameters<typeof import("../api").api.streamAgentMessage>[1];

beforeEach(() => {
  vi.clearAllMocks();
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await Promise.resolve();
  });
  container?.remove();
  vi.unstubAllGlobals();
});

describe("useAgentSession", () => {
  it("folds text deltas onto the assistant row and terminal-completes it, then tears down the session", async () => {
    const cid = "c1";
    const mId = "ma1";
    const initial = conv(cid, [userQ("u1", "hello"), assistant(mId, "", "streaming")]);
    renderHarness(initial);
    h.streamAgentMessage.mockImplementation(streamScript([
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " world" },
      { type: "completed", reason: "stop" },
    ]));
    await act(async () => {
      await ctx.box.result!.runStream({ conversation: initial, assistantMessage: { id: mId }, streamPayload });
    });
    await drain();

    const row = ctx.box.active!.messages.find((m) => m.id === mId)!;
    expect(row.content).toBe("Hello world");
    expect(row.state).toBe("complete");
    expect(ctx.box.result!.getSession(cid)).toBeUndefined();
    expect(ctx.box.result!.streaming).toBe(false);
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("retries on CONFLICT until the superseded run releases, then finishes the turn", async () => {
    const cid = "c2";
    const mId = "ma2";
    const initial = conv(cid, [userQ("u2", "again"), assistant(mId, "", "streaming")]);
    renderHarness(initial);
    let calls = 0;
    h.streamAgentMessage.mockImplementation(async (_id, _payload, onEvent) => {
      calls += 1;
      if (calls === 1) {
        onEvent({ type: "error", error: { code: "CONFLICT", message: "busy", retryable: true } });
        onEvent({ type: "completed", reason: "error" });
        return;
      }
      onEvent({ type: "text_delta", delta: "ok" });
      onEvent({ type: "completed", reason: "stop" });
    });
    await act(async () => {
      await ctx.box.result!.runStream({ conversation: initial, assistantMessage: { id: mId }, streamPayload });
    });
    await drain();

    expect(calls).toBe(2);
    expect(ctx.box.result!.streamStatus).toBeNull();
    const row = ctx.box.active!.messages.find((m) => m.id === mId)!;
    expect(row.content).toBe("ok");
    expect(row.state).toBe("complete");
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("stopStreaming aborts the run, cancels the server run, and marks the row interrupted", async () => {
    const cid = "c3";
    const mId = "ma3";
    const initial = conv(cid, [userQ("u3", "go"), assistant(mId, "", "streaming")]);
    renderHarness(initial);
    h.streamAgentMessage.mockImplementation(streamScript([], true));
    let runP!: Promise<void>;
    await act(async () => {
      runP = ctx.box.result!.runStream({ conversation: initial, assistantMessage: { id: mId }, streamPayload });
    });
    runP.catch(() => undefined);

    ctx.box.result!.stopStreaming();
    await act(async () => {
      await runP;
    });
    await drain();

    expect(h.cancelAgentRun).toHaveBeenCalledWith(cid);
    const row = ctx.box.active!.messages.find((m) => m.id === mId)!;
    expect(row.interrupted).toBe(true);
    expect(row.state).toBe("complete");
    expect(ctx.box.result!.streaming).toBe(false);
  });

  it("prepareInterruptToSend folds the running reply to interrupted and cancels before the next send", async () => {
    const cid = "c4";
    const mId = "ma4";
    const initial = conv(cid, [userQ("u4", "start"), assistant(mId, "", "streaming")]);
    renderHarness(initial);
    h.streamAgentMessage.mockImplementation(streamScript([], true));
    let runP!: Promise<void>;
    await act(async () => {
      runP = ctx.box.result!.runStream({ conversation: initial, assistantMessage: { id: mId }, streamPayload });
    });
    runP.catch(() => undefined);

    act(() => {
      ctx.box.result!.prepareInterruptToSend();
    });
    expect(h.cancelAgentRun).toHaveBeenCalledWith(cid);
    const row = ctx.box.active!.messages.find((m) => m.id === mId)!;
    expect(row.interrupted).toBe(true);
    expect(row.state).toBe("complete");
    expect(ctx.box.result!.streaming).toBe(false);
    // Drain the interrupted run's teardown inside act so no update leaks out.
    await act(async () => {
      await runP;
    });
  });

  it("replayBackgroundSession rebuilds the assistant row from buffered events and restores live indicators", () => {
    const cid = "c5";
    const mId = "ma5";
    const view = conv(cid, [userQ("u5", "question")]);
    renderHarness(view);
    const session = {
      conversationId: cid,
      assistantMessageId: mId,
      controller: new AbortController(),
      events: [
        { type: "status", message: "searching" } as AgentStreamEvent,
        { type: "text_delta", delta: "Replied" } as AgentStreamEvent,
      ],
      status: "searching",
      suggestions: ["remember this"],
      done: false,
    } as Parameters<UseAgentSessionResult["replayBackgroundSession"]>[0];

    act(() => {
      ctx.box.result!.replayBackgroundSession(session, view);
    });

    const row = ctx.box.active!.messages.find((m) => m.id === mId)!;
    expect(row.content).toBe("Replied");
    expect(row.state).toBe("streaming");
    expect(ctx.box.result!.streaming).toBe(true);
    expect(ctx.box.result!.streamStatus).toBe("searching");
  });

  it("buffers a background run without rendering, then replays it on re-entry", async () => {
    const cid = "c6";
    const mId = "ma6";
    const background = conv(cid, [userQ("u6", "question")]);
    const onScreen = conv("other", [userQ("u7", "what"), assistant("ma0", "existing", "streaming")]);
    renderHarness(onScreen);
    h.streamAgentMessage.mockImplementation(streamScript([
      { type: "text_delta", delta: "bgReply" },
      { type: "status", message: "working" },
    ], true));
    let runP!: Promise<void>;
    await act(async () => {
      runP = ctx.box.result!.runStream({ conversation: background, assistantMessage: { id: mId }, streamPayload });
    });
    runP.catch(() => undefined);

    const session = ctx.box.result!.getSession(cid)!;
    expect(session).toBeDefined();
    expect(session.events.some((e) => e.type === "text_delta" && e.delta === "bgReply")).toBe(true);
    expect(ctx.box.result!.hasLiveRun(cid)).toBe(true);
    // The on-screen transcript is untouched while the background run streams.
    expect(ctx.box.active!.id).toBe("other");
    expect(ctx.box.active!.messages.every((m) => m.content !== "bgReply")).toBe(true);

    act(() => {
      ctx.box.result!.replayBackgroundSession(session, background);
    });
    const row = ctx.box.active!.messages.find((m) => m.id === mId)!;
    expect(ctx.box.active!.id).toBe(cid);
    expect(row.content).toBe("bgReply");
    expect(row.state).toBe("streaming");
    expect(ctx.box.result!.streaming).toBe(true);
  });

  it("folds in a completed server snapshot while picking up an unanswered turn", async () => {
    const cid = "c7";
    const unanswered = conv(cid, [userQ("u8", "when will it be done?")]);
    const answered = conv(cid, [
      userQ("u8", "when will it be done?"),
      assistant("ma8", "done now", "complete"),
    ]);
    // The pickup poll fires its first fetch on mount, so the mock must be in
    // place before the harness renders.
    h.agentConversation.mockImplementation(async () => answered);
    renderHarness(unanswered);
    await drain();

    const row = ctx.box.active!.messages.find((m) => m.role === "assistant")!;
    expect(row.content).toBe("done now");
    expect(row.state).toBe("complete");
    expect(ctx.box.result!.ghostConversationId).toBeNull();
    expect(refreshSpy).toHaveBeenCalled();
  });
});