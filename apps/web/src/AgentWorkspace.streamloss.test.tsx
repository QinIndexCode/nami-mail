// @vitest-environment jsdom
/**
 * Component-level reproduction of the confirmed agent-reply text-loss defect,
 * driven through the real AgentWorkspace panel (not the hook in isolation).
 *
 * Channel: the conversation-switch path used to call clearPendingFlush
 * (apps/web/src/agent/useAgentSession.ts), which AgentWorkspace.selectConversation
 * ran as its second statement — after clearLiveRunIndicators and before it moved
 * the transcript over. It emptied pendingStreamPiecesRef outright, so any delta
 * that the pacing budget had parked in the queue never reached the screen. The
 * switch now calls drainPendingFlush, which paints the whole queue onto the
 * outgoing transcript in one pass before the view swaps.
 *
 * Determinism: requestAnimationFrame / cancelAnimationFrame are stubbed with a
 * frame queue that honours cancellation, and frames are stepped one at a time.
 * Under the STREAM_REVEAL layer one paint reveals a bounded slice (>= 1 char,
 * <= stepCharsCeiling) of the front delta, and every delta below is 121 chars,
 * so a frame can never paint a whole delta, let alone the whole reply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
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
    conversations: [
      { id: "conv-a", title: "Conversation A", preview: "", updatedAt: "2026-08-10T00:00:00.000Z" },
      { id: "conv-b", title: "Conversation B", preview: "", updatedAt: "2026-08-10T00:00:00.000Z" },
    ],
  };
  // conv-a starts with a COMPLETE turn, so the background pickup poll stays
  // disarmed for the whole test: the only thing that may move the transcript is
  // the panel's own conversation switching.
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
  const convB: AgentConversation = {
    id: "conv-b",
    title: "Conversation B",
    preview: "",
    updatedAt: "2026-08-10T00:00:00.000Z",
    providerId: "provider-1",
    scope: { mode: "all_accounts", accountIds: [], messageIds: [] },
    messages: [],
  };
  return { provider, bootstrap, convA, convB };
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
    agentConversation: vi.fn(async (id: string) => (id === "conv-a" ? h.convA : h.convB)),
    streamAgentMessage: vi.fn(async () => new Promise(() => undefined)),
    cancelAgentRun: vi.fn(async () => ({ ok: true })),
    createAgentConversation: vi.fn(async () => h.convB),
    agentConversations: vi.fn(async () => ({ items: h.bootstrap.conversations })),
    renameAgentConversation: vi.fn(async () => h.bootstrap.conversations[0]!),
    deleteAgentConversation: vi.fn(async () => ({ ok: true })),
    revokeAgentMessage: vi.fn(async () => ({ ok: true, conversation: h.bootstrap.conversations[0]! })),
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

/** One delta per token; 121 chars > the 70-char per-frame reveal ceiling. */
const CHUNK = `${"A".repeat(120)}|`;

// ---------------------------------------------------------------------------
// Controlled frame queue — cancellation is honoured (that is the point)
// ---------------------------------------------------------------------------
let rafQueue: Map<number, FrameRequestCallback>;
let nextRafId = 0;

async function stepFrame(): Promise<void> {
  await act(async () => {
    const frames = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of frames) cb(performance.now());
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

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

const clickRow = (title: string) => {
  const row = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-conversation-row > button:first-child"))
    .find((button) => button.textContent?.includes(title));
  if (!row) throw new Error(`conversation row for "${title}" not found`);
  act(() => { row.click(); });
};

const setComposer = (text: string) => {
  const textarea = container.querySelector<HTMLTextAreaElement>(".agent-composer textarea") ?? container.querySelector<HTMLTextAreaElement>("textarea");
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
  act(() => { send.click(); });
};

/** Reads the rendered assistant row's exact content through its copy affordance
 *  (CopyMessageButton hands the row's raw `content` to the clipboard), so the
 *  probe is immune to markdown/whitespace reshaping in the DOM. */
const renderedAssistantContent = (): string => {
  // The newest assistant row is the live reply (earlier turns stay above it).
  const rows = Array.from(container.querySelectorAll<HTMLElement>(".agent-message.assistant"));
  const row = rows[rows.length - 1];
  if (!row) throw new Error("assistant row not found");
  const copy = row.querySelector<HTMLButtonElement>("button.copy");
  if (!copy) throw new Error("assistant row has no copy button (empty content)");
  let captured = "";
  const writeText = navigator.clipboard.writeText;
  Object.defineProperty(navigator.clipboard, "writeText", {
    configurable: true,
    value: (value: string) => { captured = value; return Promise.resolve(); },
  });
  try {
    act(() => { copy.click(); });
  } finally {
    Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: writeText });
  }
  return captured;
};

