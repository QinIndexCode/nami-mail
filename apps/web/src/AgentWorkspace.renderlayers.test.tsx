// @vitest-environment jsdom
/**
 * Render-layer guards for the streaming transcript. None of these are about
 * what the reply says — they pin the per-frame cost of showing it:
 *
 * 1. The scrubber's marker measurement must not re-run for a streamed token.
 *    It used to depend on the user-id ARRAY, whose identity streaming replaces
 *    every frame, so each token paid one getBoundingClientRect per user row
 *    plus the second root render its setState forced. It now depends on the
 *    joined id key, which a token never changes.
 * 2. The stick-to-bottom scroll must be written in the LAYOUT phase. A passive
 *    effect runs after the browser has already painted the frame, so every
 *    token painted at the previous offset and the transcript visibly crawled
 *    one frame (~16ms) behind. The probe below reads the transcript from a
 *    PASSIVE effect in a sibling rendered BEFORE the workspace, in the same
 *    commit that carries the streamed frame: React flushes every layout effect
 *    for the tree before any passive effect, and then runs the passive effects
 *    in tree order — so the probe sees the new offset only if the workspace
 *    wrote it in its layout phase, and never sees a passive-phase write (its
 *    own passive effect runs first).
 * 3. (agent/AgentMessageRow.memo.test.tsx) the agent transcript's
 *    onOpenMessage prop must keep its identity, or every row's markdown is
 *    re-parsed on every mailbox refresh.
 *
 * The tests never assume how many frames a delta takes to reveal: each one
 * steps frames until the transcript has actually committed, and asserts on
 * the frames that committed. That keeps them tied to the render layer (the
 * subject here) rather than to the reveal-pacing constants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { AgentBootstrap, AgentConversation, AgentProviderSummary, AgentStreamEvent } from "./agentTypes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
} as unknown as MediaQueryList);
window.matchMedia = window.matchMedia ?? matchMedia;

const h = vi.hoisted(() => {
  const provider: AgentProviderSummary = {
    id: "provider-1",
    label: "Local",
    kind: "openai-compatible",
    endpoint: "http://localhost:11434",
    model: "m",
    timeoutMs: 90_000,
    apiKeyConfigured: true,
    configured: true,
    cloud: false,
    cloudContentConsent: false,
    streaming: true,
    vision: false,
  };
  const bootstrap: AgentBootstrap = {
    enabled: true,
    configured: true,
    providers: [provider],
    defaultProviderId: "provider-1",
    conversations: [{ id: "conv-a", title: "Conversation A", preview: "", updatedAt: "2026-08-10T00:00:00.000Z" }],
  };
  // One completed turn, so the transcript has a user row to anchor a marker to
  // and the background pickup poll stays disarmed for the whole test.
  const convA: AgentConversation = {
    id: "conv-a",
    title: "Conversation A",
    preview: "",
    updatedAt: "2026-08-10T00:00:00.000Z",
    providerId: "provider-1",
    scope: { mode: "all_accounts", accountIds: [], messageIds: [] },
    messages: [
      { id: "user-a-1", role: "user", content: "earlier question", createdAt: "2026-08-10T00:00:00.000Z", state: "complete", citations: [], toolActivities: [] },
      { id: "assistant-a-1", role: "assistant", content: "earlier answer", createdAt: "2026-08-10T00:00:01.000Z", state: "complete", citations: [], toolActivities: [] },
    ],
  };
  return { provider, bootstrap, convA };
});

vi.mock("./api", () => ({
  ApiError: class ApiError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  },
  api: {
    agentBootstrap: vi.fn(async () => h.bootstrap),
    agentConversation: vi.fn(async () => h.convA),
    streamAgentMessage: vi.fn(async () => new Promise(() => undefined)),
    cancelAgentRun: vi.fn(async () => ({ ok: true })),
    createAgentConversation: vi.fn(async () => h.convA),
    agentConversations: vi.fn(async () => ({ items: h.bootstrap.conversations })),
    renameAgentConversation: vi.fn(async () => h.bootstrap.conversations[0]!),
    deleteAgentConversation: vi.fn(async () => ({ ok: true })),
    revokeAgentMessage: vi.fn(async () => ({ ok: true, conversation: h.convA })),
    uploadOutboundAttachment: vi.fn(async () => ({ ok: true })),
    agentMemoryCreate: vi.fn(async () => ({ ok: true })),
    agentProviders: vi.fn(async () => ({ items: [h.provider], defaultProviderId: "provider-1" })),
    agentMcpServers: vi.fn(async () => ({ items: [] })),
    messages: vi.fn(async () => ({ items: [], total: 0, pageSize: 10, nextCursor: null })),
  },
}));

import { api } from "./api";
import { I18nProvider } from "./i18n";
import AgentWorkspace from "./AgentWorkspace";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** One delta; long enough that no pacing constant reveals it in a single
 *  character, short enough to be a realistic model token batch. */
