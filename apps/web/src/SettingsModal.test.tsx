import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "./i18n";
import SettingsModal, { expandedThemedSelectOwnsEscape } from "./SettingsModal";
import { defaultAppSettings } from "./types";

const zh = (key: string) => translate("zh-CN", key);

function renderSettings(demoMode: boolean): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <SettingsModal
        settings={defaultAppSettings}
        accounts={[]}
        demoMode={demoMode}
        onClose={() => undefined}
        onSettingsChange={() => undefined}
        onAccountRemoved={() => undefined}
        onOpenAgentProviderSettings={() => undefined}
      />
    </I18nProvider>,
  );
}

describe("settings model provider entry", () => {
  it("exposes the existing model-provider manager from settings", () => {
    const markup = renderSettings(false);

    expect(markup).toContain('id="agent-settings"');
    expect(markup).toContain(zh("agent.launch"));
    expect(markup).toContain(zh("agent.providers.title"));
    expect(markup).toContain(zh("agent.providers.configure"));
    expect(markup).toContain('class="setting-row agent-provider-settings-row"');
  });

  it("does not offer a nonfunctional model configuration route in demo mode", () => {
    const markup = renderSettings(true);

    expect(markup).toContain(zh("agent.demo.actionUnavailable"));
    expect(markup).not.toContain(zh("agent.providers.configure"));
  });
});

describe("settings Escape handling", () => {
  it("leaves Escape to an expanded themed select when capture retargets the key event", () => {
    const combobox = {};
    const control = {
      querySelector: vi.fn((selector: string) => selector === '[role="combobox"][aria-expanded="true"]' ? combobox : null),
    } as unknown as Element;
    const activeSelect = {
      closest: vi.fn((selector: string) => selector === ".select-control" ? control : null),
    } as unknown as Element;

    expect(expandedThemedSelectOwnsEscape(null, activeSelect)).toBe(true);
  });
});
