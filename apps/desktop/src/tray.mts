import { Menu, Tray, app, nativeImage, type BrowserWindow, type NativeImage } from "electron";
import path from "node:path";
import {
  applyTrayBadge as applyTrayBadgePolicy,
  buildTrayMenuTemplate,
  nextTrayBadge,
  type TrayBadgeEvent,
  type TrayIconApi,
  type TrayMenuAction,
} from "./desktop-behaviors.mjs";
import type { NativeCopyKey, NativeTranslationValues } from "./native-localization.mjs";

/** Loads the app icon from the packaged resources or the dev build directory. */
export function loadDesktopIcon(): NativeImage {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(app.getAppPath(), "build", "icon.ico");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error(`Nami Mail icon could not be loaded: ${iconPath}`);
  return icon;
}

export type TrayControllerOptions = {
  getMainWindow: () => BrowserWindow | undefined;
  getAppIcon: () => NativeImage | undefined;
  loadAppIcon: () => NativeImage;
  /** Localized tray strings; the locale lives in the service's settings. */
  copy: (key: NativeCopyKey, values?: NativeTranslationValues) => string;
  showError: (title: string, message: string) => void;
};

export type TrayController = {
  ensure: () => Tray;
  destroy: () => void;
  getTray: () => Tray | undefined;
  focusWindow: () => void;
  hideWindowToTray: () => boolean;
  applyBadge: (event: TrayBadgeEvent) => void;
  /** Records the window's real visibility; the tray menu label reads it. */
  setWindowVisible: (visible: boolean) => void;
};

/**
 * Owns the tray icon and everything hanging off it: the badge, the context menu
 * and the show/hide pair.
 *
 * It was extracted from `main.mts` as one cohesive unit because the four pieces
 * of state it needs (`tray`, the badge icon cache, the app icon and the
 * maintained visibility flag) are read nowhere outside it. Everything it needs
 * from the rest of the app — the window, the icon, localized strings — arrives
 * through the options, so the module stays testable without Electron.
 */
export function createTrayController(options: TrayControllerOptions): TrayController {
  let tray: Tray | undefined;
  let trayBadgeIcon: NativeImage | undefined;
  // Reliable mirror of the main window's real on-screen visibility. We avoid
  // trusting `BrowserWindow.isVisible()` for the tray menu because its return
  // value is unreliable across some Windows/Electron combinations; instead the
  // flag is maintained at the exact points the window is shown or hidden.
  let mainWindowVisible = false;

  const setTrayIcon = (icon: NativeImage | undefined): void => {
    if (!tray || tray.isDestroyed() || !icon) return;
    tray.setImage(icon);
  };

  const loadTrayBadgeIcon = (): NativeImage | undefined => {
    if (trayBadgeIcon) return trayBadgeIcon;
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, "tray-badge-icon.png")
      : path.join(app.getAppPath(), "build", "tray-badge-icon.png");
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      // Older installs do not ship the badge variant; the tray then keeps the
      // plain icon and the new-mail dot is simply not shown.
      console.warn(`Nami Mail tray badge icon could not be loaded: ${iconPath}`);
      return undefined;
    }
    trayBadgeIcon = icon;
    return icon;
  };

  const trayIconApi: TrayIconApi = {
    setBadgeIcon: () => setTrayIcon(loadTrayBadgeIcon()),
    setPlainIcon: () => setTrayIcon(options.getAppIcon() ?? options.loadAppIcon()),
  };

  const focusWindow = (): void => {
    const mainWindow = options.getMainWindow();
    if (!mainWindow) return;
    mainWindowVisible = true;
    if (tray && !tray.isDestroyed()) refreshTrayMenu(tray);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("nami:settings-changed");
  };

  const runTrayAction = (action: TrayMenuAction): void => {
    const mainWindow = options.getMainWindow();
    switch (action.kind) {
      case "toggle-window": {
        // Both branches refresh the menu (hide via ensure, show via
        // focusWindow), so the visibility label stays accurate. Driven by the
        // maintained mainWindowVisible flag rather than `isVisible()`.
        if (mainWindowVisible) hideWindowToTray();
        else focusWindow();
        break;
      }
      case "compose-new":
        focusWindow();
        mainWindow?.webContents.send("nami:compose-new");
        break;
      case "open-inbox":
        focusWindow();
        mainWindow?.webContents.send("nami:open-inbox");
        break;
      case "quit":
        app.quit();
        break;
    }
  };

  function refreshTrayMenu(targetTray: Tray): void {
    targetTray.setToolTip(options.copy("trayTooltip"));
    // Use the maintained visibility flag (see mainWindowVisible) rather than
    // `BrowserWindow.isVisible()`, which is unreliable here. The label describes
    // the action that will run on click: when the window is actually visible we
    // show "hide to tray", otherwise "show Nami Mail".
    const template = buildTrayMenuTemplate(
      {
        hide: options.copy("trayHide"),
        show: options.copy("trayShow"),
        newMail: options.copy("trayNewMail"),
        inbox: options.copy("trayInbox"),
        quit: options.copy("trayQuit"),
      },
      mainWindowVisible,
    );
    targetTray.setContextMenu(Menu.buildFromTemplate(template.map((item) => {
      if (item.type === "separator") return { type: "separator" as const };
      return { label: item.label, click: () => runTrayAction(item.action) };
    })));
  }

  function ensure(): Tray {
    if (tray && !tray.isDestroyed()) {
      refreshTrayMenu(tray);
      return tray;
    }
    const nextTray = new Tray(options.getAppIcon() ?? options.loadAppIcon());
    refreshTrayMenu(nextTray);
    nextTray.on("click", focusWindow);
    nextTray.on("double-click", focusWindow);
    nextTray.on("right-click", () => refreshTrayMenu(nextTray));
    tray = nextTray;
    return nextTray;
  }

  function hideWindowToTray(): boolean {
    const mainWindow = options.getMainWindow();
    if (!mainWindow) return false;
    try {
      mainWindowVisible = false;
      ensure();
      mainWindow.hide();
      return true;
    } catch (error) {
      console.error("Nami Mail could not create its tray icon", error);
      options.showError(
        options.copy("trayFailureTitle"),
        options.copy("trayFailureMessage"),
      );
      return false;
    }
  }

  return {
    ensure,
    getTray: () => tray,
    focusWindow,
    hideWindowToTray,
    setWindowVisible: (visible: boolean) => {
      mainWindowVisible = visible;
    },
    destroy: () => {
      if (tray && !tray.isDestroyed()) tray.destroy();
      tray = undefined;
    },
    applyBadge: (event: TrayBadgeEvent) => {
      try {
        applyTrayBadgePolicy(trayIconApi, nextTrayBadge(event));
      } catch (error) {
        // Tray icon APIs vary by desktop session; a failure must not take the
        // mail client down with it.
        console.warn("Nami Mail could not update its tray icon", error);
      }
    },
  };
}
