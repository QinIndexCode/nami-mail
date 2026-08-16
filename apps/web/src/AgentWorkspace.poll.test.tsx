// @vitest-environment jsdom
// Regression coverage for the poll fold-in effect ("pickup" polling):
//  N1 — while the server keeps reporting the same in-flight (streaming) row,
//        the poll must hold its 2s interval instead of re-arming on every
//        snapshot fold-in (a continuous refetch loop).
//  N2 — stopGhostRun must permanently abandon the pickup for that last
//        message (the cancelled run can never complete), so polling stops
//        instead of burning the whole 8-minute attempt budget.
//  N3 — a persisted error row folds in and ends the poll; a silent death of
//        the run burns the budget and then clears the ghost affordances.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AgentBootstrap, AgentConversation, AgentProviderSummary } from "./agentTypes";

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
      { id: "conv-g", title: "Ghost", preview: "", updatedAt: "2026-08-10T00:00:00.000Z" },
    ],
  };
  const convGhost: AgentConversation = {
    id: "conv-g",
    title: "Ghost",
    preview: "",
    updatedAt: "2026-08-10T00:00:00.000Z",
    providerId: "provider-1",
    scope: { mode: "all_accounts", accountIds: [], messageIds: [] },
    messages: [
      {
        id: "user-g-1",
        role: "user",
        content: "question sent before closing the panel",
        createdAt: "2026-08-10T00:00:00.000Z",
        state: "complete",
        citations: [],
        toolActivities: [],
      },
    ],
  };
  // The server's in-flight row keeps a single id across reads (it is
  // published under the id it later persists with).
  const streamingRow = {
    id: "assistant-inflight",
    role: "assistant" as const,
    content: "",
    state: "streaming" as const,
    createdAt: "2026-08-10T00:00:00.000Z",
    citations: [],
    toolActivities: [],
  };
  const errorRow = {
    id: "assistant-error",
    role: "assistant" as const,
    content: "",
    state: "error" as const,
    createdAt: "2026-08-10T00:00:01.000Z",
    citations: [],
    toolActivities: [],
    error: { code: "PROVIDER_FAILED", message: "provider failed" },
  };
  const completeRow = {
    id: "assistant-done",
    role: "assistant" as const,
    content: "done",
    state: "complete" as const,
    createdAt: "2026-08-10T00:00:01.000Z",
    citations: [],
    toolActivities: [],
  };
  return { provider, bootstrap, convGhost, streamingRow, errorRow, completeRow };
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
    agentConversation: vi.fn(async (id: string) => h.convGhost),
    streamAgentMessage: vi.fn(async () => new Promise(() => undefined)),
    cancelAgentRun: vi.fn(async () => ({ ok: true })),
    createAgentConversation: vi.fn(async () => h.convGhost),
    agentConversations: vi.fn(async () => ({ items: h.bootstrap.conversations })),
    renameAgentConversation: vi.fn(async () => h.bootstrap.conversations[0]!),
    deleteAgentConversation: vi.fn(async () => ({ ok: true })),
    revokeAgentMessage: vi.fn(async () => ({ ok: true, conversation: h.bootstrap.conversations[0]! })),
    uploadOutboundAttachment: vi.fn(async () => ({ ok: true })),
    agentMemoryCreate: vi.fn(async () => ({ ok: true })),
    agentProviders: vi.fn(async () => ({ items: [h.provider], defaultProviderId: "provider-1" })),
    agentMcpServers: vi.fn(async () => ({ items: [] })),
  },
}));