const CHUNK = `${"A".repeat(120)}|`;

// ---------------------------------------------------------------------------
// Controlled frame queue — the reveal is frame-batched, so a test owns the clock
// ---------------------------------------------------------------------------
let rafQueue: Map<number, FrameRequestCallback>;
let nextRafId = 0;
/** Rebuilt on every stepped frame (a fresh element: React bails out of a
 *  subtree handed the identical element reference) so the probe commits in the
 *  same render pass as the streamed frame it is measuring. */
let buildTree: () => ReactElement;

async function stepFrame(): Promise<void> {
  await act(async () => {
    const frames = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of frames) cb(performance.now());
    root.render(buildTree());
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

/** Every scrollTop write on any element, since the counter was last reset. */
let scrollWrites: number[] = [];
/** What a PASSIVE effect saw, once per commit. Layout-phase writes are already in. */
let passiveObservations: number[] = [];
/** getBoundingClientRect calls — the marker measurement's per-frame cost. */
let rectCalls = 0;

const SCROLL_HEIGHT_BASE = 4000;
/** The transcript's document height. Grown every stepped frame, so the offset
 *  each frame pins to is unique: a probe that sees this frame's value knows the
 *  write already happened, and one that sees the previous frame's value knows it
 *  did not. */
let scrollHeight = SCROLL_HEIGHT_BASE;
/** Frames a delta may take to reach the screen before the harness gives up. */
const MAX_FRAMES = 40;

const originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
const originalRect = Element.prototype.getBoundingClientRect;

/** Passive-effect probe, rendered BEFORE the workspace: React flushes every
 *  layout effect for the tree first, then the passive effects in tree order, so
 *  this sibling's effect runs before a passive scroll write could have landed. */
function PassiveScrollProbe() {
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".agent-transcript");
    passiveObservations.push(el ? el.scrollTop : -1);
  });
  return null;
}

type Frame = {
  /** Passive-effect observations: one per committed render of the probe. */
  commits: number[];
  /** scrollTop writes during this frame. */
  writes: number[];
  /** Marker measurements during this frame. */
  rects: number;
  /** The transcript height this frame pinned to. */
  height: number;
  /** Rendered length of the live assistant row: proof the frame painted text. */
  textLength: number;
};

