import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { translate } from "./i18n";
import { WindowBar } from "./WindowBar";

const zh = (key: string) => translate("zh-CN", key);

function stubDesktopBridge(): void {
  // The WindowBar only probes bridge method presence during render; the
  // maximize-state subscription runs in an effect, which SSR never fires.
  (globalThis as { window?: unknown }).window = {
    namiDesktop: {
      minimizeWindow: () => undefined,
      toggleMaximizeWindow: () => undefined,
      closeWindow: () => undefined,
      isWindowMaximized: async () => false,
      onMaximizedChange: () => () => undefined,
    },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function renderWindowBar(options: { isDesktop?: boolean; platform?: string; withBridge?: boolean } = {}): string {
  if (options.withBridge) stubDesktopBridge();
  return renderToStaticMarkup(
    <WindowBar
      t={zh}
      theme="dark"
      onToggleTheme={() => undefined}
      platform={options.platform}
      isDesktop={options.isDesktop ?? false}
    />,
  );
}

describe("window bar", () => {
  it("keeps the browser layout: title, encryption pill, and theme switch with no window controls", () => {
    const markup = renderWindowBar();

    expect(markup).toContain("Nami Mail");
    expect(markup).toContain(zh("app.localEncryption"));
    expect(markup).toContain(zh("app.switchLight"));
    expect(markup).not.toContain("window-controls");
    expect(markup).not.toContain("window-control-slot");
  });

  it("draws the frameless window controls on Windows with localized labels", () => {
    const markup = renderWindowBar({ isDesktop: true, platform: "win32", withBridge: true });

    expect(markup).toContain("window-controls");
    expect(markup).toContain(`aria-label="${zh("app.windowMinimize")}"`);
    expect(markup).toContain(`aria-label="${zh("app.windowMaximize")}"`);
    expect(markup).toContain(`aria-label="${zh("app.windowClose")}"`);
    expect(markup).toContain("window-control-close");
    // The desktop bar stays minimal: no app name, no encryption pill, no
    // theme switch (all live elsewhere in the desktop UI already).
    expect(markup).not.toContain("Nami Mail");
    expect(markup).not.toContain(zh("app.localEncryption"));
    expect(markup).not.toContain(zh("app.switchLight"));
    expect(markup).not.toContain("window-control-slot");
  });

  it("reserves only the traffic-light slot on macOS and draws no controls", () => {
    const markup = renderWindowBar({ isDesktop: true, platform: "darwin", withBridge: true });

    expect(markup).toContain("window-control-slot");
    expect(markup).not.toContain("window-controls");
  });

  it("treats a missing platform as non-mac and still draws controls", () => {
    const markup = renderWindowBar({ isDesktop: true, withBridge: true });

    expect(markup).toContain("window-controls");
  });

  it("degrades to no controls when the desktop bridge is absent", () => {
    const markup = renderWindowBar({ isDesktop: true, platform: "win32" });

    expect(markup).not.toContain("window-controls");
    expect(markup).not.toContain(zh("app.localEncryption"));
  });
});