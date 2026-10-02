// @vitest-environment jsdom
/**
 * Reveal-pacing tests for useAgentSession — and the reference for *why* the
 * pacing layer is shaped the way it is.
 *
 * THE DEFECT was a cadence defect, not a text defect. One rule, "reveal
 * `rate * dt` characters, at most `STREAM_PACING_MAX_RATE`", could not satisfy
 * two requirements at once:
 *
 *   - the 280 chars/sec ceiling sat below a modern model's arrival rate
 *     (500-1000 chars/sec), so the pending queue grew linearly and without
 *     bound;
 *   - the queue was then emptied by `hasTerminal ? Infinity : budget`, i.e. the
 *     frame that carried `completed` poured the entire backlog into one paint.
 *
 * Measured on a 2000-char reply arriving at 500 chars/sec: **1036 characters
 * (52% of the reply) in a single frame**, and 2276 for a 3000-char reply at
 * 1000 chars/sec. That is the "crawls, then suddenly explodes" report. The
 * steady state before the terminal was equally bad in the other direction: the
 * reveal dribbled out at the 280 chars/sec ceiling while the backlog grew.
 *
 * While the window was hidden it was worse. `armStreamFlush` cleared and
 * re-armed the 250ms fallback timer on *every* call, and enqueueStreamPiece
 * calls it per delta, so while text kept arriving the timer never reached its
 * deadline: **0 characters were ever revealed while hidden**, the whole hidden
 * reply sat in the queue, and all of it landed on the first visible frame. The
 * comment claimed a heartbeat; the code was a debounce.
 *
 * THE SHAPE OF THE FIX (STREAM_REVEAL, in useAgentSession.ts) is two
 * independent limits plus three smaller corrections:
 *
 *   THROUGHPUT  rateMin..rateMax (24..1200 chars/sec) follows the model's
 *               arrival rate, so the queue does not grow while text streams.
 *   STEP        stepChars..stepCharsCeiling (12..24 chars per PAINT) caps a
 *               single frame, so a fast stream still ticks over a dozen
 *               characters instead of jumping. A longer delta is *sliced* and
 *               its tail re-queued — `messageWithEvent` is a pure string append,
 *               so slicing needs no new event type and changes no characters.
 *   CATCH-UP    backlog / catchUpSeconds, so a backlog the model stopped
 *               feeding (tool call, thinking pause, terminal tail) drains at a
 *               sane rate instead of collapsing onto the rate floor.
 *   TERMINAL    a `completed`/`error` event is applied in the frame it arrives
 *               even when characters are queued behind it. That keeps the
 *               original intent (the row reaches its final state at once, so it
 *               does not sit in "streaming", the pickup poll does not re-arm
 *               against it, the sidebar does not blink) without the dump: the
 *               remaining characters drain at the same bounded step afterwards.
 *   HIDDEN      the 250ms fallback is a heartbeat (armed only when none is
 *               pending), and one hidden tick may reveal up to
 *               `rateMax * dtClampMs / 1000` characters. The visible step
 *               ceiling — not the tick rate — is what bounds the restore frame.
 *   DETECTION   the rate low pass is time-based (1 - e^(-dt/tau), tau=160ms), so
 *               60 Hz and 144 Hz hunt identically, and the arrival window is
 *               clamped to the time since the last flush (a longer window counts
 *               characters this flush is not charged for). Detection lag drops
 *               from ~1s to ~0.2s, which removes the per-paragraph hump where
 *               the reveal restarted from the rate floor after every tool call.
 *
 * TWO SUBTLETIES THIS FILE EXISTS TO PIN DOWN:
 *
 *   1. The per-frame budget must be a whole number of characters, and it must be
 *      *rounded*, not floored. Slicing truncates, so a fractional budget drops up
 *      to a character per piece; and the rate estimate round-trips through
 *      `windowChars / (dt / 1000) * dt / 1000`, which lands a hair under the
 *      truth. Flooring turned a 20-char/frame budget into 19 every frame, and
 *      that 1-character shortfall compounded into exactly the linear backlog
 *      growth this layer exists to prevent.
 *   2. The step widening (`stepChars` -> `stepCharsCeiling` as the backlog grows
 *      towards `stepCatchupChars`) is what lets the reveal *catch up* rather than
 *      accumulate: a 1200 chars/sec arrival needs 20 characters per 60 Hz paint,
 *      and the widening reaches that at ~0.13s of lag instead of leaving the
 *      equilibrium half a second behind.
 *
 * MEASURED AFTER (this file, deterministic clock + controlled rAF):
 *   steady 1200 chars/s : per-paint p50 20, max 20; backlog plateaus at ~169
 *                         characters and stops growing; terminal frame ~17.
 *   terminal frame     : 7-18 characters, against 1036-2276 before.
 *   single 2000-char delta : sliced over ~85 paints, never released whole.
 *   hidden 1000 chars/s   : every 250ms tick drains; backlog bounded at ~1 tick;
 *                           restore frame <= stepCharsCeiling.
 *
 * Determinism: the clock, requestAnimationFrame and (for the hidden case)
 * setTimeout are all driven manually, so "how much fits in one frame" never
 * depends on wall-clock jitter. The invariants are asserted against
 * STREAM_REVEAL — the algorithm's own constants — rather than numbers copied
 * out of it, so they state the contract rather than the tuning.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { api } from "../api";
import type {
  AgentCitation,
  AgentConversation,
  AgentMessage,
  AgentStreamEvent,
  AgentToolActivity,
} from "../agentTypes";
import { STREAM_REVEAL, useAgentSession, type UseAgentSessionResult } from "./useAgentSession";

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
// Harness — the same injection-driven boundary AgentWorkspace uses
// ---------------------------------------------------------------------------
type Box = { result: UseAgentSessionResult | null; active: AgentConversation | null };
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
  return null;
}

function renderHarness(initial: AgentConversation | null): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  ctx = { activeIdRef: { current: initial ? initial.id : null }, box: { result: null, active: initial } };
  act(() => { root.render(<Harness />); });
}

const streamPayload = { content: "hello" } as unknown as Parameters<typeof api.streamAgentMessage>[1];

// ---------------------------------------------------------------------------
// Controlled clock + frame queue
// ---------------------------------------------------------------------------
const FRAME_MS = 1000 / 60;
let clockNow = 0;
let rafQueue: Map<number, FrameRequestCallback>;
let nextRafId = 0;

async function stepFrame(): Promise<void> {
  clockNow += FRAME_MS;
  await act(async () => {
    const frames = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of frames) cb(clockNow);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

const onScreen = (id: string): AgentMessage | undefined =>
  ctx.box.active?.messages.find((m) => m.id === id);

/** A visible-path paint while fake timers own the clock: advance it, then run
 *  whatever frames the pipeline armed (fake timers do not drive rAF). */
