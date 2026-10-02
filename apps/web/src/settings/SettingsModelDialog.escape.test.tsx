// @vitest-environment jsdom
/**
 * Escape / close layering for the settings "models" form dialog, measured from
 * the outside: the panel only reports one "an overlay is up" flag, and this is
 * what that flag has to buy. A form stacked over the settings modal must own
 * the interaction — Escape peels the form (then its discard confirmation), and
 * the settings modal itself never closes underneath it — while a save in flight
 * freezes every layer.
 *
 * This is the regression net for the flag that never fired: with the settings
 * modal still listening, one Escape closed everything and the draft went with
 * it, silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentMcpServerSummary, AgentProviderSummary } from "../agentTypes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  local: {
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
  } as AgentProviderSummary,
  server: {
    id: "mcp-1",
    label: "filesystem",
    command: "npx",
    args: [],
    envKeys: [],
    timeoutMs: 30_000,
    enabled: true,
    toolNames: [],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  } as AgentMcpServerSummary,
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
    agentPairings: vi.fn(),
    translationConfiguration: vi.fn(),
    updateSettings: vi.fn(),
    updateTranslationConfiguration: vi.fn(),
    removeTranslationConfiguration: vi.fn(),
  },
}));

import { api } from "../api";
import { I18nProvider, translate } from "../i18n";
import SettingsModal from "../SettingsModal";
import { defaultAppSettings } from "../types";

const mockApi = vi.mocked(api);
const t = (key: string) => translate("zh-CN", key);

let container: HTMLDivElement;
let root: Root | null = null;
let onClose: Mock<() => void>;

beforeEach(() => {
  // Node 24 exposes a `--localstorage-file`-gated global that shadows jsdom's,
  // so the settings category restore needs its own store here.
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => store.clear(),
    },
    configurable: true,
  });
  store.set("nami.settings.category", "models");
  container = document.createElement("div");
  document.body.append(container);
  onClose = vi.fn();
  mockApi.agentProviders.mockResolvedValue({ items: [h.local], defaultProviderId: h.local.id });
  mockApi.agentMcpServers.mockResolvedValue({ items: [h.server] });
  mockApi.agentPairings.mockResolvedValue({ pairings: [] });
  mockApi.translationConfiguration.mockResolvedValue({
    ok: true,
    enabled: false,
    endpoint: "",
    apiKeyConfigured: false,
    source: "none",
    timeoutMs: 25_000,
    primary: "google",
    backup: "mymemory",
    providers: [],
  });
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

/** Outlasts the 170 ms dismiss transition the dialogs animate through. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { window.setTimeout(resolve, 320); });
  });
}

async function mountSettings(props: Partial<React.ComponentProps<typeof SettingsModal>> = {}): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider>
        <SettingsModal
          settings={defaultAppSettings}
          accounts={[]}
          demoMode={false}
          onClose={onClose}
          onSettingsChange={() => undefined}
          {...props}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

/** Same mounted modal, new props — how a deep link arrives mid-session. */
async function updateSettings(props: Partial<React.ComponentProps<typeof SettingsModal>>): Promise<void> {
  await act(async () => {
    root!.render(
      <I18nProvider>
        <SettingsModal
          settings={defaultAppSettings}
          accounts={[]}
          demoMode={false}
          onClose={onClose}
          onSettingsChange={() => undefined}
          {...props}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

const query = <T extends Element>(selector: string): T => {
  const node = container.querySelector<T>(selector);
  if (!node) throw new Error(`${selector} not found`);
  return node;
};
const settingsDialog = () => container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="settings-title"]');
const modelForm = () => container.querySelector<HTMLElement>('[data-models-form="provider"]');
const discardPrompt = () => container.querySelector<HTMLElement>('[role="alertdialog"][aria-labelledby="models-discard-title"]');
const headerClose = () => query<HTMLButtonElement>(".settings-heading .icon-button");
const doneButton = () => query<HTMLButtonElement>(".settings-footer .primary-button");

function click(node: HTMLElement): void {
  act(() => node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

function pressEscape(): void {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("no value setter");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function openProviderForm(): void {
  click(query('[data-models-card="providers"] .settings-inline-actions button'));
  if (!modelForm()) throw new Error("provider form did not open");
}

const byText = (selector: string, text: string) =>
  Array.from(container.querySelectorAll<HTMLElement>(selector)).find((node) => node.textContent?.includes(text));

/** A press on the backdrop itself, which is what closes an idle form. */
function pressBackdrop(): void {
  const backdrop = container.querySelector<HTMLElement>(".contact-editor-backdrop");
  if (!backdrop) throw new Error("form backdrop not found");
  act(() => backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
}

/** Fills the minimum the provider form validates, which marks it dirty. */
function fillValidProviderForm(): void {
  type(query<HTMLInputElement>("#agent-provider-label"), "团队模型");
  type(query<HTMLInputElement>("#agent-provider-endpoint"), "https://models.example.test/v1");
  type(query<HTMLInputElement>("#agent-provider-model"), "nami-chat");
}

describe("models form dialog layers over the settings modal", () => {
  it("keeps the settings modal open while a clean form closes on Escape", async () => {
    await mountSettings();
    openProviderForm();

    pressEscape();
    await settle();

    // The form closed; the modal that hosts it did not.
    expect(modelForm()).toBeNull();
    expect(settingsDialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // And with the overlay gone the modal answers Escape again.
    pressEscape();
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("peels the discard confirmation off a dirty form before the form itself", async () => {
    await mountSettings();
    openProviderForm();
    fillValidProviderForm();

    pressEscape();
    await settle();

    expect(discardPrompt()).not.toBeNull();
    expect(modelForm()).not.toBeNull();
    expect(settingsDialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    pressEscape();
    await settle();

    // Second Escape takes the prompt only: the draft is still held.
    expect(discardPrompt()).toBeNull();
    expect(modelForm()).not.toBeNull();
    expect(settingsDialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses the settings header close and \"done\" while a form is stacked over it", async () => {
    await mountSettings();
    openProviderForm();
    fillValidProviderForm();

    click(headerClose());
    click(doneButton());
    await settle();

    expect(settingsDialog()).not.toBeNull();
    expect(modelForm()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // Dismissing the draft (cancel → confirm the discard) hands the
    // interaction back to the settings modal.
    click(query('[data-models-form="provider"] .contact-editor-actions .secondary-button'));
    await settle();
    expect(discardPrompt()).not.toBeNull();
    click(query('[role="alertdialog"][aria-labelledby="models-discard-title"] .confirmation-actions .danger-button'));
    await settle();
    expect(modelForm()).toBeNull();

    click(doneButton());
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("freezes every layer while a save is in flight", async () => {
    mockApi.createAgentProvider.mockReturnValue(new Promise(() => undefined));
    await mountSettings();
    openProviderForm();
    fillValidProviderForm();

    await act(async () => {
      query<HTMLFormElement>('[data-models-form="provider"]').dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await flush();

    // The pending save is what disables the settings modal's own controls.
    expect(doneButton().disabled).toBe(true);
    expect(modelForm()).not.toBeNull();

    pressEscape();
    await settle();
    click(headerClose());
    await settle();

    expect(modelForm()).not.toBeNull();
    expect(settingsDialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("releases the busy latch when the panel unmounts mid-save", async () => {
    // The settings panel is keyed by category, so switching categories mid-save
    // tears the form down without it ever getting to report its own end. If the
    // busy flag had no unmount cleanup the whole settings modal would stay
    // disabled for the rest of the session.
    mockApi.createAgentProvider.mockReturnValue(new Promise(() => undefined));
    await mountSettings();
    openProviderForm();
    fillValidProviderForm();

    await act(async () => {
      query<HTMLFormElement>('[data-models-form="provider"]').dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await flush();
    expect(doneButton().disabled).toBe(true);

    click(query("#settings-nav-agent"));
    await settle();

    expect(modelForm()).toBeNull();
    expect(doneButton().disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("freezes the settings modal while a row-level check is in flight", async () => {
    // Row actions never go through the form dialog, so the panel has to report
    // their busy state on the same single flag: a check can occupy the whole
    // 120 s timeout, and closing underneath it throws the result away.
    mockApi.checkAgentProvider.mockReturnValue(new Promise(() => undefined));
    await mountSettings();

    click(byText('[data-provider-id="provider-local"] .secondary-button', t("agent.providers.check"))!);
    await flush();
    expect(doneButton().disabled).toBe(true);

    pressEscape();
    await settle();
    click(headerClose());
    click(doneButton());
    await settle();

    expect(settingsDialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores the backdrop press a double-click on \"add model\" produces", async () => {
    // The second mousedown of the opening double-click lands on the full-screen
    // backdrop the first click just mounted, and used to close the form again
    // before anything could be typed.
    await mountSettings();
    openProviderForm();

    pressBackdrop();
    await settle();
    expect(modelForm()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // A deliberate backdrop dismissal — a later, separate gesture — still works.
    pressBackdrop();
    await settle();
    expect(modelForm()).toBeNull();
    expect(settingsDialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables the header close and \"done\" while a model form is stacked over the modal", async () => {
    await mountSettings();
    openProviderForm();

    // Silently ignoring the click read as a broken button; now it looks inert
    // and says what it is waiting for.
    expect(headerClose().disabled).toBe(true);
    expect(doneButton().disabled).toBe(true);
    expect(headerClose().getAttribute("data-tooltip")).toBe(t("settings.models.formOpenHint"));
    expect(doneButton().getAttribute("data-tooltip")).toBe(t("settings.models.formOpenHint"));
  });

  it("holds a deep link back until the stacked model form is gone", async () => {
    // categoryRequest is an external switch source: applying it would key the
    // panel to a new category and unmount the open form, dropping the draft
    // (write-only API keys included) without asking.
    await mountSettings();
    openProviderForm();
    fillValidProviderForm();

    await updateSettings({ categoryRequest: { category: "agent", nonce: 3 } });
    expect(modelForm()).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="models"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="agent"]')).toBeNull();

    // Discarding the draft hands the interaction back, and the queued deep link
    // lands on the very next render.
    click(query('[data-models-form="provider"] .contact-editor-actions .secondary-button'));
    await settle();
    click(query('[role="alertdialog"][aria-labelledby="models-discard-title"] .confirmation-actions .danger-button'));
    await settle();

    expect(modelForm()).toBeNull();
    expect(container.querySelector('[data-settings-nav="agent"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="models"]')).toBeNull();
  });
});