const setComposer = (text: string) => {
  const textarea = container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")
    ?? container.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) throw new Error("composer textarea not found");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("no textarea value setter");
  act(() => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const clickSend = () => {
  const send = container.querySelector<HTMLButtonElement>(".agent-send-button");
  if (!send) throw new Error("send button not found");
  if (send.disabled) throw new Error("send button is disabled");
  act(() => {
    send.click();
  });
};

const transcript = (): HTMLElement => {
  const el = container.querySelector<HTMLElement>(".agent-transcript");
  if (!el) throw new Error("transcript not found");
  return el;
};

const renderWorkspace = async () => {
  buildTree = () => (
    <>
      <PassiveScrollProbe />
      <I18nProvider>
        <AgentWorkspace
          accounts={[]}
          messages={[]}
          onClose={() => undefined}
          onOpenMessage={() => undefined}
          demoMode={false}
          preloadedBootstrap={h.bootstrap}
          agentAccessLevel="send-confirmed"
          onAgentAccessLevelChange={() => undefined}
        />
      </I18nProvider>
    </>
  );
  await act(async () => {
    root.render(buildTree());
  });
  await flush();
};

/** Rendered length of the live (newest) assistant row. */
const liveAssistantText = (): number => {
  const rows = container.querySelectorAll<HTMLElement>(".agent-message.assistant");
  return rows[rows.length - 1]?.textContent?.length ?? 0;
};

/** Feeds one assistant delta and steps frames until the transcript has actually
 *  committed, recording what each frame cost. */
async function streamOneDelta(emit: () => void): Promise<Frame[]> {
  const frames: Frame[] = [];
  act(() => {
    emit();
  });
  for (let frame = 0; frame < MAX_FRAMES; frame += 1) {
    // A fresh height per frame: streaming grows the transcript, so the offset
    // the workspace must pin to grows with it.
    scrollHeight += 100;
    passiveObservations = [];
    scrollWrites = [];
    rectCalls = 0;
    await stepFrame();
    frames.push({
      commits: [...passiveObservations],
      writes: [...scrollWrites],
      rects: rectCalls,
      height: scrollHeight,
      textLength: liveAssistantText(),
    });
    if (frames[frames.length - 1]!.commits.length > 0 && liveAssistantText() > 0) break;
  }
  return frames;
}

/** Frames that actually put streamed text on screen. */
const painted = (frames: Frame[]): Frame[] => frames.filter((frame) => frame.commits.length > 0 && frame.textLength > 0);

const captureStream = () => {
  let emit!: (event: AgentStreamEvent) => void;
  (api as unknown as { streamAgentMessage: unknown }).streamAgentMessage = vi.fn(
    async (_id: string, _payload: unknown, onEvent: (event: AgentStreamEvent) => void, signal: AbortSignal) => {
      emit = onEvent;
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  );
  return () => emit({ type: "text_delta", delta: CHUNK });
};

beforeEach(() => {
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => undefined,
      get length() {
        return store.size;
      },
    },
  });
  // jsdom performs no layout: scrollHeight is always 0, so a scrollTop write has
  // nothing to scroll to and nothing to observe. Give every element a document
  // height and record every scrollTop write.
  Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
  const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return originalScrollTop.get!.call(this);
    },
    set(this: Element, value: number) {
      scrollWrites.push(value);
      originalScrollTop.set!.call(this, value);
    },
  });
  Element.prototype.getBoundingClientRect = function countingGetBoundingClientRect(this: Element) {
    rectCalls += 1;
    return originalRect.call(this);
  };
  scrollWrites = [];
  passiveObservations = [];
  rectCalls = 0;
  scrollHeight = SCROLL_HEIGHT_BASE;
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollHeight) Object.defineProperty(Element.prototype, "scrollHeight", originalScrollHeight);
  Element.prototype.getBoundingClientRect = originalRect;
  (api as unknown as { streamAgentMessage: unknown }).streamAgentMessage = vi.fn(async () => new Promise(() => undefined));
});

describe("AgentWorkspace — per-frame cost of a streamed reply", () => {
  it("a streamed token re-measures no user-message marker (no second root render)", async () => {
    const emit = captureStream();
    await renderWorkspace();
    expect(container.querySelector(".agent-message.user")).not.toBeNull();

    setComposer("please summarise");
    clickSend();
    await flush();
    await flush();
    // Positive control: adding a user row does change the id key, so the
    // measurement really does run when an anchor can have moved — without this
    // the assertions below would pass on a probe that measures nothing.
    expect(rectCalls).toBeGreaterThan(0);
    expect(container.querySelectorAll(".agent-message.user").length).toBe(2);

    // From here only assistant text arrives: the user set is frozen, so no
    // frame may re-measure. Each delta below is checked to have reached the
    // screen, so the frames are real commits rather than idle ones.
    for (let delta = 0; delta < 2; delta += 1) {
      const frames = await streamOneDelta(emit);
      expect(painted(frames).length).toBeGreaterThan(0);
      expect(frames.reduce((total, frame) => total + frame.rects, 0)).toBe(0);
    }
  });

  it("pins the transcript in the layout phase, before the frame paints", async () => {
    const emit = captureStream();
    await renderWorkspace();

    setComposer("please summarise");
    clickSend();
    await flush();
    await flush();

    const frames = await streamOneDelta(emit);
    const committed = painted(frames);
    expect(committed.length).toBeGreaterThan(0);
    for (const frame of committed) {
      expect(frame.writes).toContain(frame.height);
      // The probe's effect runs in the passive phase, after the whole layout
      // phase: it can only see this frame's offset if the write already
      // happened. A passive (post-paint) write would still read the previous
      // frame's offset here, because the probe's effect runs first.
      expect(frame.commits[frame.commits.length - 1]).toBe(frame.height);
    }
  });

  it("still stops following once the user scrolls up", async () => {
    const emit = captureStream();
    await renderWorkspace();

    setComposer("please summarise");
    clickSend();
    await flush();
    await flush();

    // A manual scroll away from the bottom (half the transcript short of it)
    // must disarm stick-to-bottom for good.
    const el = transcript();
    act(() => {
      el.scrollTop = scrollHeight / 2;
      el.dispatchEvent(new Event("scroll"));
    });
    await flush();

    const frames = await streamOneDelta(emit);
    expect(painted(frames).length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.writes).not.toContain(frame.height);
    }
  });
});
