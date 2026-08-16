// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AgentBootstrap, AgentConversation, AgentProviderSummary } from "./agentTypes";

// React 19 requires the act() environment flag when not running through
// @testing-library/react, and jsdom lacks matchMedia.
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
  const convA: AgentConversation = {
    id: "conv-a",
    title: "Conversation A",
    preview: "",
    updatedAt: "2026-08-10T00:00:00.000Z",
    providerId: "provider-1",
    scope: { mode: "all_accounts", accountIds: [], messageIds: [] },
    messages: [
      {
        id: "user-a-1",
        role: "user",
        content: "earlier question",
        createdAt: "2026-08-10T00:00:00.000Z",
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "assistant-a-1",
        role: "assistant",
        content: "earlier answer",
        createdAt: "2026-08-10T00:00:01.000Z",
        state: "complete",
        citations: [],
        toolActivities: [],
      },
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
  // A conversation whose newest turn has no assistant reply yet and no local
  // session: the shape a panel reopen sees while a run is still being picked
  // up (the server's in-flight row may be empty during the automatic mail
  // search phase).
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
  return { provider, bootstrap, convA, convB, convGhost };
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
    agentConversation: vi.fn(async (id: string) => (id === "conv-a" ? h.convA : id === "conv-g" ? h.convGhost : h.convB)),
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
  },
}));

// Imported after the mock so the component binds to the mocked module.
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

