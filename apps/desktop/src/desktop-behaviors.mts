/**
 * Desktop-only behaviors owned by the main process but driven by the
 * renderer settings (and by the total unread count the renderer reports):
 *
 * - the OS badge / taskbar overlay mirrors the unread count,
 * - the login item registers Nami Mail at system sign-in,
 * - the global shortcut focuses the mail window from any application.
 *
 * Each policy is a small pure adapter over an injected API so the platform
 * branches and value normalization can be unit-tested without Electron.
 */

export const FOCUS_GLOBAL_SHORTCUT_ACCELERATOR = "CommandOrControl+Shift+M";

// 16x16 red dot rendered ahead of time so the Windows taskbar overlay needs
// no runtime image generation. macOS/Linux instead use the native badge API.
export const BADGE_OVERLAY_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWUlEQVR42mN4aKXHQAlmoJUBJUB8Goh/QvFpqBhBA5Sgiv/jwKehanAagE8zsiFYDSghQjMMl2Az4DQJBpzGZsBPEgz4SRMDKPYCxYFIcTRSJSFRnJTpnxsBQfO5WDWa9GwAAAAASUVORK5CYII=";

export type UnreadBadgeApi = {
  platform: NodeJS.Platform;
  setBadgeCount: (count: number) => void;
  setOverlayIcon: (overlay: unknown | null, description: string) => void;
  /** Creates the overlay image only when a badge should be visible. */
  createOverlayIcon: () => unknown;
  overlayDescription: () => string;
};

export function normalizeUnreadBadgeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value > 0 ? Math.floor(value) : 0;
}

export function applyUnreadBadge(api: UnreadBadgeApi, count: number): void {
  const safeCount = normalizeUnreadBadgeCount(count);
  if (api.platform === "darwin" || api.platform === "linux") {
    // macOS dock and Linux launcher expose the native badge count.
    api.setBadgeCount(safeCount);
    return;
  }
  if (api.platform === "win32") {
    // Windows has no badge API; the taskbar overlay dot is the equivalent.
    api.setOverlayIcon(safeCount > 0 ? api.createOverlayIcon() : null, safeCount > 0 ? api.overlayDescription() : "");
  }
}

export type LaunchAtStartupApi = {
  platform: NodeJS.Platform;
  setLoginItemSettings: (options: { openAtLogin: boolean; openAsHidden: boolean }) => void;
};

export function applyLaunchAtStartup(api: LaunchAtStartupApi, enabled: boolean): void {
  if (api.platform !== "darwin" && api.platform !== "win32") return; // Linux has no login-item API.
  api.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false });
}

export type GlobalShortcutApi = {
  isRegistered: (accelerator: string) => boolean;
  register: (accelerator: string, listener: () => void) => boolean;
  unregister: (accelerator: string) => void;
};

export function applyGlobalShortcut(
  api: GlobalShortcutApi,
  enabled: boolean,
  accelerator: string,
  listener: () => void,
): boolean {
  if (enabled) {
    if (api.isRegistered(accelerator)) return true;
    const registered = api.register(accelerator, listener);
    if (!registered) {
      // The accelerator may be taken by another application; the setting
      // stays on so a later toggle attempt triggers registration again.
      return false;
    }
    return true;
  }
  if (api.isRegistered(accelerator)) {
    api.unregister(accelerator);
  }
  return true;
}