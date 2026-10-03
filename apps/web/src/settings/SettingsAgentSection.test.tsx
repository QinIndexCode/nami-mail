// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentProviderSummary } from "../agentTypes";

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
  return { local, cloud };
});

vi.mock("../api", () => ({
  api: {
    agentProviders: vi.fn(),
    agentPairings: vi.fn(async () => ({ pairings: [] })),
  },
}));

import { api } from "../api";
import { I18nProvider, translate } from "../i18n";
import { defaultAppSettings } from "../types";
import SettingsAgentSection from "./SettingsAgentSection";

const mockApi = vi.mocked(api);
const t = (key: string, values?: Record<string, unknown>) => translate("zh-CN", key, values as never);

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  mockApi.agentProviders.mockResolvedValue({ items: [h.local, h.cloud], defaultProviderId: h.local.id });
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  vi.clearAllMocks();
});

describe("SettingsAgentSection auto-reply decoupled model configuration", () => {
  it("renders decision and draft model selectors when auto-reply is enabled in LLM mode", async () => {
    const applyOptimistic = vi.fn(async () => undefined);
    const settings = {
      ...defaultAppSettings,
      autoReply: {
        ...defaultAppSettings.autoReply,
        enabled: true,
        mode: "llm" as const,
        decisionProviderId: null,
        draftProviderId: null,
      },
    };

    await act(async () => {
      root = createRoot(container);
      root.render(
        <I18nProvider>
          <SettingsAgentSection
            t={t}
            formatDate={(s) => s}
            accounts={[]}
            currentSettings={settings}
            controlsBusy={false}
            demoMode={false}
            openModelSettings={vi.fn()}
            requestAccessLevelChange={vi.fn()}
            applyOptimisticSettings={applyOptimistic}
            externalGuideCopied={null}
            setExternalGuideCopied={vi.fn()}
            externalPairings={[]}
            externalPairingsError={null}
            setExternalPairingsReload={vi.fn()}
            setAutoReplyDialogOpen={vi.fn()}
            setAutoReplyDecisionsOpen={vi.fn()}
            setMemoryDialogOpen={vi.fn()}
            setAutoReplySandboxOpen={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    // Wait for the async agentProviders fetch to resolve and re-render
    await act(async () => {
      await Promise.resolve();
    });

    // Verify both combobox buttons are rendered
    const decisionTrigger = container.querySelector("#agent-auto-reply-decision-provider") as HTMLButtonElement | null;
    const draftTrigger = container.querySelector("#agent-auto-reply-draft-provider") as HTMLButtonElement | null;

    expect(decisionTrigger).not.toBeNull();
    expect(draftTrigger).not.toBeNull();

    // Default label shows fallback to default provider
    expect(decisionTrigger?.querySelector(".themed-select-value")?.textContent).toContain("跟随默认模型 (本机 Ollama)");
    expect(draftTrigger?.querySelector(".themed-select-value")?.textContent).toContain("跟随默认模型 (本机 Ollama)");

    // Open decision dropdown and select the cloud model
    await act(async () => {
      decisionTrigger?.click();
    });

    const menu = container.querySelector('[role="listbox"]');
    expect(menu).not.toBeNull();
    const options = Array.from(menu!.querySelectorAll('[role="option"]'));
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent).toContain("跟随默认模型 (本机 Ollama)");
    expect(options[1]?.textContent).toContain("本机 Ollama (llama3.2) · 默认");
    expect(options[2]?.textContent).toContain("团队模型 (nami-chat)");

    // Click the cloud model
    await act(async () => {
      (options[2] as HTMLElement).click();
    });

    expect(applyOptimistic).toHaveBeenCalledWith(
      expect.objectContaining({
        autoReply: expect.objectContaining({
          decisionProviderId: "provider-cloud",
        }),
      }),
      null,
    );

    // Open draft dropdown and select the local model
    const draftControl = draftTrigger!.closest(".select-control")!;
    await act(async () => {
      draftTrigger?.click();
    });

    const draftMenu = draftControl.querySelector('[role="listbox"]');
    const draftOptions = Array.from(draftMenu!.querySelectorAll('[role="option"]'));
    await act(async () => {
      (draftOptions[1] as HTMLElement).click();
    });

    expect(applyOptimistic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        autoReply: expect.objectContaining({
          draftProviderId: "provider-local",
        }),
      }),
      null,
    );
  });

  it("does not render model selectors when auto-reply is in template mode", async () => {
    const settings = {
      ...defaultAppSettings,
      autoReply: {
        ...defaultAppSettings.autoReply,
        enabled: true,
        mode: "template" as const,
      },
    };

    await act(async () => {
      root = createRoot(container);
      root.render(
        <I18nProvider>
          <SettingsAgentSection
            t={t}
            formatDate={(s) => s}
            accounts={[]}
            currentSettings={settings}
            controlsBusy={false}
            demoMode={false}
            openModelSettings={vi.fn()}
            requestAccessLevelChange={vi.fn()}
            applyOptimisticSettings={vi.fn()}
            externalGuideCopied={null}
            setExternalGuideCopied={vi.fn()}
            externalPairings={[]}
            externalPairingsError={null}
            setExternalPairingsReload={vi.fn()}
            setAutoReplyDialogOpen={vi.fn()}
            setAutoReplyDecisionsOpen={vi.fn()}
            setMemoryDialogOpen={vi.fn()}
            setAutoReplySandboxOpen={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    const decisionTrigger = container.querySelector("#agent-auto-reply-decision-provider");
    const draftTrigger = container.querySelector("#agent-auto-reply-draft-provider");

    expect(decisionTrigger).toBeNull();
    expect(draftTrigger).toBeNull();
  });
});
