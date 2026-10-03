// @vitest-environment jsdom
/**
 * Behavioural coverage for the settings "models" panel: the card layout, the
 * form round-trip (payload, key visibility), the dirty-form guard a background
 * list refresh must respect, default selection, the two-step delete, MCP CRUD
 * and the demo-mode notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentMcpServerSummary, AgentProviderList, AgentProviderSummary } from "../agentTypes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    id: "provider-cloud",
    label: "团队模型",
    kind: "openai-compatible",
    endpoint: "https://models.example.test/v1",
    model: "nami-chat",
    timeoutMs: 30_000,
    apiKeyConfigured: true,
    configured: true,
    cloud: true,
    cloudContentConsent: true,
    streaming: true,
    vision: false,
  };
  const server: AgentMcpServerSummary = {
    id: "mcp-1",
    label: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    envKeys: ["TOKEN"],
    cwd: "/tmp",
    timeoutMs: 30_000,
    enabled: true,
    toolCount: 3,
    toolNames: ["read", "write", "list"],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
  return { local, cloud, server };
});

vi.mock("../api", () => ({
  ApiError: class ApiError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  },
  api: {
    agentProviders: vi.fn(),
    createAgentProvider: vi.fn(),
    updateAgentProvider: vi.fn(),
    checkAgentProvider: vi.fn(),
    deleteAgentProvider: vi.fn(),
    agentMcpServers: vi.fn(),
    createAgentMcpServer: vi.fn(),
    updateAgentMcpServer: vi.fn(),
    checkAgentMcpServer: vi.fn(),
    deleteAgentMcpServer: vi.fn(),
  },
}));

import { api } from "../api";
import { I18nProvider, translate } from "../i18n";
import SettingsModelsSection from "./SettingsModelsSection";

const mockApi = vi.mocked(api);
/** Real Chinese copy keeps the assertions honest about what a user reads. */
const t = (key: string, values?: Record<string, unknown>) => translate("zh-CN", key, values as never);

let container: HTMLDivElement;
let root: Root | null = null;
let onProvidersChanged: Mock<(snapshot: AgentProviderList) => void>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  onProvidersChanged = vi.fn();
  mockApi.agentProviders.mockResolvedValue({ items: [h.local, h.cloud], defaultProviderId: h.local.id });
  mockApi.agentMcpServers.mockResolvedValue({ items: [h.server] });
  mockApi.createAgentProvider.mockImplementation(async (input) => ({ ...h.cloud, ...input, id: "provider-new" } as AgentProviderSummary));
  mockApi.updateAgentProvider.mockImplementation(async (id: string, input) => ({ ...h.cloud, ...input, id } as AgentProviderSummary));
  mockApi.checkAgentProvider.mockResolvedValue({ ...h.cloud, health: { state: "ready" } } as AgentProviderSummary);
  mockApi.deleteAgentProvider.mockResolvedValue(undefined as never);
  mockApi.createAgentMcpServer.mockImplementation(async (input) => ({ ...h.server, ...input, id: "mcp-new" } as AgentMcpServerSummary));
  mockApi.updateAgentMcpServer.mockImplementation(async (id: string, input) => ({ ...h.server, ...input, id } as AgentMcpServerSummary));
  mockApi.checkAgentMcpServer.mockResolvedValue(h.server);
  mockApi.deleteAgentMcpServer.mockResolvedValue(undefined as never);
  vi.clearAllMocks();
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function render(props: Partial<React.ComponentProps<typeof SettingsModelsSection>> = {}, settle = true): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider>
        <SettingsModelsSection
          t={t}
          demoMode={false}
          initialProviders={[]}
          initialDefaultProviderId={null}
          onProvidersChanged={onProvidersChanged}
          // The real host is the settings backdrop. Pointing it at the test
          // container keeps the forms inside `container` for the queries below
          // while still exercising the portal mount they take in the app.
          overlayHostRef={{ current: container }}
          {...props}
        />
      </I18nProvider>,
    );
  });
  if (settle) await flush();
}

const rows = (kind: "provider" | "mcp") =>
  Array.from(container.querySelectorAll<HTMLElement>(`[data-model-row="${kind}"][data-provider-id], [data-model-row="${kind}"][data-mcp-id]`));
const byText = (selector: string, text: string) =>
  Array.from(container.querySelectorAll<HTMLElement>(selector)).find((node) => node.textContent?.includes(text));
