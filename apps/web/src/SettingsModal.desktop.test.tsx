import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "./i18n";
import SettingsModal from "./SettingsModal";
import { defaultAppSettings } from "./types";

const zh = (key: string) => translate("zh-CN", key);

// Simulates the desktop renderer URL (?desktop=1) so the desktop-only
// settings section is rendered. Must run before SettingsModal is imported.
vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: { location: { search: "?desktop=1" } },
    configurable: true,
  });
});

describe("settings desktop behaviors", () => {
  it("renders the launch-at-startup and global shortcut toggles in desktop mode", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <SettingsModal
          settings={defaultAppSettings}
          accounts={[]}
          demoMode={false}
          onClose={() => undefined}
          onSettingsChange={() => undefined}
          onOpenAgentProviderSettings={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('data-settings-nav="desktop"');
    expect(markup).toContain("settings-option-grid close-behavior-grid");
    expect(markup).toContain(zh("settings.launchAtStartup.label"));
    expect(markup).toContain(zh("settings.launchAtStartup.description"));
    expect(markup).toContain(zh("settings.shortcut.label"));
    expect(markup).toContain(zh("settings.shortcut.description"));
    expect(markup).toContain(`aria-label="${zh("settings.launchAtStartup.label")}"`);
    expect(markup).toContain(`aria-label="${zh("settings.shortcut.label")}"`);
  });

  it("reflects the persisted launch and shortcut settings in the toggle state", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <SettingsModal
          settings={{ ...defaultAppSettings, launchAtStartup: true, globalShortcutEnabled: true }}
          accounts={[]}
          demoMode={false}
          onClose={() => undefined}
          onSettingsChange={() => undefined}
          onOpenAgentProviderSettings={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('class="setting-switch active"');
  });
});