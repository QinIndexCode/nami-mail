// @vitest-environment jsdom
/**
 * The provider configuration UI moved into the settings modal, so the workspace
 * no longer owns a dialog: it deep-links into the "models" category (leaving a
 * live run streaming behind the modal) and refetches the provider list when the
 * App reports that the settings panel edited it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  const local: AgentProviderSummary = {
    id: "provider-local",
    label: "本机 Ollama",
    kind: "ollama",
    endpoint: "http://127.0.0.1:11434/v1",
    model: "llama3.2",
    timeoutMs: 45_000,
    apiKeyConfigured: false,
    configured: true,
    cloud: false,
    cloudContentConsent: false,
    streaming: true,
    vision: false,
  };
  const cloud: AgentProviderSummary = {
    ...local,
    id: "provider-cloud",
    label: "团队模型",
    kind: "openai-compatible",
    endpoint: "https://models.example.test/v1",
    model: "nami-chat",
    cloud: true,
    cloudContentConsent: true,
    apiKeyConfigured: true,
  };
  const conversation: AgentConversation = {
    id: "conv-1",
    title: "Conversation",
    preview: "",
    updatedAt: "2026-08-10T00:00:00.000Z",
    providerId: "provider-local",
    scope: { mode: "all_accounts", accountIds: [], messageIds: [] },
    messages: [],
  };
  const bootstrap: AgentBootstrap = {
    enabled: true,
    configured: true,
    providers: [local],
    defaultProviderId: "provider-local",
    conversations: [{ id: conversation.id, title: conversation.title, preview: "", updatedAt: conversation.updatedAt }],
  };
  return { local, cloud, conversation, bootstrap };
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
    agentConversation: vi.fn(async () => h.conversation),
    agentConversations: vi.fn(async () => ({ items: h.bootstrap.conversations })),
    streamAgentMessage: vi.fn(async () => new Promise(() => undefined)),
    cancelAgentRun: vi.fn(async () => ({ ok: true })),
    createAgentConversation: vi.fn(async () => h.conversation),
    renameAgentConversation: vi.fn(async () => h.bootstrap.conversations[0]!),
    setAgentConversationProvider: vi.fn(async () => h.bootstrap.conversations[0]!),
    deleteAgentConversation: vi.fn(async () => ({ ok: true })),
    revokeAgentMessage: vi.fn(async () => ({ ok: true, conversation: h.bootstrap.conversations[0]! })),
    uploadOutboundAttachment: vi.fn(async () => ({ ok: true })),
    agentMemoryCreate: vi.fn(async () => ({ ok: true })),
    agentProviders: vi.fn(async () => ({ items: [h.local], defaultProviderId: "provider-local" })),
    agentMcpServers: vi.fn(async () => ({ items: [] })),
    messages: vi.fn(async () => ({ items: [], total: 0, pageSize: 10, nextCursor: null })),
  },
}));

import { api } from "./api";
import { I18nProvider, translate } from "./i18n";
import AgentWorkspace from "./AgentWorkspace";

const mockApi = vi.mocked(api);

let container: HTMLDivElement;
let root: Root;
let openModelSettings: ReturnType<typeof vi.fn<(...args: never[]) => void>>;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
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
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  openModelSettings = vi.fn();
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(props: Partial<React.ComponentProps<typeof AgentWorkspace>> = {}): Promise<void> {
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
          onOpenModelSettings={openModelSettings}
          {...props}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

const byLabel = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"], [data-tooltip="${label}"]`);

const click = (node: HTMLElement) => act(() => node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

describe("agent workspace model settings deep link", () => {
  it("opens the settings models category without closing the workspace", async () => {
    await render();

    const trigger = byLabel(translate("zh-CN", "agent.provider.settings"));
    expect(trigger).not.toBeNull();
    click(trigger!);

    expect(openModelSettings).toHaveBeenCalledTimes(1);
    // The workspace itself stays mounted — a live run keeps streaming.
    expect(container.querySelector(".agent-workspace")).not.toBeNull();
  });

  it("offers the configure action when no provider is configured yet", async () => {
    await render({
      preloadedBootstrap: {
        ...h.bootstrap,
        providers: [{ ...h.local, configured: false }],
        configured: false,
        defaultProviderId: null,
      },
    });

    const configure = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes(translate("zh-CN", "agent.providers.configure")));
    expect(configure).toBeDefined();
    click(configure!);
    expect(openModelSettings).toHaveBeenCalledTimes(1);
  });

  it("refetches the provider list when App bumps providerListVersion and keeps a usable explicit choice", async () => {
    await render({ providerListVersion: 0 });
    expect(mockApi.agentProviders).not.toHaveBeenCalled();

    // Open the model picker so the offered providers are on screen.
    click(container.querySelector<HTMLButtonElement>(".agent-composer-model")!);
    expect(container.textContent).not.toContain(h.cloud.label);

    mockApi.agentProviders.mockResolvedValueOnce({ items: [h.local, h.cloud], defaultProviderId: h.cloud.id });
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
            onOpenModelSettings={openModelSettings}
            providerListVersion={1}
          />
        </I18nProvider>,
      );
    });
    await flush();

    expect(mockApi.agentProviders).toHaveBeenCalledTimes(1);
    // The new provider is now offered by the model picker.
    expect(container.textContent).toContain(h.cloud.label);
  });

  it("falls back to the default when the selected provider disappears", async () => {
    await render({ providerListVersion: 0 });

    mockApi.agentProviders.mockResolvedValueOnce({ items: [], defaultProviderId: null });
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
            providerListVersion={1}
          />
        </I18nProvider>,
      );
    });
    await flush();

    // No provider left at all: the "configure model" affordance is back.
    expect(Array.from(container.querySelectorAll("button")).some((button) =>
      button.textContent?.includes(translate("zh-CN", "agent.providers.configure")))).toBe(true);
  });

  it("pins a model choice server-side and keeps no localStorage copy", async () => {
    await render({ providerListVersion: 0 });
    // Offer a second provider so the picker has an alternative to pin.
    mockApi.agentProviders.mockResolvedValueOnce({ items: [h.local, h.cloud], defaultProviderId: h.local.id });
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
            onOpenModelSettings={openModelSettings}
            providerListVersion={1}
          />
        </I18nProvider>,
      );
    });
    await flush();

    click(container.querySelector<HTMLButtonElement>(".agent-composer-model")!);
    const option = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-model-option"))
      .find((button) => button.textContent?.includes(h.cloud.label));
    expect(option).toBeDefined();
    click(option!);

    // The pin is persisted server-side against the active conversation…
    expect(mockApi.setAgentConversationProvider).toHaveBeenCalledTimes(1);
    expect(mockApi.setAgentConversationProvider).toHaveBeenCalledWith("conv-1", h.cloud.id);
    // …and the renderer keeps no cross-session copy (the drift class this
    // replaces: a stale localStorage override won over the server record).
    expect(window.localStorage.getItem("nami-agent-conversation-providers")).toBeNull();
  });

  it("keeps the session selection when the server-side pin is rejected", async () => {
    await render({ providerListVersion: 0 });
    mockApi.agentProviders.mockResolvedValueOnce({ items: [h.local, h.cloud], defaultProviderId: h.local.id });
    mockApi.setAgentConversationProvider.mockRejectedValueOnce(new Error("provider unavailable"));
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
            onOpenModelSettings={openModelSettings}
            providerListVersion={1}
          />
        </I18nProvider>,
      );
    });
    await flush();

    click(container.querySelector<HTMLButtonElement>(".agent-composer-model")!);
    const option = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-model-option"))
      .find((button) => button.textContent?.includes(h.cloud.label));
    click(option!);
    await flush();

    // Fire-and-forget: the failed pin costs the cross-session choice only.
    expect(mockApi.setAgentConversationProvider).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(h.cloud.label);
  });
});