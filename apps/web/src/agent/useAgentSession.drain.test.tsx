// @vitest-environment jsdom
/**
 * Unit tests for drainPendingFlush (useAgentSession.ts) — the conversation-
 * switch consumption path. Where clearPendingFlush DROPS the queued deltas
 * (right for CONFLICT retries: a rejected attempt's deltas belong to a run
 * that never happened), a switch must DRAIN them onto the outgoing transcript
 * in one pass, so the parked tail is never lost across the view swap.
 *
 * Pinned here, in terms of the invariants the switch depends on:
 *   1. order preservation — the folded text is character-for-character the
 *      arrival order (content is a pure append);
 *   2. a terminal event in the queue lands in the SAME drain — the row reaches
 *      its final state at once (no lingering "streaming", no poll re-arm);
 *   3. the queue is empty and nothing is re-armed afterwards;
 *   4. the pacing window is reset, so the next paced flush is still step-
 *      capped instead of dumping a stale hidden-state backlog in one paint.
 *
 * Determinism: the same faithful rAF frame queue as the streamloss tests.
 * Deltas are 121 chars, above any single-paint budget STREAM_REVEAL can give.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { api } from "../api";
import type { AgentConversation, AgentMessage, AgentStreamEvent } from "../agentTypes";
import { STREAM_REVEAL, useAgentSession, type UseAgentSessionResult } from "./useAgentSession";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  streamAgentMessage: vi.fn<typeof api.streamAgentMessage>(() => new Promise(() => undefined)),
  cancelAgentRun: vi.fn<typeof api.cancelAgentRun>(async () => ({ ok: true })),
}));

vi.mock("../api", () => ({
  ApiError: class ApiError extends Error {
    code?: string;
  },
  api: {
    streamAgentMessage: h.streamAgentMessage,
    cancelAgentRun: h.cancelAgentRun,
  },
}));

const scope = { mode: "all_accounts" as const, accountIds: [], messageIds: [] };

function conv(id: string, messages: AgentMessage[]): AgentConversation {
  return { id, title: `Conversation ${id}`, preview: "", updatedAt: "2026-08-10T00:00:00.000Z", providerId: "provider-1", scope, messages };
}

type Box = { result: UseAgentSessionResult | null; active: AgentConversation | null };
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let ctx: { activeIdRef: { current: string | null }; box: Box };

function Harness(): ReactElement | null {
  const [active, setActive] = useState<AgentConversation | null>(ctx.box.active);
  const [, setConversations] = useState<AgentConversation[]>([]);
  const [, setSuggestions] = useState<string[]>([]);
  const result = useAgentSession({
    demoMode: false,
    active,
    setActive,
    activeIdRef: ctx.activeIdRef,
    setConversations: setConversations as never,
    refreshConversations: async () => undefined,
    conversationSearch: "",
    setPendingMemorySuggestions: setSuggestions,
    getT: () => (key: string) => key,
  });
  ctx.box.result = result;
  ctx.box.active = active;
  return null;
}

function renderHarness(initialConversation: AgentConversation): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  ctx = {
    activeIdRef: { current: initialConversation.id },
    box: { result: null, active: initialConversation },
  };
  act(() => {
    root.render(<Harness />);
  });
}

let rafQueue: Map<number, FrameRequestCallback>;
let nextRafId = 0;

const armedFrames = (): number => rafQueue.size;

async function stepFrame(): Promise<void> {
  await act(async () => {
    const frames = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of frames) cb(performance.now());
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

/** One delta per token; 121 chars > any single-paint budget. */
const CHUNK = `${"A".repeat(120)}|`;
const MARKED = ["111|", "222|", "333|"].map((head) => `${head}${"A".repeat(117)}`);

const onScreenContent = (id: string): string => ctx.box.active?.messages.find((m) => m.id === id)?.content ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  rafQueue = new Map();
  nextRafId = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    nextRafId += 1;
    rafQueue.set(nextRafId, cb);
    return nextRafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue.delete(id);
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await Promise.resolve();
  });
  container?.remove();
  vi.unstubAllGlobals();
});

/** Starts a run in `cid` and hands back the raw SSE `onEvent` emitter. */
async function startRun(view: AgentConversation, assistantId: string): Promise<{ emit: (e: AgentStreamEvent) => void }> {
  let emit!: (event: AgentStreamEvent) => void;
  h.streamAgentMessage.mockImplementation(async (_id, _payload, onEvent, signal) => {
    await new Promise<void>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
      emit = (event: AgentStreamEvent) => {
        onEvent(event);
        if (event.type === "completed" || event.type === "error") resolve();
      };
    });
  });
  await act(async () => {
    void ctx.box.result!.runStream({ conversation: view, assistantMessage: { id: assistantId }, streamPayload: { content: "hello" } as unknown as Parameters<typeof api.streamAgentMessage>[1] });
  });
  return { emit };
}