const clickRow = (title: string) => {
  const rowButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-conversation-row > button:first-child"))
    .find((button) => button.textContent?.includes(title));
  if (!rowButton) throw new Error(`conversation row for "${title}" not found`);
  act(() => {
    rowButton.click();
  });
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

const headingFor = (): string | null => container.querySelector(".agent-conversation-title h1")?.textContent ?? null;

describe("AgentWorkspace conversation switching", () => {
  beforeEach(() => {
    window.scrollTo = () => undefined;
    // jsdom leaves window.localStorage unusable here; install a working stub
    // so the LAST_ACTIVE-conversation persistence paths can be exercised and
    // reset between tests.
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

  it("switching to another conversation right after sending still works", async () => {
    await renderWorkspace();

    // Open conversation A (its sidebar row exists from the preloaded bootstrap).
    clickRow("Conversation A");
    await flush();
    expect(headingFor()).toContain("Conversation A");
    expect(api.agentConversation).toHaveBeenCalledWith("conv-a");

    // Send a message into A; the mock stream never resolves so it stays in-flight.
    setComposer("follow-up question");
    clickSend();
    await flush();
    expect(api.streamAgentMessage).toHaveBeenCalledTimes(1);
    expect(api.streamAgentMessage).toHaveBeenCalledWith("conv-a", expect.anything(), expect.any(Function), expect.anything());

    // Immediately switch to B while A is still streaming.
    clickRow("Conversation B");
    await flush();

    // The header and the row highlight must reflect B, not be stuck on A.
    expect(headingFor()).toContain("Conversation B");
    const aRow = Array.from(container.querySelectorAll<HTMLElement>(".agent-conversation-row")).find((r) => r.textContent?.includes("Conversation A"));
    const bRow = Array.from(container.querySelectorAll<HTMLElement>(".agent-conversation-row")).find((r) => r.textContent?.includes("Conversation B"));
    expect(bRow?.className).toContain("active");
    expect(aRow?.className).not.toContain("active");
  });

  it("closing the panel never cancels the server-side run (leave, not cancel)", async () => {
    await renderWorkspace();
    expect(headingFor()).toContain("Conversation A");

    // Send a message; the mocked stream stays in-flight (server still draining).
    setComposer("question");
    clickSend();
    await flush();
    expect(api.streamAgentMessage).toHaveBeenCalledTimes(1);

    // Close the panel (unmount). The local controller is aborted (which only
    // stops SSE delivery), but cancelAgentRun must NOT be issued — the server
    // keeps the run going and persists the completed turn so a reopen sees it.
    act(() => {
      root.unmount();
    });
    await flush();

    expect(api.cancelAgentRun).not.toHaveBeenCalled();
  });

  it("a run being picked up after a reopen shows a thinking row and a stop that cancels server-side", async () => {
    window.localStorage.clear();
    const ghostBootstrap: AgentBootstrap = {
      ...h.bootstrap,
      conversations: [
        { id: "conv-g", title: "Ghost", preview: "", updatedAt: "2026-08-10T00:00:00.000Z" },
      ],
    };
    await renderWorkspace(ghostBootstrap);

    // Auto-selected the only conversation; its newest message is the user's
    // question with no local session — the pickup state.
    expect(headingFor()).toContain("Ghost");

    // A local thinking row shows while the server's pre-content phase runs.
    expect(container.querySelector(".agent-thinking")).not.toBeNull();

    // The composer exposes a stop affordance that cancels the server run
    // directly (there is no local controller to abort).
    const stop = container.querySelector<HTMLButtonElement>(".agent-send-button.stop");
    expect(stop).not.toBeNull();
    act(() => {
      stop!.click();
    });
    await flush();

    expect(api.cancelAgentRun).toHaveBeenCalledWith("conv-g");
    // Pickup abandoned: the fallback row disappears.
    expect(container.querySelector(".agent-thinking")).toBeNull();
  });

  it("optimistic switch: the UI jumps immediately and renders the record once the fetch lands", async () => {
    await renderWorkspace();
    expect(headingFor()).toContain("Conversation A");

    let resolveB!: (conversation: AgentConversation) => void;
    (api as unknown as { agentConversation: unknown }).agentConversation = vi.fn((id: string) =>
      id === "conv-a"
        ? Promise.resolve(h.convA)
        : new Promise<AgentConversation>((resolve) => {
          resolveB = resolve;
        }),
    );

    // The click must surface B immediately, without waiting for the record.
    clickRow("Conversation B");
    await flush();
    expect(headingFor()).toContain("Conversation B");

    // While the fetch is pending the transcript shows the skeleton and the
    // composer is gated (nothing can be sent against the shell).
    expect(container.querySelector(".agent-skeleton-line")).not.toBeNull();
    const send = container.querySelector<HTMLButtonElement>(".agent-send-button");
    expect(send?.disabled).toBe(true);

    // The record lands: skeleton is replaced by the real transcript.
    act(() => {
      resolveB({
        ...h.convB,
        messages: [
          { id: "user-b-1", role: "user", content: "question", createdAt: "2026-08-10T00:00:00.000Z", state: "complete", citations: [], toolActivities: [] },
          { id: "assistant-b-1", role: "assistant", content: "answer", createdAt: "2026-08-10T00:00:01.000Z", state: "complete", citations: [], toolActivities: [] },
        ],
      });
    });
    await flush();

    expect(container.querySelector(".agent-skeleton-line")).toBeNull();
    expect(container.textContent).toContain("answer");
    expect(api.agentConversation).toHaveBeenCalledWith("conv-b");
  });

  it("a stale (out-of-order) fetch never overwrites a newer selection", async () => {
    await renderWorkspace();
    expect(headingFor()).toContain("Conversation A");

    let resolveA!: (conversation: AgentConversation) => void;
    let resolveB!: (conversation: AgentConversation) => void;
    (api as unknown as { agentConversation: unknown }).agentConversation = vi.fn((id: string) =>
      new Promise<AgentConversation>((resolve) => {
        if (id === "conv-a") resolveA = resolve;
        else resolveB = resolve;
      }),
    );

    // A → B, both pending.
    clickRow("Conversation B");
    await flush();
    expect(headingFor()).toContain("Conversation B");
    clickRow("Conversation A");
    await flush();
    expect(headingFor()).toContain("Conversation A");

    // B's fetch resolves last: it is the stale one now and must not flip the
    // view back to B.
    act(() => {
      resolveB!({
        ...h.convB,
        messages: [
          { id: "user-b-1", role: "user", content: "late", createdAt: "2026-08-10T00:00:00.000Z", state: "complete", citations: [], toolActivities: [] },
          { id: "assistant-b-1", role: "assistant", content: "late reply", createdAt: "2026-08-10T00:00:01.000Z", state: "complete", citations: [], toolActivities: [] },
        ],
      });
    });
    await flush();
    expect(headingFor()).toContain("Conversation A");

    // A's fetch lands: view settles on A with its real content.
    act(() => {
      resolveA!(h.convA);
    });
    await flush();
    expect(headingFor()).toContain("Conversation A");
    expect(container.querySelector(".agent-skeleton-line")).toBeNull();
    expect(container.textContent).toContain("earlier answer");
  });

  it("right-clicking a conversation row opens a menu with delete / select / rename / export", async () => {
    await renderWorkspace();

    const row = Array.from(container.querySelectorAll<HTMLElement>(".agent-conversation-row")).find((r) => r.textContent?.includes("Conversation A"));
    expect(row).toBeDefined();
    act(() => {
      row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    });
    await flush();

    const menu = container.querySelector(".agent-context-menu");
    expect(menu).not.toBeNull();
    const items = Array.from(menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items.length).toBe(5);

    // Delete opens the confirmation dialog; no API call yet.
    act(() => {
      items[0]!.click();
    });
    // The menu fades out (90ms) before the action runs.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flush();
    expect(container.querySelector(".agent-row-confirm")).toBeNull();
    const dialog = container.querySelector(".confirmation-card");
    expect(dialog).not.toBeNull();
    expect(api.deleteAgentConversation).not.toHaveBeenCalled();

    // Confirming performs the delete and closes the dialog.
    act(() => {
      dialog!.querySelector<HTMLButtonElement>(".confirmation-actions .danger-button")!.click();
    });
    await flush();
    expect(api.deleteAgentConversation).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".confirmation-card")).toBeNull();
  });

  it("many attachments collapse to five files plus a +N chip, expand on click, and fold back", async () => {
    const conv = structuredClone(h.convA);
    conv.messages[0]!.attachments = Array.from({ length: 7 }, (_, index) => ({
      name: `report-${index + 1}.pdf`,
      type: "application/pdf",
      path: `path-${index + 1}`,
    }));
    vi.mocked(api.agentConversation).mockResolvedValueOnce(conv);
    await renderWorkspace();
    clickRow("Conversation A");
    await flush();

    const chips = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-message-attachment"));
    expect(chips().length).toBe(6); // 5 files + "+2" toggle
    expect(chips().filter((chip) => chip.classList.contains("is-more")).length).toBe(1);

    act(() => {
      chips().find((chip) => chip.classList.contains("is-more"))!.click();
    });
    await flush();
    expect(chips().length).toBe(8); // all 7 files + "collapse" toggle

    act(() => {
      chips().find((chip) => chip.classList.contains("is-more"))!.click();
    });
    await flush();
    expect(chips().length).toBe(6);
  });

  it("multi-select: rows toggle, and deleting the selection removes every chosen conversation", async () => {
    await renderWorkspace();

    const rows = () => Array.from(container.querySelectorAll<HTMLElement>(".agent-conversation-row"));
    act(() => {
      rows().find((r) => r.textContent?.includes("Conversation A"))!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    });
    await flush();
    act(() => {
      // Second item is multi-select (locale-independent position).
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))[1]!.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flush();

    // Selection bar appears; checkbox rows are armed, one already checked.
    expect(container.querySelector(".agent-selection-bar")).not.toBeNull();
    expect(container.querySelectorAll(".agent-row-check").length).toBe(2);
    const aCheck = rows().find((r) => r.textContent?.includes("Conversation A"))!.querySelector<HTMLButtonElement>(".agent-row-check");
    expect(aCheck?.classList.contains("checked")).toBe(true);

    // Selecting B makes the delete enable.
    act(() => {
      rows().find((r) => r.textContent?.includes("Conversation B"))!
        .querySelector<HTMLButtonElement>(".agent-conversation-open")!.click();
    });
    await flush();
    const deleteSelected = container.querySelector<HTMLButtonElement>(".agent-selection-delete");
    expect(deleteSelected?.disabled).toBe(false);

    // The bulk delete opens the confirmation dialog instead of deleting right
    // away.
    act(() => {
      deleteSelected!.click();
    });
    await flush();
    const dialog = container.querySelector(".confirmation-card");
    expect(dialog).not.toBeNull();
    expect(api.deleteAgentConversation).not.toHaveBeenCalled();

    act(() => {
      dialog!.querySelector<HTMLButtonElement>(".confirmation-actions .danger-button")!.click();
    });
    await flush();
    expect(api.deleteAgentConversation).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".agent-selection-bar-wrap")?.className).not.toContain("open");
    expect(container.querySelector(".confirmation-card")).toBeNull();
  });

  it("right-clicking the list blank area offers New conversation", async () => {
    await renderWorkspace();

    const list = container.querySelector<HTMLElement>(".agent-conversation-list");
    expect(list).not.toBeNull();
    act(() => {
      list!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 400 }));
    });
    await flush();

    const menu = container.querySelector(".agent-context-menu");
    expect(menu).not.toBeNull();
    expect(menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]').length).toBe(1);
    act(() => {
      menu!.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flush();

    // createConversation clears the active conversation → welcome empty state.
    expect(container.querySelector(".agent-empty-state")).not.toBeNull();
  });
});
