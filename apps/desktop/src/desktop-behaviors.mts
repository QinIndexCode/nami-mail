/**
 * Desktop-only behaviors owned by the main process but driven by the
 * renderer settings (and by new-mail events arriving from the sync service):
 *
 * - the tray icon swaps to a badge-dot variant while new mail arrived and
 *   the window is not focused, and clears as soon as the window is focused,
 * - the login item registers Nami Mail at system sign-in,
 * - the global shortcut focuses the mail window from any application.
 *
 * Each policy is a small pure adapter over an injected API so the platform
 * branches and value normalization can be unit-tested without Electron.
 */

export const FOCUS_GLOBAL_SHORTCUT_ACCELERATOR = "CommandOrControl+Shift+M";

/**
 * Tray "new mail" dot. The badge reflects presence, not the unread count: it
 * lights up when a new-mail batch arrives while the window is not focused and
 * goes off the moment the window is focused again. All platforms share the
 * same rule and the same presentation (a swapped-in tray icon), so the policy
 * is a plain boolean over a single event.
 */
export type TrayBadgeEvent =
  | { type: "new-mail"; windowFocused: boolean }
  | { type: "window-focused" };

export function nextTrayBadge(event: TrayBadgeEvent): boolean {
  if (event.type === "window-focused") return false;
  return !event.windowFocused;
}

export type TrayIconApi = {
  /** Swaps the tray to the icon with the white dot. */
  setBadgeIcon: () => void;
  /** Swaps the tray back to the plain application icon. */
  setPlainIcon: () => void;
};

export function applyTrayBadge(api: TrayIconApi, visible: boolean): void {
  if (visible) api.setBadgeIcon();
  else api.setPlainIcon();
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

/**
 * System tray menu policy: the tray offers window visibility, the two most
 * frequent mail actions, and quit. The menu template stays a pure value so
 * main.mts only maps labels and actions onto Electron's Menu types.
 */
export type TrayMenuAction =
  | { kind: "toggle-window" }
  | { kind: "compose-new" }
  | { kind: "open-inbox" }
  | { kind: "quit" };

export type TrayMenuItem =
  | { type: "separator" }
  | { type: "item"; label: string; action: TrayMenuAction };

export type TrayMenuLabels = {
  /** Shown while the window is visible; clicking hides it to the tray. */
  hide: string;
  /** Shown while the window is hidden; clicking restores and focuses it. */
  show: string;
  newMail: string;
  inbox: string;
  quit: string;
};

export function resolveTrayVisibilityAction(windowVisible: boolean): "show" | "hide" {
  return windowVisible ? "hide" : "show";
}

export function buildTrayMenuTemplate(labels: TrayMenuLabels, windowVisible: boolean): TrayMenuItem[] {
  return [
    {
      type: "item",
      label: windowVisible ? labels.hide : labels.show,
      action: { kind: "toggle-window" },
    },
    { type: "separator" },
    { type: "item", label: labels.newMail, action: { kind: "compose-new" } },
    { type: "item", label: labels.inbox, action: { kind: "open-inbox" } },
    { type: "separator" },
    { type: "item", label: labels.quit, action: { kind: "quit" } },
  ];
}

/**
 * The mailto protocol hand-off comes from three places: the command line of a
 * cold start, the second-instance command line of a warm start, and (on
 * macOS) the open-url event. All of them arrive as an argv-style token list,
 * so one extractor covers every path.
 */
export function extractMailtoUrl(args: readonly string[]): string | undefined {
  for (const token of args) {
    // Windows may wrap the argument in quotes; strip them before decoding.
    const candidate = String(token).replace(/^"|"$/g, "");
    if (!candidate.toLowerCase().startsWith("mailto:")) continue;
    // A bare "mailto:" carries no address or parameters; nothing to compose.
    if (candidate.length <= "mailto:".length) continue;
    if (candidate.length > 8192) continue;
    try {
      if (new URL(candidate).protocol.toLowerCase() !== "mailto:") continue;
      // The URL parser accepts permissive opaque paths, so additionally
      // require valid percent-encoding to keep corrupted tokens out.
      decodeURIComponent(candidate);
    } catch {
      continue;
    }
    return candidate;
  }
  return undefined;
}