describe("useAgentSession — drainPendingFlush (conversation-switch drain)", () => {
  it("drains the whole queue in arrival order in one pass, leaves nothing armed, and further frames paint nothing", async () => {
    const cid = "c-drain-order";
    const mId = "local-assistant-drain";
    renderHarness(conv(cid, [
      { id: "u-1", role: "user", content: "q", createdAt: "2026-08-10T00:00:00.000Z", state: "complete", citations: [], toolActivities: [] },
      { id: mId, role: "assistant", content: "", createdAt: "2026-08-10T00:00:01.000Z", state: "streaming", citations: [], toolActivities: [] },
    ]));
    const { emit } = await startRun(ctx.box.active!, mId);

    // Three distinguishable deltas arrive inside one frame: a bounded slice of
    // the front one paints, the rest is parked.
    act(() => {
      emit({ type: "text_delta", delta: MARKED[0] });
      emit({ type: "text_delta", delta: MARKED[1] });
      emit({ type: "text_delta", delta: MARKED[2] });
    });
    await stepFrame();
    expect(onScreenContent(mId).length).toBeGreaterThan(0);
    expect(onScreenContent(mId).length).toBeLessThan(MARKED.join("").length);
    expect(armedFrames()).toBe(1);

    // The switch drain: everything queued paints, in arrival order.
    act(() => {
      ctx.box.result!.drainPendingFlush();
    });
    expect(onScreenContent(mId)).toBe(MARKED.join(""));

    // Queue empty, nothing re-armed, and later frames change nothing.
    expect(armedFrames()).toBe(0);
    await stepFrame();
    expect(onScreenContent(mId)).toBe(MARKED.join(""));

    ctx.box.result!.stopStreaming();
    await drainPendingFrames();
  });

  it("lands a terminal event in the same drain: the row reaches its final state at once and nothing re-arms", async () => {
    const cid = "c-drain-terminal";
    const mId = "local-assistant-terminal";
    renderHarness(conv(cid, [
      { id: "u-1", role: "user", content: "q", createdAt: "2026-08-10T00:00:00.000Z", state: "complete", citations: [], toolActivities: [] },
      { id: mId, role: "assistant", content: "", createdAt: "2026-08-10T00:00:01.000Z", state: "streaming", citations: [], toolActivities: [] },
    ]));
    const { emit } = await startRun(ctx.box.active!, mId);

    // Text parked behind a terminal event: the drain must apply both in the
    // same pass — content complete AND state terminal (the old break-and-
    // promote behaviour would leave the tail queued behind the terminal).
    act(() => {
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "completed", reason: "stop" });
    });
    act(() => {
      ctx.box.result!.drainPendingFlush();
    });

    expect(onScreenContent(mId)).toBe(CHUNK.repeat(2));
    expect(ctx.box.active!.messages.find((m) => m.id === mId)?.state).toBe("complete");
    expect(armedFrames()).toBe(0);
    await stepFrame();
    expect(onScreenContent(mId)).toBe(CHUNK.repeat(2));

    ctx.box.result!.stopStreaming();
    await drainPendingFrames();
  });

  it("resets the pacing window, so the next paced flush is still step-capped (no stale hidden-state dump)", async () => {
    const cid = "c-drain-pacing";
    const mId = "local-assistant-pacing";
    renderHarness(conv(cid, [
      { id: "u-1", role: "user", content: "q", createdAt: "2026-08-10T00:00:00.000Z", state: "complete", citations: [], toolActivities: [] },
      { id: mId, role: "assistant", content: "", createdAt: "2026-08-10T00:00:01.000Z", state: "streaming", citations: [], toolActivities: [] },
    ]));
    const { emit } = await startRun(ctx.box.active!, mId);

    act(() => {
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "text_delta", delta: CHUNK });
    });
    act(() => {
      ctx.box.result!.drainPendingFlush();
    });
    expect(onScreenContent(mId)).toBe(CHUNK.repeat(2));

    // A new delta after the drain: one paint may reveal at most the step
    // ceiling — a drain must not turn the next flush into an unbounded dump.
    act(() => {
      emit({ type: "text_delta", delta: CHUNK });
    });
    await stepFrame();
    const painted = onScreenContent(mId).length - CHUNK.repeat(2).length;
    expect(painted).toBeGreaterThanOrEqual(1);
    expect(painted).toBeLessThanOrEqual(STREAM_REVEAL.stepCharsCeiling);

    ctx.box.result!.stopStreaming();
    await drainPendingFrames();
  });
});

/** Steps frames until the pipeline stops arming any (teardown helper). */
async function drainPendingFrames(): Promise<void> {
  await act(async () => {
    let guard = 0;
    while (rafQueue.size > 0 && guard < 5000) {
      const frames = [...rafQueue.values()];
      rafQueue.clear();
      for (const cb of frames) cb(performance.now());
      guard += 1;
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    }
  });
}