const query = <T extends Element>(selector: string): T => {
  const node = container.querySelector<T>(selector);
  if (!node) throw new Error(`${selector} not found`);
  return node;
};

function click(node: HTMLElement): void {
  act(() => node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, "value")?.set;
  if (!setter) throw new Error("no value setter");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(formSelector: string): Promise<void> {
  await act(async () => {
    query<HTMLFormElement>(formSelector).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  await flush();
}

describe("settings models panel", () => {
  it("renders one row per provider and MCP server with their status summaries", async () => {
    await render();

    const providerRows = rows("provider");
    expect(providerRows).toHaveLength(2);
    expect(providerRows[0]!.textContent).toContain("本机 Ollama");
    expect(providerRows[0]!.textContent).toContain("llama3.2");
    expect(providerRows[0]!.getAttribute("data-default")).toBe("true");
    expect(providerRows[1]!.getAttribute("data-default")).toBe("false");

    const mcpRows = rows("mcp");
    expect(mcpRows).toHaveLength(1);
    expect(mcpRows[0]!.textContent).toContain("filesystem");
    expect(mcpRows[0]!.textContent).toContain("npx");
    expect(mcpRows[0]!.textContent).toContain("3 个工具");
  });

  it("offers the set-default action only on the non-default provider", async () => {
    await render();

    expect(query<HTMLElement>('[data-provider-id="provider-local"]').textContent).not.toContain("设为默认");
    expect(query<HTMLElement>('[data-provider-id="provider-cloud"]').textContent).toContain("设为默认");
  });

  it("seeds the first frame from the bootstrap preload before the fetch lands", async () => {
    let release: ((value: { items: AgentProviderSummary[]; defaultProviderId: string }) => void) | undefined;
    mockApi.agentProviders.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));

    await render({ initialProviders: [h.local], initialDefaultProviderId: h.local.id }, false);
    expect(rows("provider")).toHaveLength(1);
    expect(rows("provider")[0]!.textContent).toContain("本机 Ollama");

    await act(async () => {
      release!({ items: [h.local, h.cloud], defaultProviderId: h.local.id });
      await Promise.resolve();
    });
    await flush();
    expect(rows("provider")).toHaveLength(2);
  });

  it("opens the add form, saves the documented payload and then checks the connection", async () => {
    await render();

    click(query('[data-models-card="providers"] .settings-inline-actions button'));
    expect(container.querySelector('[data-models-form="provider"]')).not.toBeNull();

    type(query<HTMLInputElement>("#agent-provider-label"), " 团队模型 ");
    type(query<HTMLInputElement>("#agent-provider-endpoint"), " https://models.example.test/v1 ");
    type(query<HTMLInputElement>("#agent-provider-model"), "nami-chat");
    type(query<HTMLInputElement>("#agent-provider-timeout"), "30000");
    type(query<HTMLInputElement>("#agent-provider-key"), " write-only-secret ");
    await submit('[data-models-form="provider"]');

    expect(mockApi.createAgentProvider).toHaveBeenCalledWith({
      label: "团队模型",
      kind: "openai-compatible",
      endpoint: "https://models.example.test/v1",
      model: "nami-chat",
      timeoutMs: 30_000,
      allowCloudMailContent: false,
      apiKey: "write-only-secret",
      contextWindowTokens: 8192,
      maxOutputTokens: 2048,
    });
    // A save is always followed by a connection check, then a list refresh.
    expect(mockApi.checkAgentProvider).toHaveBeenCalledWith("provider-new");
    expect(onProvidersChanged).toHaveBeenCalled();
    // The verified provider owns the form now: the dialog goes away and its
    // outcome falls back to the card, which is the only place it can be read
    // once the overlay is gone.
    expect(container.querySelector('[data-models-form="provider"]')).toBeNull();
    expect(query('[data-models-card="providers"] .settings-model-feedback.success').textContent)
      .toContain(t("agent.providers.checked"));
  });

  it("blocks the save until the required fields validate", async () => {
    await render();

    click(query('[data-models-card="providers"] .settings-inline-actions button'));
    type(query<HTMLInputElement>("#agent-provider-label"), "缺地址的模型");
    await submit('[data-models-form="provider"]');

    expect(container.querySelector(".settings-note")?.textContent).toContain(t("agent.providers.validation.endpoint"));
    expect(mockApi.createAgentProvider).not.toHaveBeenCalled();
  });

  it("toggles the API key field between masked and plain text", async () => {
    await render();

    click(query('[data-models-card="providers"] .settings-inline-actions button'));
    expect(query<HTMLInputElement>("#agent-provider-key").type).toBe("password");

    click(query('[aria-label="' + t("agent.providers.fields.showKey") + '"]'));
    expect(query<HTMLInputElement>("#agent-provider-key").type).toBe("text");

    click(query('[aria-label="' + t("agent.providers.fields.hideKey") + '"]'));
    expect(query<HTMLInputElement>("#agent-provider-key").type).toBe("password");
  });

  it("keeps a half-typed draft when the mount-time list load lands afterwards", async () => {
    // The load is deliberately slow: the user starts typing before the snapshot
    // arrives, and the refresh must not rebuild the form underneath them.
    let release: ((value: { items: AgentProviderSummary[]; defaultProviderId: string }) => void) | undefined;
    mockApi.agentProviders.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));

    await render({}, false);
    click(query('[data-models-card="providers"] .settings-inline-actions button'));
    type(query<HTMLInputElement>("#agent-provider-label"), "半途输入");
    type(query<HTMLInputElement>("#agent-provider-key"), "typed-before-refresh");

    await act(async () => {
      release!({ items: [h.local, h.cloud], defaultProviderId: h.local.id });
      await Promise.resolve();
    });
    await flush();

    expect(query<HTMLInputElement>("#agent-provider-label").value).toBe("半途输入");
    expect(query<HTMLInputElement>("#agent-provider-key").value).toBe("typed-before-refresh");
  });

  it("promotes another provider to default without touching its stored key", async () => {
    await render();

    click(byText('[data-provider-id="provider-cloud"] .secondary-button', "设为默认")!);
    await flush();

    expect(mockApi.updateAgentProvider).toHaveBeenCalledWith(h.cloud.id, {
      label: h.cloud.label,
      kind: h.cloud.kind,
      endpoint: h.cloud.endpoint,
      model: h.cloud.model,
      timeoutMs: h.cloud.timeoutMs,
      allowCloudMailContent: h.cloud.cloudContentConsent,
      makeDefault: true,
    });
    const payload = mockApi.updateAgentProvider.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.apiKey).toBeUndefined();
    expect(payload.clearApiKey).toBeUndefined();
  });

  it("deletes a provider only after the confirm step", async () => {
    await render();

    click(byText('[data-provider-id="provider-cloud"] .danger-button', "删除模型")!);
    expect(mockApi.deleteAgentProvider).not.toHaveBeenCalled();
    expect(container.querySelector(".settings-model-delete-note")).not.toBeNull();

    click(byText('[data-provider-id="provider-cloud"] .danger-button', "再次确认删除")!);
    await flush();
    expect(mockApi.deleteAgentProvider).toHaveBeenCalledWith("provider-cloud");
    expect(onProvidersChanged).toHaveBeenCalled();
  });

  it("closes the open form when the provider it edits is deleted", async () => {
    // A list that actually shrinks, so the post-delete refresh is the signal
    // the orphaned draft has to react to.
    let items: AgentProviderSummary[] = [h.local, h.cloud];
    mockApi.agentProviders.mockImplementation(async () => ({ items, defaultProviderId: h.local.id }));
    mockApi.deleteAgentProvider.mockImplementation(async (id: string) => {
      items = items.filter((provider) => provider.id !== id);
      return { ok: true };
    });
    await render();

    click(byText('[data-provider-id="provider-cloud"] .secondary-button', "编辑")!);
    await flush();
    expect(container.querySelector('[data-models-form="provider"]')).not.toBeNull();

    // Same row, so the refresh has to tear the now-orphaned draft down.
    click(byText('[data-provider-id="provider-cloud"] .danger-button', "删除模型")!);
    click(byText('[data-provider-id="provider-cloud"] .danger-button', "再次确认删除")!);
    await flush();

    expect(mockApi.deleteAgentProvider).toHaveBeenCalledWith("provider-cloud");
    expect(rows("provider")).toHaveLength(1);
    expect(container.querySelector('[data-models-form="provider"]')).toBeNull();
  });

  it("creates and checks an MCP server through its own card", async () => {
    await render();

    click(query('[data-models-card="mcp"] .settings-inline-actions button'));
    expect(container.querySelector('[data-models-form="mcp"]')).not.toBeNull();

    type(query<HTMLInputElement>("#mcp-server-label"), "filesystem");
    type(query<HTMLInputElement>("#mcp-server-command"), "npx");
    type(query<HTMLTextAreaElement>("#mcp-server-args"), "-y\n\n@modelcontextprotocol/server-filesystem");
    type(query<HTMLInputElement>("#mcp-server-cwd"), "/tmp");
    type(container.querySelectorAll<HTMLInputElement>(".settings-model-env-line input")[0]!, "TOKEN");
    type(container.querySelectorAll<HTMLInputElement>(".settings-model-env-line input")[1]!, " secret-value ");
    await submit('[data-models-form="mcp"]');

    expect(mockApi.createAgentMcpServer).toHaveBeenCalledWith({
      label: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { TOKEN: "secret-value" },
      cwd: "/tmp",
      timeoutMs: 30_000,
      enabled: true,
    });
    expect(mockApi.checkAgentMcpServer).toHaveBeenCalledWith("mcp-new");
  });

  it("removes a saved environment key by dropping its row", async () => {
    await render();

    click(byText('[data-mcp-id="mcp-1"] .secondary-button', "编辑")!);
    await flush();
    // The saved key plus one spare row.
    expect(container.querySelectorAll(".settings-model-env-line")).toHaveLength(2);

    click(container.querySelector<HTMLButtonElement>(".settings-model-env-line .icon-button")!);
    await submit('[data-models-form="mcp"]');

    expect(mockApi.updateAgentMcpServer).toHaveBeenCalledWith("mcp-1", expect.objectContaining({
      label: "filesystem",
      env: {},
      envRemove: ["TOKEN"],
    }));
  });

  it("keeps the same env <input> node while a key and a value are typed", async () => {
    // Regression lock: the row key used to be built from the row's own content,
    // so every keystroke changed the React key, the <input> was unmounted and
    // remounted, and focus/caret was lost after the first character.
    await render();

    click(query('[data-models-card="mcp"] .settings-inline-actions button'));
    await flush();
    const envInputs = () => container.querySelectorAll<HTMLInputElement>(".settings-model-env-line input");
    const keyInput = envInputs()[0]!;
    const valueInput = envInputs()[1]!;

    type(keyInput, "T");
    expect(envInputs()[0]).toBe(keyInput);
    type(envInputs()[0]!, "TO");
    expect(envInputs()[0]).toBe(keyInput);

    type(valueInput, "s");
    expect(envInputs()[1]).toBe(valueInput);
    type(envInputs()[1]!, "se");
    expect(envInputs()[1]).toBe(valueInput);

    // Two keystrokes in, both values landed on the original nodes.
    expect(envInputs()[0]!.value).toBe("TO");
    expect(envInputs()[1]!.value).toBe("se");
  });

  it("adds an env row without disturbing the rows already typed into", async () => {
    await render();

    click(query('[data-models-card="mcp"] .settings-inline-actions button'));
    await flush();
    const envInputs = () => container.querySelectorAll<HTMLInputElement>(".settings-model-env-line input");
    type(envInputs()[0]!, "TOKEN");
    const firstKey = envInputs()[0]!;

    click(byText(".settings-model-add-env", t("agent.mcpServers.fields.addEnv"))!);
    await flush();

    expect(container.querySelectorAll(".settings-model-env-line")).toHaveLength(2);
    expect(envInputs()[0]).toBe(firstKey);
    expect(envInputs()[0]!.value).toBe("TOKEN");
  });

  it("keeps a saved-but-unrefreshed provider visible and still tells the host about it", async () => {
    // The create lands; only the list refresh fails. Closing the dialog as if
    // everything worked left the default model, the agent model picker and the
    // AI-translation switch on the pre-save list, with nothing to retry.
    mockApi.agentProviders.mockResolvedValueOnce({ items: [h.local, h.cloud], defaultProviderId: h.local.id });
    mockApi.agentProviders.mockRejectedValue(new Error("列表服务不可用"));
    await render();

    click(query('[data-models-card="providers"] .settings-inline-actions button'));
    type(query<HTMLInputElement>("#agent-provider-label"), "团队模型");
    type(query<HTMLInputElement>("#agent-provider-endpoint"), "https://models.example.test/v1");
    type(query<HTMLInputElement>("#agent-provider-model"), "nami-chat");
    await submit('[data-models-form="provider"]');

    expect(mockApi.createAgentProvider).toHaveBeenCalledTimes(1);
    // Not a silent success: the dialog is still up, saying what went wrong.
    expect(container.querySelector('[data-models-form="provider"]')).not.toBeNull();
    expect(query('[data-models-form="provider"] .settings-model-feedback.error').textContent)
      .toContain(t("agent.providers.refreshFailed"));
    // ... and the host is not left stale, whatever the list request does.
    expect(onProvidersChanged).toHaveBeenCalled();
    const published = onProvidersChanged.mock.calls.at(-1)![0] as AgentProviderList;
    expect(published.items.map((provider) => provider.id)).toContain("provider-new");
  });

  it("does not create a second provider when the failed-refresh retry is used", async () => {
    mockApi.agentProviders.mockResolvedValueOnce({ items: [h.local, h.cloud], defaultProviderId: h.local.id });
    mockApi.agentProviders.mockRejectedValue(new Error("列表服务不可用"));
    await render();

    click(query('[data-models-card="providers"] .settings-inline-actions button'));
    type(query<HTMLInputElement>("#agent-provider-label"), "团队模型");
    type(query<HTMLInputElement>("#agent-provider-endpoint"), "https://models.example.test/v1");
    type(query<HTMLInputElement>("#agent-provider-model"), "nami-chat");
    await submit('[data-models-form="provider"]');
    expect(mockApi.createAgentProvider).toHaveBeenCalledTimes(1);

    click(byText('[data-models-form="provider"] .settings-model-feedback .secondary-button', t("agent.providers.retry"))!);
    await flush();

    // The row exists on the server already: "retry" re-checks and re-reads the
    // list, it never POSTs a second provider.
    expect(mockApi.createAgentProvider).toHaveBeenCalledTimes(1);
    expect(mockApi.updateAgentProvider).not.toHaveBeenCalled();
    expect(mockApi.checkAgentProvider.mock.calls.length).toBeGreaterThan(1);
  });

  it("deletes an MCP server only after the confirm step", async () => {
    await render();

    click(byText('[data-mcp-id="mcp-1"] .danger-button', "删除服务器")!);
    expect(mockApi.deleteAgentMcpServer).not.toHaveBeenCalled();

    click(byText('[data-mcp-id="mcp-1"] .danger-button', "再次确认删除")!);
    await flush();
    expect(mockApi.deleteAgentMcpServer).toHaveBeenCalledWith("mcp-1");
  });

  it("surfaces a failed load with a retry affordance", async () => {
    mockApi.agentProviders.mockRejectedValueOnce(new Error("服务不可用"));
    await render();

    expect(query(".settings-model-feedback.error").textContent).toContain("服务不可用");
    click(byText(".settings-model-feedback .secondary-button", t("agent.providers.retry"))!);
    await flush();
    expect(mockApi.agentProviders).toHaveBeenCalledTimes(2);
    expect(rows("provider")).toHaveLength(2);
  });

  it("shows the in-memory notice instead of the live cards in demo mode", async () => {
    await render({ demoMode: true });

    expect(container.querySelector('[data-settings-nav="models"]')).not.toBeNull();
    expect(container.querySelector('[data-models-card="providers"]')).toBeNull();
    expect(container.querySelector('[data-models-card="mcp"]')).toBeNull();
    expect(mockApi.agentProviders).not.toHaveBeenCalled();
  });

  it("renders only providers when view='providers'", async () => {
    await render({ view: "providers" });

    expect(container.querySelector('[data-models-card="providers"]')).not.toBeNull();
    expect(container.querySelector('[data-models-card="mcp"]')).toBeNull();
    expect(mockApi.agentProviders).toHaveBeenCalled();
    expect(mockApi.agentMcpServers).not.toHaveBeenCalled();
  });

  it("renders only mcp servers when view='mcp'", async () => {
    await render({ view: "mcp" });

    expect(container.querySelector('[data-models-card="mcp"]')).not.toBeNull();
    expect(container.querySelector('[data-models-card="providers"]')).toBeNull();
    expect(container.querySelector('[data-settings-nav="mcp"]')).not.toBeNull();
    expect(mockApi.agentMcpServers).toHaveBeenCalled();
    expect(mockApi.agentProviders).not.toHaveBeenCalled();
  });
});