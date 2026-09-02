import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Copy, Minus, Moon, Square, Sun, X } from "lucide-react";
import { desktopBridge } from "./desktop";
import type { Translate } from "./i18n";
import { IconButton } from "./mailUi";

type WindowBarProps = {
  /** Current locale translate function. */
  t: Translate;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  /** Host platform injected by the desktop shell; undefined in the browser. */
  platform?: string;
  isDesktop: boolean;
};

/**
 * The app-owned title bar. In the browser it shows the app name plus the
 * theme switch, exactly as before. In the desktop shell it doubles as the
 * drag region of the frameless window: Windows/Linux draw their own
 * minimize/maximize(restore)/close buttons, macOS keeps the native traffic
 * lights and only reserves a leading slot for them.
 */
export function WindowBar({ t, theme, onToggleTheme, platform, isDesktop }: WindowBarProps) {
  const bridge = isDesktop ? desktopBridge() : undefined;
  const drawsControls = isDesktop && platform !== "darwin";
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isDesktop || !bridge?.isWindowMaximized) return;
    let disposed = false;
    void bridge.isWindowMaximized().then((value) => {
      if (!disposed) setMaximized(value);
    });
    const unsubscribe = bridge.onMaximizedChange?.((value) => setMaximized(value));
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [bridge, isDesktop]);

  const handleBarDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // Double-clicks on the actions (pill, controls) must not maximize.
    if (event.target instanceof HTMLElement && event.target.closest(".window-actions")) return;
    // macOS zoom is left to the native traffic-light region.
    if (platform === "darwin") return;
    bridge?.toggleMaximizeWindow?.();
  };

  // 窗口控制按钮（最小化/最大化/关闭）。在桌面端，它们直接渲染在
  // `.window-bar` 中，这是一个固定在窗口右上角的 overlay。
  // CSS 确保按钮位置在所有视图中一致，不会继承页面 header 的过渡动画。
  const controls = drawsControls && bridge?.minimizeWindow ? (
    <div className="window-controls">
      <IconButton className="window-control" label={t("app.windowMinimize")} onClick={() => bridge.minimizeWindow?.()}>
        <Minus size={16} />
      </IconButton>
      <IconButton className="window-control" label={maximized ? t("app.windowRestore") : t("app.windowMaximize")} onClick={() => bridge.toggleMaximizeWindow?.()}>
        {maximized ? <Copy size={14} /> : <Square size={13} />}
      </IconButton>
      <IconButton className="window-control window-control-close" label={t("app.windowClose")} onClick={() => bridge.closeWindow?.()}>
        <X size={16} />
      </IconButton>
    </div>
  ) : null;

  if (isDesktop) {
    return (
      <div className="window-bar" onDoubleClick={handleBarDoubleClick}>
        {platform === "darwin" && <div className="window-control-slot" aria-hidden="true" />}
        {controls}
      </div>
    );
  }

  return (
    <div className="window-bar" onDoubleClick={handleBarDoubleClick}>
      <span className="window-title">Nami Mail</span>
      <div className="window-actions">
        <span className="local-pill"><span /> {t("app.localEncryption")}</span>
        <IconButton label={theme === "light" ? t("app.switchDark") : t("app.switchLight")} onClick={onToggleTheme}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</IconButton>
        {controls}
      </div>
    </div>
  );
}