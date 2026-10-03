// @vitest-environment jsdom
/**
 * Reproduction tests for the confirmed front-end defect: an in-flight agent
 * reply intermittently loses characters/content that the data layer still has,
 * and a re-hydration (conversation switch / panel reopen) shows a *longer*
 * version of the same reply.
 *
 * Two loss channels are probed, both on the "delta -> queue -> paint" pipeline
 * in useAgentSession.ts. Both are FIXED; these tests pin the fixed behaviour:
 *
 *   CHANNEL A — queued-but-unpainted leftovers were destroyed by
 *               clearPendingFlush, which AgentWorkspace called first thing in
 *               selectConversation / createConversation. The switch now calls
 *               drainPendingFlush, which paints the whole queue onto the
 *               outgoing transcript in one pass.
 *   CHANNEL B — the silent `if (!row) return` drop in the flush after a server
 *               snapshot adoption dropped the optimistic local row, because
 *               the server never adopted a client assistant id. The server now
 *               adopts clientAssistantMessageId (run-engine.ts), so the row
 *               keeps its id and the deltas fold into it.
 *
 * Determinism: requestAnimationFrame/cancelAnimationFrame are stubbed with a
 * *faithful* frame queue (cancellation really removes the frame — the existing
 * useAgentSession.test.tsx stub is a no-op canceller, which hides exactly the
 * orphaning this file is about). Frames are stepped one at a time, so the
 * "how much fits in one frame" arithmetic never depends on wall-clock jitter:
 * under the STREAM_REVEAL layer one paint reveals a bounded slice (>= 1 char,
 * <= stepCharsCeiling) of the front delta, and every delta below is 121 chars,
 * so a frame can never paint a whole delta, let alone the whole reply.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import type { api } from "../api";
import type {
  AgentCitation,
  AgentConversation,
  AgentMessage,
  AgentStreamEvent,
  AgentToolActivity,
} from "../agentTypes";
import { keepAheadTranscript, useAgentSession, type UseAgentSessionResult } from "./useAgentSession";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  agentConversation: vi.fn<typeof api.agentConversation>(async () => ({
    id: "x", title: "", preview: "", updatedAt: "", providerId: "p",
    scope: { mode: "all_accounts", accountIds: [], messageIds: [] }, messages: [],
  })),
  streamAgentMessage: vi.fn<typeof api.streamAgentMessage>(() => new Promise(() => undefined)),
  cancelAgentRun: vi.fn<typeof api.cancelAgentRun>(async () => ({ ok: true })),
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
// Harness (same injection-driven boundary AgentWorkspace uses)
// ---------------------------------------------------------------------------
type Box = {
  result: UseAgentSessionResult | null;
  active: AgentConversation | null;
  /** The component-owned setActive, exposed so a test can replay the exact
   *  snapshot-adoption expression AgentWorkspace uses (AgentWorkspace.tsx
   *  :1119-1121 and :1771-1773) without needing the whole panel. */
  adoptServerSnapshot: (view: AgentConversation, live: boolean) => void;
};
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let ctx: { activeIdRef: { current: string | null }; box: Box };
const refreshSpy = vi.fn(async () => undefined);

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
    refreshConversations: refreshSpy,
    conversationSearch: "",
    setPendingMemorySuggestions: setSuggestions,
    getT: () => (key: string) => key,
  });
  ctx.box.result = result;
  ctx.box.active = active;
  ctx.box.adoptServerSnapshot = (view, live) => {
    setActive((current) => (current && current.id === view.id ? keepAheadTranscript(current, view, live) : view));
  };
  return null;
}

function renderHarness(initialConversation: AgentConversation | null): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  ctx = {
    activeIdRef: { current: initialConversation ? initialConversation.id : null },
    box: { result: null, active: initialConversation, adoptServerSnapshot: () => undefined },
  };
  act(() => {
    root.render(<Harness />);
  });
}

// ---------------------------------------------------------------------------
// Controlled frame queue — cancellation is honoured (that is the point)
// ---------------------------------------------------------------------------
let rafQueue: Map<number, FrameRequestCallback>;
let nextRafId = 0;

/** Frames currently armed by the pipeline. 0 => nothing will ever paint. */
const armedFrames = (): number => rafQueue.size;

