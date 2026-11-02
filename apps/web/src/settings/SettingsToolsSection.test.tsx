// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../i18n";
import { defaultAppSettings, type AppSettings } from "../types";
import { BUILTIN_AGENT_TOOLS } from "./builtin-tools-data";
import SettingsToolsSection from "./SettingsToolsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api", () => ({
  api: {
    agentMcpServers: vi.fn().mockResolvedValue({ items: [] }),
    createAgentMcpServer: vi.fn(),
    updateAgentMcpServer: vi.fn(),
    checkAgentMcpServer: vi.fn().mockResolvedValue({}),
    deleteAgentMcpServer: vi.fn().mockResolvedValue(undefined),
  },
}));

import { api } from "../api";
import type { AgentMcpServerSummary } from "../agentTypes";

const mockApi = vi.mocked(api);
const t = (key: string, params?: Record<string, unknown>) => translate("zh-CN", key, params as never);

const mcpServer: AgentMcpServerSummary = {
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

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  mockApi.agentMcpServers.mockResolvedValue({ items: [] });
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  vi.clearAllMocks();
});

function renderSection(props: Partial<React.ComponentProps<typeof SettingsToolsSection>> = {}) {
  const currentSettings: AppSettings = {
    ...defaultAppSettings,
    agentAccessLevel: "send-confirmed",
    ...(props.currentSettings ?? {}),
  };

  act(() => {
    root = createRoot(container);
    root.render(
      <SettingsToolsSection
        t={t}
        demoMode={true}
        currentSettings={currentSettings}
        {...props}
      />,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** Mounts with the MCP list already loaded; demo mode would skip the fetch. */
async function renderLoadedMcp(
  props: Partial<React.ComponentProps<typeof SettingsToolsSection>> = {},
): Promise<void> {
  renderSection({ demoMode: false, ...props });
  await flush();
}

const query = <T extends Element>(selector: string): T => {
  const node = container.querySelector<T>(selector);
  if (!node) throw new Error(`${selector} not found`);
  return node;
};

const byText = (selector: string, text: string) =>
  Array.from(container.querySelectorAll<HTMLElement>(selector)).find((node) => node.textContent?.includes(text));

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

describe("SettingsToolsSection", () => {
  it("renders both tabs with correct counts", () => {
    renderSection();

    const builtinTab = container.querySelector<HTMLButtonElement>("#tab-tools-builtin");
    const mcpTab = container.querySelector<HTMLButtonElement>("#tab-tools-mcp");

    expect(builtinTab).not.toBeNull();
    expect(mcpTab).not.toBeNull();
    expect(builtinTab?.textContent).toContain("33");
    expect(builtinTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("renders all 33 built-in tools on the default tab", () => {
    renderSection();

    const cards = container.querySelectorAll(".connections-tool-card");
    expect(cards.length).toBe(BUILTIN_AGENT_TOOLS.length);
    expect(cards.length).toBe(33);
  });

  it("filters tools by domain chip", () => {
    renderSection();

    // Click Calendar filter
    const calendarBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".connections-shell-tab")).find(
      (btn) => btn.textContent?.includes("日程日历"),
    );
    expect(calendarBtn).not.toBeNull();

    act(() => {
      calendarBtn!.click();
    });

    let cards = container.querySelectorAll(".connections-tool-card");
    expect(cards.length).toBe(4);
    expect(container.textContent).toContain("calendar.list");
    expect(container.textContent).toContain("calendar.create");

    // Click Contacts filter
    const contactsBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".connections-shell-tab")).find(
      (btn) => btn.textContent?.includes("通讯录"),
    );
    act(() => {
      contactsBtn!.click();
    });

    cards = container.querySelectorAll(".connections-tool-card");
    expect(cards.length).toBe(4);
    expect(container.textContent).toContain("contacts.search");

    // Click Mail filter
    const mailBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".connections-shell-tab")).find(
      (btn) => btn.textContent?.includes("邮件管理"),
    );
    act(() => {
      mailBtn!.click();
    });

    cards = container.querySelectorAll(".connections-tool-card");
    expect(cards.length).toBe(17);

    // Click All filter
    const allBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".connections-shell-tab")).find(
      (btn) => btn.textContent?.includes("全部"),
    );
    act(() => {
      allBtn!.click();
    });

    cards = container.querySelectorAll(".connections-tool-card");
    expect(cards.length).toBe(33);
  });

  it("filters tools by search query", () => {
    renderSection();

    const searchInput = container.querySelector<HTMLInputElement>("input[type='search']");
    expect(searchInput).not.toBeNull();

    act(() => {
      // Simulate typing "draft"
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(searchInput, "draft");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const cards = container.querySelectorAll(".connections-tool-card");
    expect(cards.length).toBe(3); // draft.create, draft.update, draft.delete
    expect(container.textContent).toContain("mail.draft.create");
    expect(container.textContent).toContain("mail.draft.update");
    expect(container.textContent).toContain("mail.draft.delete");
  });

  it("reflects read-only access level policy by locking write tools", () => {
    renderSection({
      currentSettings: {
        ...defaultAppSettings,
        agentAccessLevel: "read-only",
      },
    });

    expect(container.textContent).toContain("只读模式");
    const lockedBadges = container.querySelectorAll(".connections-tool-badge.write.locked");
    // All write tools should be locked (8 mail + 3 calendar + 3 contact + 4 memory + 1 settings = 19)
    // 8 mail + 3 calendar + 3 contact + 3 memory + 1 settings = 18
    expect(lockedBadges.length).toBe(18);
  });

  it("calls onSelectCategory when clicking configure button in banner", () => {
    const onSelectCategory = vi.fn();

    renderSection({ onSelectCategory });

    const configureBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (btn) => btn.textContent?.includes("调整权限"),
    );
    expect(configureBtn).not.toBeNull();

    act(() => {
      configureBtn!.click();
    });

    expect(onSelectCategory).toHaveBeenCalledWith("agent");
  });

  it("switches to MCP tab and renders data-models-card='mcp'", () => {
    renderSection();

    const mcpTab = container.querySelector<HTMLButtonElement>("#tab-tools-mcp");
    expect(mcpTab).not.toBeNull();

    act(() => {
      mcpTab!.click();
    });

    expect(container.querySelector('[data-models-card="mcp"]')).not.toBeNull();
    expect(container.textContent).toContain(t("agent.mcpServers.new"));
  });

  it("creates and checks an MCP server through its own card", async () => {
    mockApi.agentMcpServers.mockResolvedValue({ items: [mcpServer] });
    mockApi.createAgentMcpServer.mockImplementation(
      async (input) => ({ ...mcpServer, ...input, id: "mcp-new" } as AgentMcpServerSummary),
    );
    await renderLoadedMcp();

    click(query<HTMLButtonElement>("#tab-tools-mcp"));
    await flush();
    click(query<HTMLButtonElement>('[data-models-card="mcp"] .settings-inline-actions button'));
    expect(container.querySelector('[data-models-form="mcp"]')).not.toBeNull();

    type(query<HTMLInputElement>("#mcp-server-label"), "filesystem");
    type(query<HTMLInputElement>("#mcp-server-command"), "npx");
    type(query<HTMLTextAreaElement>("#mcp-server-args"), "-y\n\n@modelcontextprotocol/server-filesystem");
    type(query<HTMLInputElement>("#mcp-server-cwd"), "/tmp");
    const envInputs = container.querySelectorAll<HTMLInputElement>(".settings-model-env-line input");
    type(envInputs[0]!, "TOKEN");
    type(envInputs[1]!, " secret-value ");
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
    mockApi.agentMcpServers.mockResolvedValue({ items: [mcpServer] });
    mockApi.updateAgentMcpServer.mockImplementation(
      async (id, input) => ({ ...mcpServer, ...input, id } as AgentMcpServerSummary),
    );
    await renderLoadedMcp();

    click(query<HTMLButtonElement>("#tab-tools-mcp"));
    await flush();
    click(byText('[data-mcp-id="mcp-1"] .secondary-button', t("settings.models.edit"))!);
    await flush();
    // The saved key plus one spare row.
    expect(container.querySelectorAll(".settings-model-env-line")).toHaveLength(2);

    click(query<HTMLButtonElement>(".settings-model-env-line .icon-button"));
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
    await renderLoadedMcp();

    click(query<HTMLButtonElement>("#tab-tools-mcp"));
    await flush();
    click(query<HTMLButtonElement>('[data-models-card="mcp"] .settings-inline-actions button'));
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
    await renderLoadedMcp();

    click(query<HTMLButtonElement>("#tab-tools-mcp"));
    await flush();
    click(query<HTMLButtonElement>('[data-models-card="mcp"] .settings-inline-actions button'));
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

  it("deletes an MCP server only after the confirm step", async () => {
    mockApi.agentMcpServers.mockResolvedValue({ items: [mcpServer] });
    await renderLoadedMcp();

    click(query<HTMLButtonElement>("#tab-tools-mcp"));
    await flush();
    click(byText('[data-mcp-id="mcp-1"] .danger-button', t("agent.mcpServers.delete"))!);
    expect(mockApi.deleteAgentMcpServer).not.toHaveBeenCalled();

    click(byText('[data-mcp-id="mcp-1"] .danger-button', t("agent.mcpServers.deleteConfirm"))!);
    await flush();
    expect(mockApi.deleteAgentMcpServer).toHaveBeenCalledWith("mcp-1");
  });
});
