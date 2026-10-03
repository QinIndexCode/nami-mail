// @vitest-environment jsdom
/**
 * Component-level test for the createConversation early-return branch.
 *
 * When the user starts a new conversation but no provider is selectable, the
 * handler abandons the switch and the user STAYS on the current conversation.
 * The queued frame-batched deltas of a live reply therefore belong to a
 * transcript that remains on screen: the switch path must DRAIN them onto it
 * (drainPendingFlush) instead of dropping them (the old clearPendingFlush), or
 * the parked tail of the running reply silently disappears from the very
 * transcript the user is still looking at.
 *
 * The no-provider state is reached through the real UI path: with a live run
 * on screen, the provider settings pane is opened (it refetches the provider
 * list on open and pushes it into the panel) while the mock returns a provider
 * list with no configured entry and a different id, so selectedProvider
 * resolves to nothing.
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
    ],
  };
  // conv-a starts with a COMPLETE turn, so the background pickup poll stays
  // disarmed for the whole test.
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

/** One delta per token; 121 chars > any single-paint budget. */
const CHUNK = `${"A".repeat(120)}|`;

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

/** Reads the rendered assistant row's exact content through its copy affordance. */
const renderedAssistantContent = (): string => {
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

const renderWorkspace = async (providerListVersion = 0) => {
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
          providerListVersion={providerListVersion}
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
});

describe("AgentWorkspace — createConversation's early return keeps the drained reply on screen", () => {
  it("drains the queued tail onto the transcript the user stays on when no provider is selectable", async () => {
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

    // Open conv-a and start a turn in it.
    clickRow("Conversation A");
    await flush();
    await flush();
    setComposer("please summarise");
    clickSend();
    await flush();
    await flush();

    // Three deltas arrive inside a single frame: a bounded slice paints, the
    // rest is parked in the pacing queue.
    act(() => {
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "text_delta", delta: CHUNK });
      emit({ type: "text_delta", delta: CHUNK });
    });
    await stepFrame();
    const beforeCreate = renderedAssistantContent();
    expect(beforeCreate.length).toBeGreaterThanOrEqual(1);
    expect(beforeCreate.length).toBeLessThan(CHUNK.length);
    expect(rafQueue.size).toBe(1); // the parked leftovers re-armed one flush

    // Make the panel's selected provider unresolvable through the real path:
    // the settings models panel edited the list, so App bumps
    // providerListVersion and the workspace refetches and folds it in. The
    // mocked list has no configured entry and a different id, so
    // selectedProvider resolves to nothing.
    (api as unknown as { agentProviders: unknown }).agentProviders = vi.fn(async () => ({
      items: [{ ...h.provider, id: "provider-x", configured: false, apiKeyConfigured: false }],
      defaultProviderId: null,
    }));
    await renderWorkspace(1);

    // The "new conversation" click: createConversation drains the queued tail
    // onto the outgoing transcript, then hits the early return (no provider)
    // and stays on this conversation.
    const newButton = container.querySelector<HTMLButtonElement>(".agent-new-conversation-button");
    if (!newButton) throw new Error("new conversation button not found");
    act(() => { newButton.click(); });
    await flush();
    await drainAllFrames();

    // The user is still on Conversation A and the reply is complete on screen.
    expect(container.querySelector(".agent-conversation-title h1")?.textContent).toContain("Conversation A");
    expect(renderedAssistantContent()).toBe(CHUNK.repeat(3));
  });
});

async function drainAllFrames(): Promise<void> {
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