async function stepFrameOnFakeClock(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    const frames = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of frames) cb(performance.now());
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clockNow = 10_000;
  rafQueue = new Map();
  nextRafId = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clockNow);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    nextRafId += 1;
    rafQueue.set(nextRafId, cb);
    return nextRafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { rafQueue.delete(id); });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); await Promise.resolve(); });
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Starts a run and hands back the raw SSE emitter. */
async function startRun(view: AgentConversation, assistantId: string, { finishes = false } = {}): Promise<{ emit: (e: AgentStreamEvent) => void; done: Promise<void> }> {
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

const percentile = (xs: number[], p: number): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Streams `totalChars` of token-sized deltas into the assistant row at a fixed
 * per-frame arrival rate, one animation frame per delta batch, then completes
 * the run. Returns the per-paint reveal size, the per-paint backlog, and the
 * state of the row at the instant the terminal event landed.
 */
async function streamAndMeasure({
  conversationId,
  tokensPerFrame,
  charsPerToken,
  frames,
}: {
  conversationId: string;
  tokensPerFrame: number;
  charsPerToken: number;
  frames: number;
}) {
  const cid = conversationId;
  const mId = `m-${conversationId}`;
  const view = conv(cid, [userQ(`u-${cid}`, "q"), assistant(mId, "", "streaming")]);
  renderHarness(view);
  const { emit, done } = await startRun(view, mId, { finishes: true });
  const token = "x".repeat(charsPerToken);

  let arrived = 0;
  let previous = 0;
  const appends: number[] = [];
  const backlogs: number[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    // Nudge the arrival timestamp off the frame boundary: the flush measures
    // arrival over `[now - dt, now]`, and an arrival stamped exactly on that
    // edge would be pruned or kept by floating-point luck rather than by the
    // algorithm.
    clockNow += 0.5;
    for (let t = 0; t < tokensPerFrame; t += 1) {
      act(() => { emit({ type: "text_delta", delta: token }); });
      arrived += charsPerToken;
    }
    await stepFrame();
    const now = onScreen(mId)?.content.length ?? 0;
    appends.push(now - previous);
    backlogs.push(arrived - now);
    previous = now;
  }

  // The run ends. `completed` is delivered with flushNow, so it is folded in
  // the very next paint — the old code spent this frame pouring the entire
  // backlog instead.
  const charsAtTerminalFrameStart = previous;
  act(() => { emit({ type: "completed", reason: "stop" }); });
  await stepFrame();
  const atTerminalFrame = onScreen(mId)?.content.length ?? 0;
  const terminalFrameAppend = atTerminalFrame - charsAtTerminalFrameStart;
  const stateAtTerminalFrame = onScreen(mId)?.state;

  // Let the tail drain at the same bounded step, tracking it separately: these
  // are the paints that land *after* the run has already reached its terminal
  // state, which is where the old code dumped hundreds of characters at once.
  const total = arrived;
  const tailAppends: number[] = [];
  for (let guard = 0; guard < 5000; guard += 1) {
    if ((onScreen(mId)?.content.length ?? 0) >= total) break;
    const before = onScreen(mId)?.content.length ?? 0;
    await stepFrame();
    const after = onScreen(mId)?.content.length ?? 0;
    appends.push(after - before);
    tailAppends.push(after - before);
    backlogs.push(total - after);
  }
  await act(async () => { await done; });
  await stepFrame();

  return {
    mId,
    appends,
    tailAppends,
    backlogs,
    terminalFrameAppend,
    stateAtTerminalFrame,
    total,
    finalContent: onScreen(mId)?.content ?? "",
    finalState: onScreen(mId)?.state,
    revealedAtTerminalFrame: atTerminalFrame,
  };
}

describe("useAgentSession — reveal pacing", () => {
  it("streams a fast reply to completion without ever dumping a backlog into one paint", async () => {
    // 4 tokens x 5 chars per 60 Hz frame = 1200 chars/sec arrival, i.e. the
    // upper end of what a modern model emits; 200 frames = 12 000 chars.
    const r = await streamAndMeasure({ conversationId: "fast", tokensPerFrame: 4, charsPerToken: 5, frames: 200 });

    // No paint may exceed the per-paint step ceiling — this is the invariant
    // that replaces "the terminal frame flushes everything".
    expect(Math.max(...r.appends)).toBeLessThanOrEqual(STREAM_REVEAL.stepCharsCeiling);
    // The terminal frame specifically: it used to carry the whole backlog.
    expect(r.terminalFrameAppend).toBeLessThanOrEqual(STREAM_REVEAL.stepCharsCeiling);
    expect(r.terminalFrameAppend).toBeLessThan(r.total / 10);

    // The backlog must not grow linearly while text is still arriving. Compare
    // the first and last quarters of the stream.
    const quarter = Math.floor(r.backlogs.length / 4);
    expect(mean(r.backlogs.slice(3 * quarter))).toBeLessThanOrEqual(mean(r.backlogs.slice(0, quarter)) + 25);
    expect(Math.max(...r.backlogs)).toBeLessThan(2 * STREAM_REVEAL.stepCatchupChars);

    // Reveal is fine-grained throughout: a healthy stream paints most frames,
    // and the step distribution is tight rather than "0 most frames, one
    // enormous frame".
    expect(percentile(r.appends, 95)).toBeGreaterThanOrEqual(STREAM_REVEAL.stepChars);
    expect(percentile(r.appends, 95)).toBeLessThanOrEqual(STREAM_REVEAL.stepCharsCeiling);

    // Character-for-character the server's text, no loss and no reorder.
    expect(r.finalContent.length).toBe(r.total);
    expect(r.finalContent).toBe("x".repeat(r.total));
    expect(r.finalState).toBe("complete");
  });

  it("reaches the terminal state in the frame the run ends, while the tail keeps draining", async () => {
    const r = await streamAndMeasure({ conversationId: "terminal", tokensPerFrame: 6, charsPerToken: 8, frames: 60 });

    // The row is final immediately even though text is still queued — this is
    // what the old full flush bought, kept without the dump.
    expect(r.stateAtTerminalFrame).toBe("complete");
    // ...and the drain afterwards is bounded, so the run ends in "the last few
    // characters tick over, then it is stable" rather than "explosion".
    expect(r.tailAppends.length).toBeGreaterThan(0);
    expect(Math.max(...r.tailAppends)).toBeLessThanOrEqual(STREAM_REVEAL.stepCharsCeiling);
    expect(r.revealedAtTerminalFrame).toBeLessThan(r.total);
    expect(r.finalContent).toBe("x".repeat(r.total));
  });

  it("slices a single oversized delta instead of releasing it whole", async () => {
    const cid = "huge";
    const mId = "m-huge";
    const view = conv(cid, [userQ(`u-${cid}`, "q"), assistant(mId, "", "streaming")]);
    renderHarness(view);
    const { emit, done } = await startRun(view, mId, { finishes: true });

    // One delta carrying the whole reply — the case the old front-piece rule
    // waved through untouched.
    const huge = "y".repeat(2000);
    act(() => { emit({ type: "text_delta", delta: huge }); });

    let previous = 0;
    const appends: number[] = [];
    for (let frame = 0; frame < 400; frame += 1) {
      await stepFrame();
      const now = onScreen(mId)?.content.length ?? 0;
      appends.push(now - previous);
      previous = now;
      if (previous >= huge.length) break;
    }

    expect(Math.max(...appends)).toBeLessThanOrEqual(STREAM_REVEAL.stepCharsCeiling);
    // At the ceiling, 2000 chars need at least ~84 paints.
    expect(appends.length).toBeGreaterThanOrEqual(Math.ceil(huge.length / STREAM_REVEAL.stepCharsCeiling) - 1);
    expect(onScreen(mId)?.content).toBe(huge);

    act(() => { emit({ type: "completed", reason: "stop" }); });
    await stepFrame();
    await act(async () => { await done; });
  });

  it("keeps a slow stream moving and does not reorder or lose characters", async () => {
    // 1 char per frame = 60 chars/sec, far below the rate floor: the reveal
    // must follow the model, not run away from it.
    const r = await streamAndMeasure({ conversationId: "slow", tokensPerFrame: 1, charsPerToken: 1, frames: 120 });
    expect(r.finalContent).toBe("x".repeat(r.total));
    expect(r.finalState).toBe("complete");
    expect(Math.max(...r.appends)).toBeLessThanOrEqual(STREAM_REVEAL.stepCharsCeiling);
    // ~60 chars/sec of arrival means ~1 char per paint, never a flood.
    expect(percentile(r.appends, 95)).toBeLessThanOrEqual(3);
  });
});

describe("useAgentSession — hidden-window pacing", () => {
  it("drains the backlog on a heartbeat while hidden and never dumps it on restore", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const hidden: { value: boolean } = { value: true };
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden.value });

      const cid = "hidden";
      const mId = "m-hidden";
      const view = conv(cid, [userQ(`u-${cid}`, "q"), assistant(mId, "", "streaming")]);
      renderHarness(view);
      const { emit, done } = await startRun(view, mId, { finishes: true });

      // 1000 chars/sec of token-sized deltas while the window is hidden.
      const token = "z".repeat(4);
      const ticks = 20;
      const perTick = 250; // 4 chars per delta, 62-63 deltas per 250ms tick
      let arrived = 0;
      let revealed = 0;
      let previous = 0;
      let ticksWithAReveal = 0;
      const perTickReveal: number[] = [];
      let maxBacklog = 0;
      for (let tick = 0; tick < ticks; tick += 1) {
        for (let i = 0; i < perTick / token.length; i += 1) {
          act(() => { emit({ type: "text_delta", delta: token }); });
          arrived += token.length;
        }
        await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_REVEAL.hiddenTickMs); });
        const now = onScreen(mId)?.content.length ?? 0;
        const step = now - previous;
        perTickReveal.push(step);
        if (step > 0) ticksWithAReveal += 1;
        previous = now;
        revealed = now;
        maxBacklog = Math.max(maxBacklog, arrived - now);
      }

      // The heartbeat actually fires: the old debounce was re-armed by every
      // delta, so a hidden window with text flowing revealed *nothing*.
      expect(ticksWithAReveal).toBe(ticks);
      expect(revealed).toBeGreaterThan(0);
      // The backlog stays bounded — one tick's worth of arrival, not the whole
      // reply — because the hidden step is bounded by rateMax x dtClamp.
      const hiddenTickBudget = (STREAM_REVEAL.rateMax * STREAM_REVEAL.dtClampMs) / 1000;
      expect(Math.max(...perTickReveal)).toBeLessThanOrEqual(hiddenTickBudget);
      expect(maxBacklog).toBeLessThanOrEqual(hiddenTickBudget + perTick);

      // Restoring the window must not dump the remainder in one paint.
      hidden.value = false;
      const beforeRestore = previous;
      act(() => { emit({ type: "completed", reason: "stop" }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(FRAME_MS); });
      const restoreFrameAppend = (onScreen(mId)?.content.length ?? 0) - beforeRestore;
      expect(restoreFrameAppend).toBeLessThanOrEqual(STREAM_REVEAL.stepCharsCeiling);
      expect(onScreen(mId)?.state).toBe("complete");

      // And the tail still lands, character for character. Back on the visible
      // path the pipeline is on requestAnimationFrame again, which the fake
      // timers do not drive — so each drain step advances the fake clock and
      // then runs the armed frames by hand.
      for (let guard = 0; guard < 5000; guard += 1) {
        if ((onScreen(mId)?.content.length ?? 0) >= arrived) break;
        await stepFrameOnFakeClock();
      }
      expect(onScreen(mId)?.content).toBe("z".repeat(arrived));

      await act(async () => { await done; });
    } finally {
      vi.useRealTimers();
    }
  });
});