const renderWorkspace = async () => {
  await act(async () => {
    root.render(
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
      </I18nProvider>,
    );
  });
  await flush();
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
      get length() { return store.size; },
    },
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => undefined },
  });
  rafQueue = new Map();
  nextRafId = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    nextRafId += 1;
    rafQueue.set(nextRafId, cb);
    return nextRafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { rafQueue.delete(id); });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  (api as unknown as { agentConversation: unknown }).agentConversation = vi.fn(async (id: string) => (id === "conv-a" ? h.convA : h.convB));
  (api as unknown as { streamAgentMessage: unknown }).streamAgentMessage = vi.fn(async () => new Promise(() => undefined));
});

describe("AgentWorkspace — streaming reply survives a conversation switch", () => {
  it("CHANNEL A (component): selectConversation's drain paints the parked tail; the re-hydrated reply is complete", async () => {
    let emit!: (event: AgentStreamEvent) => void;
    (api as unknown as { streamAgentMessage: unknown }).streamAgentMessage = vi.fn(
      async (_id: string, _payload: unknown, onEvent: (event: AgentStreamEvent) => void, signal: AbortSignal) => {
        emit = onEvent;
        await new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    );

    await renderWorkspace();

    // Start a turn in conv-a; the panel creates the optimistic local rows.
    setComposer("please summarise");
    clickSend();
    await flush();
    await flush();

    // Three deltas arrive inside a single frame: a bounded slice of the front
    // one paints, the rest is parked in the pacing queue (STREAM_REVEAL step
    // cap) and re-arms exactly one flush.
    act(() => {
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "text_delta", delta: CHUNK });
    });
    await stepFrame();
    const beforeSwitch = renderedAssistantContent();
    expect(beforeSwitch.length).toBeGreaterThanOrEqual(1);
    expect(beforeSwitch.length).toBeLessThan(CHUNK.length);
    expect(rafQueue.size).toBe(1); // the parked leftovers re-armed one flush

    // --- the switch. selectConversation runs clearPendingFlush() at :1078.
    clickRow("Conversation B");
    await flush();
    await drain();
    expect(container.querySelector(".agent-conversation-title h1")?.textContent).toContain("Conversation B");
    // The parked frame is gone: nothing will ever paint those two deltas.
    expect(rafQueue.size).toBe(0);

    // Re-hydration on the way back: the server transcript now carries the whole
    // reply, and the buffered session replays over it (in place, under the
    // session's own assistant id).
    const serverConvA: AgentConversation = {
      ...h.convA,
      messages: [
        ...h.convA.messages,
        { id: "user-local-1", role: "user", content: "please summarise", createdAt: "2026-08-10T00:00:00.000Z", state: "complete", citations: [], toolActivities: [] },
        { id: "message-server-uuid", role: "assistant", content: CHUNK.repeat(3), createdAt: "2026-08-10T00:00:01.000Z", state: "streaming", citations: [], toolActivities: [] },
      ],
    };
    (api as unknown as { agentConversation: unknown }).agentConversation = vi.fn(
      async (id: string) => (id === "conv-a" ? serverConvA : h.convB),
    );

    clickRow("Conversation A");
    await flush();
    await flush();
    const afterRehydrate = renderedAssistantContent();

    // The reply was still mid-stream when the switch happened (only a bounded
    // slice had painted); re-entry must carry everything the run received.
    expect(beforeSwitch.length).toBeLessThan(afterRehydrate.length);

    // Acceptance criterion: no delta the run received may be discarded between
    // the queue and the screen. At component level there is no read point that
    // can observe the drain's write to the outgoing transcript (the shell swap
    // replaces it in the same commit), so the end-to-end invariant lands on the
    // re-hydrated transcript: it must equal everything the run received. The
    // queue-level half — the parked leftovers already painted onto the outgoing
    // transcript BEFORE the swap — is pinned by the hook-level CHANNEL A test
    // (drainPendingFlush called directly, old transcript still observable),
    // whose assertion is strictly stronger than the old equality.
    expect(afterRehydrate).toBe(CHUNK.repeat(3));
  });
});