import { api } from "./api";
import { I18nProvider } from "./i18n";
import AgentWorkspace from "./AgentWorkspace";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("AgentWorkspace pickup polling", () => {
  beforeEach(() => {
    window.scrollTo = () => undefined;
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
  });

  const renderWorkspace = async (bootstrap: AgentBootstrap = h.bootstrap) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <AgentWorkspace
            accounts={[]}
            messages={[]}
            currentMessage={undefined}
            onClose={() => undefined}
            onOpenMessage={() => undefined}
            demoMode={false}
            preloadedBootstrap={bootstrap}
            agentAccessLevel="send-confirmed"
            onAgentAccessLevelChange={() => undefined}
          />
        </I18nProvider>,
      );
    });
    await flush();
  };

  it("N1: a streaming snapshot fold-in keeps the 2s poll interval (no continuous refetch)", async () => {
    window.localStorage.clear();
    // Each read returns a FRESH object (the server rebuilds the snapshot) but
    // the in-flight row keeps the same id, so folding it in must not re-arm
    // the effect and bypass the 2s interval.
    (api as unknown as { agentConversation: unknown }).agentConversation = vi.fn(async () => ({
      ...h.convGhost,
      messages: [...h.convGhost.messages, h.streamingRow],
    }));
    const base = api.agentConversation as unknown as ReturnType<typeof vi.fn>;
    await renderWorkspace();
    await flush();
    const readsBefore = base.mock.calls.length;
    // A 600ms window fits at most one additional 2s-interval read.
    await act(async () => {
      await sleep(600);
    });
    const readsAfter = base.mock.calls.length;
    // eslint-disable-next-line no-console
    console.log(`N1: reads in 600ms = ${readsBefore} → ${readsAfter}`);
    expect(readsAfter - readsBefore).toBeLessThanOrEqual(1);
  });

  it("N2: stopGhostRun abandons the pickup — polling stops after the cancel", async () => {
    window.localStorage.clear();
    (api as unknown as { agentConversation: unknown }).agentConversation = vi.fn(async () => h.convGhost);
    const base = api.agentConversation as unknown as ReturnType<typeof vi.fn>;
    await renderWorkspace();
    await flush();
    const stop = container.querySelector<HTMLButtonElement>(".agent-send-button.stop")!;
    expect(stop).not.toBeNull();
    act(() => {
      stop.click();
    });
    await flush();
    expect(api.cancelAgentRun).toHaveBeenCalledWith("conv-g");
    // The ghost affordances disappear ...
    expect(container.querySelector(".agent-thinking")).toBeNull();
    const readsBefore = base.mock.calls.length;
    // ... and a window longer than one poll interval adds no reads: the
    // cancelled run can never complete, so the poll must not wait on it.
    await act(async () => {
      await sleep(2300);
    });
    const readsAfter = base.mock.calls.length;
    // eslint-disable-next-line no-console
    console.log(`N2: reads after stop in 2300ms = ${readsBefore} → ${readsAfter}`);
    expect(readsAfter).toBe(readsBefore);
  });

  it("N3a: a persisted error row folds in, ends the poll and removes the ghost row", async () => {
    window.localStorage.clear();
    // The run dies server-side with a persisted error row; a fresh snapshot
    // reports it the next time the poll reads.
    let read = 0;
    (api as unknown as { agentConversation: unknown }).agentConversation = vi.fn(async () => {
      read += 1;
      return read <= 2
        ? { ...h.convGhost, messages: [...h.convGhost.messages, h.streamingRow] }
        : { ...h.convGhost, messages: [...h.convGhost.messages, h.errorRow] };
    });
    const base = api.agentConversation as unknown as ReturnType<typeof vi.fn>;
    vi.useFakeTimers();
    try {
      await renderWorkspace();
      await flush();
      expect(container.querySelector(".agent-thinking")).not.toBeNull();
      // Advance past one poll interval: the error row is folded in.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_200);
      });
      expect(container.querySelector(".agent-thinking")).toBeNull();
      // The error row itself renders the failure.
      expect(container.querySelector(".agent-message-error")).not.toBeNull();
      expect(container.textContent).toContain("provider failed");
      const readsAtFold = base.mock.calls.length;
      // And the poll has terminated: no further reads.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(base.mock.calls.length).toBe(readsAtFold);
    } finally {
      vi.useRealTimers();
    }
  });

  it("N3b: a silently dead run burns the budget, then clears the ghost affordances", async () => {
    window.localStorage.clear();
    // The server run died without persisting anything (e.g. the agent process
    // restarted): the conversation keeps ending at the user message.
    (api as unknown as { agentConversation: unknown }).agentConversation = vi.fn(async () => h.convGhost);
    const base = api.agentConversation as unknown as ReturnType<typeof vi.fn>;
    vi.useFakeTimers();
    try {
      await renderWorkspace();
      await flush();
      expect(container.querySelector(".agent-thinking")).not.toBeNull();
      const readsAtStart = base.mock.calls.length;
      // Burn the whole attempt budget (240 ticks × 2s) plus a margin.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(240 * 2_000 + 5_000);
      });
      // The budget was burned to exhaustion (the first tick ran immediately,
      // the remaining 239 rode the 2s timers) ...
      expect(base.mock.calls.length - readsAtStart).toBeGreaterThanOrEqual(239);
      // ... then the poll stopped AND the ghost row was cleared instead of
      // staying forever.
      const readsAtEnd = base.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(base.mock.calls.length).toBe(readsAtEnd);
      expect(container.querySelector(".agent-thinking")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});