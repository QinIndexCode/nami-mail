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
    agentMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    checkAgentMcpServer: vi.fn().mockResolvedValue({ ok: true }),
    saveAgentMcpServer: vi.fn().mockResolvedValue({ ok: true }),
    deleteAgentMcpServer: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const t = (key: string, params?: Record<string, unknown>) => translate("zh-CN", key, params as never);

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
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
});