/** Run exactly the frames armed right now, once. */
async function stepFrame(): Promise<void> {
  await act(async () => {
    const frames = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of frames) cb(performance.now());
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

/** Run frames until the pipeline stops arming any. */
async function drain(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
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

const streamPayload = { content: "hello" } as unknown as Parameters<typeof api.streamAgentMessage>[1];

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

// ---------------------------------------------------------------------------
// Shared scenario helpers
// ---------------------------------------------------------------------------
/** One delta per token; 121 chars > the 70-char per-frame reveal ceiling. */
const CHUNK = `${"A".repeat(120)}|`;

/** Starts a run in `cid` and hands back the raw SSE `onEvent` emitter.
 *  `finishes: true` makes the mock resolve on the first terminal event, the
 *  way a real SSE closes after `completed`. */
async function startRun(
  view: AgentConversation,
  assistantId: string,
  { finishes = false }: { finishes?: boolean } = {},
): Promise<{ emit: (e: AgentStreamEvent) => void; done: Promise<void> }> {
  let emit!: (event: AgentStreamEvent) => void;
  h.streamAgentMessage.mockImplementation(async (_id, _payload, onEvent, signal) => {
    await new Promise<void>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
      emit = (event: AgentStreamEvent) => {
        onEvent(event);
        if (finishes && (event.type === "completed" || event.type === "error")) resolve();
      };
    });
  });
  let done!: Promise<void>;
  await act(async () => {
    done = ctx.box.result!.runStream({ conversation: view, assistantMessage: { id: assistantId }, streamPayload });
  });
  done.catch(() => undefined);
  return { emit, done };
}

const onScreenRow = (id: string): AgentMessage | undefined =>
  ctx.box.active?.messages.find((m) => m.id === id);
const onScreenContent = (id: string): string => onScreenRow(id)?.content ?? "";

describe("useAgentSession — streaming text loss (reproduction)", () => {
  // -------------------------------------------------------------------------
  // CONTROL — no interaction at all. Proves the pacing/budget arithmetic and
  // the leftover backfill are sound on their own, so a loss below can only
  // come from an interaction, not from frame timing.
  // -------------------------------------------------------------------------
  it("CONTROL: the same paced stream loses nothing when no interaction interrupts it", async () => {
    const cid = "c-control";
    const mId = "local-assistant-control";
    const view = conv(cid, [userQ("u-control", "q"), assistant(mId, "", "streaming")]);
    renderHarness(view);
    const { emit, done } = await startRun(view, mId, { finishes: true });

    act(() => {
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "completed", reason: "stop" });
    });
    await drain();
    await act(async () => { await done; });
    await drain();

    expect(onScreenContent(mId)).toBe(CHUNK.repeat(3));
    expect(onScreenRow(mId)?.state).toBe("complete");
  });

  // -------------------------------------------------------------------------
  // CHANNEL A — a conversation switch must not destroy queued leftovers.
  // selectConversation now calls drainPendingFlush (useAgentSession.ts), which
  // paints every queued delta onto the outgoing transcript in one pass instead
  // of emptying the queue (the old clearPendingFlush drop).
  //
  // Frame arithmetic note: the reveal layer is STREAM_REVEAL (step-capped
  // slicing, 12..24 chars per paint), so one frame paints a bounded prefix of
  // the first delta and parks the rest — the assertions below state the
  // invariants against those bounds instead of the retired 70-char fingerprint.
  // -------------------------------------------------------------------------
  it("CHANNEL A: a switch drains the queued tail onto the outgoing transcript, so the painted reply is complete", async () => {
    const cid = "c-switch";
    const mId = "local-assistant-switch";
    const view = conv(cid, [userQ("u-switch", "q"), assistant(mId, "", "streaming")]);
    renderHarness(view);
    const { emit, done } = await startRun(view, mId);

    // Frame 1: three deltas arrive inside a single frame, so only a bounded
    // slice of the front piece paints and the rest is parked as leftovers.
    act(() => {
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "text_delta", delta: CHUNK });
    });
    await stepFrame();
    const painted = onScreenContent(mId);
    expect(painted.length).toBeGreaterThanOrEqual(1);
    expect(painted.length).toBeLessThan(CHUNK.length);
    expect(painted).toBe(CHUNK.slice(0, painted.length));
    expect(armedFrames()).toBe(1); // the leftover backfill re-armed one flush

    // The switch — exactly what selectConversation does before it moves on.
    act(() => {
      ctx.box.result!.drainPendingFlush();
    });
    await drain();

    // The queued tail landed on the outgoing transcript in the same pass:
    // everything the run received is on screen right now, before any
    // re-hydration (strictly stronger than the old acceptance, which could
    // only see the recovered content after switching back).
    expect(onScreenContent(mId)).toBe(CHUNK.repeat(3));
    // (1) Nothing is left to paint: the queue is empty and not re-armed.
    expect(armedFrames()).toBe(0);
    // (2) NOT the `if (!row) return` branch: the row the run writes into is
    //     still on screen, so the flush would have found it.
    expect(onScreenRow(mId)).toBeDefined();
    // (3) Transport + enqueue are fine: all three deltas are in the session's
    //     event buffer, which is what a re-entry replays from.
    const session = ctx.box.result!.getSession(cid)!;
    expect(session.events.filter((e) => e.type === "text_delta")).toHaveLength(3);

    const beforeSwitch = onScreenContent(mId);

    // Re-hydration, the way switching back does it: the server transcript
    // (assistant row under the server's own id — the pre-fix run-engine.ts:927
    // never adopted the client id; see the CHANNEL B test for the fixed id)
    // folded in, then the buffered session replayed over it.
    const serverView = conv(cid, [
      userQ("u-switch", "q"),
      assistant("message-server-uuid", CHUNK, "streaming"),
    ]);
    const live = Boolean(ctx.box.result!.getSession(cid) && !ctx.box.result!.getSession(cid)!.done);
    act(() => {
      ctx.box.adoptServerSnapshot(serverView, live);
      ctx.box.result!.replayBackgroundSession(ctx.box.result!.getSession(cid)!, serverView);
    });
    const afterRehydrate = onScreenContent(mId);

    // The re-hydrated transcript still carries the full reply.
    expect(afterRehydrate.length).toBe(CHUNK.length * 3);

    // Acceptance criterion: nothing the run received may be dropped between the
    // queue and the screen, so the painted transcript and the re-hydrated
    // transcript must be identical.
    expect(beforeSwitch).toBe(afterRehydrate);

    ctx.box.result!.stopStreaming();
    await act(async () => { await done.catch(() => undefined); });
    await drain();
  });

  // -------------------------------------------------------------------------
  // CHANNEL B — the `if (!row) return` drop (useAgentSession.ts) once a
  // server snapshot adoption has replaced the optimistic local assistant row.
  // The fix makes the server adopt clientAssistantMessageId, so the snapshot
  // row keeps the client id and the live row is never renamed out from under
  // the stream. This test simulates the fixed server.
  // -------------------------------------------------------------------------
  it("CHANNEL B: a snapshot that adopts the client assistant id keeps the live row, so later deltas fold into it", async () => {
    const cid = "c-snapshot";
    const mId = "local-assistant-snapshot";
    const view = conv(cid, [userQ("u-snapshot", "q"), assistant(mId, "", "streaming")]);
    renderHarness(view);
    const { emit, done } = await startRun(view, mId);

    act(() => { emit({ type: "text_delta", delta: CHUNK }); });
    await drain();
    expect(onScreenContent(mId)).toBe(CHUNK);
    const session = ctx.box.result!.getSession(cid)!;

    // A snapshot arrives whose assistant row carries the client's id — what
    // the fixed server now publishes (clientAssistantMessageId adoption in
    // run-engine.ts). keepAheadTranscript maps over server.messages and finds
    // the live row by id, so it stays in place instead of being dropped.
    const serverView = conv(cid, [
      userQ("u-snapshot", "q"),
      assistant(mId, CHUNK, "streaming"),
    ]);
    act(() => { ctx.box.adoptServerSnapshot(serverView, true); });
    // The adoption kept the client row id: the live row was not renamed.
    expect(onScreenRow(mId)).toBeDefined();

    // The run keeps writing to the session's message id, which still has a
    // row to fold into.
    act(() => { emit({ type: "text_delta", delta: CHUNK }); emit({ type: "text_delta", delta: CHUNK }); });
    await drain();

    // The queue is empty afterwards and nothing was re-armed: both deltas were
    // consumed AND applied — the row-id lookup found the live row.
    expect(armedFrames()).toBe(0);
    const onScreen = ctx.box.active!.messages.find((m) => m.role === "assistant")!;
    expect(session.events.filter((e) => e.type === "text_delta")).toHaveLength(3);

    // Acceptance criterion: every delta the run received must reach the screen
    // — the tail must not be swallowed by a row-id lookup that found nothing.
    expect(onScreen.content).toBe(CHUNK.repeat(3));

    ctx.box.result!.stopStreaming();
    await act(async () => { await done.catch(() => undefined); });
    await drain();
  });

  // -------------------------------------------------------------------------
  // Why channel B does not reach the user on its own: every snapshot-adoption
  // site that can run against a live local run is gated off while the run
  // holds `streaming`. The background pickup poll is the only in-hook fetcher
  // and it stays disarmed for the whole life of the run.
  // -------------------------------------------------------------------------
  it("REACHABILITY: the background pickup poll never fetches while a local run streams, so no snapshot can land mid-run", async () => {
    const cid = "c-gate";
    const mId = "local-assistant-gate";
    const view = conv(cid, [userQ("u-gate", "q"), assistant(mId, "", "streaming")]);
    renderHarness(view);
    // The hook arms the pickup poll on mount (the newest row is a streaming
    // assistant and nothing is streaming yet), so the mount-time tick is
    // expected; only fetches *during* the run are what must not happen.
    await drain();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    h.agentConversation.mockClear();

    const { emit, done } = await startRun(view, mId);

    act(() => {
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "text_delta", delta: CHUNK });
    });
    await drain();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // `pollNeedsPickup` is true here (newest row is a streaming assistant), so
    // the only thing keeping the poll disarmed is the `streaming` gate.
    expect(ctx.box.result!.streaming).toBe(true);
    expect(h.agentConversation).not.toHaveBeenCalled();

    ctx.box.result!.stopStreaming();
    await act(async () => { await done.catch(() => undefined); });
    await drain();
  });
});
