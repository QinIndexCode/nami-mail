/**
 * Desktop smoke probes, extracted from main.mts so the boot path stays
 * readable and the probe machinery is one self-contained module. The probes
 * drive the real renderer through executeJavaScript and assert the result
 * shapes the smoke harness (scripts/smoke-desktop.mjs) consumes.
 *
 * The module holds the smoke session/diagnostics state and reads the live
 * app context through a host object supplied by main.mts, so probes always
 * observe the current window/server rather than a boot-time snapshot.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { type BrowserWindow, type MessageBoxReturnValue, type NativeImage, type Tray } from "electron";

export type CloseBehavior = "ask" | "tray" | "quit";

export type DesktopSmokeNotificationResult = {
  invoked: boolean;
  shown?: boolean;
  error?: string;
};

export type DesktopLocalApiSmokeResult = {
  googleAvailable: boolean;
  microsoftAvailable: boolean;
  googleClientId: string;
  microsoftClientId: string;
  googleRedirectUri: string;
  microsoftRedirectUri: string;
  microsoftAuthorizationPathname: string;
  googleExpiresAt: string;
  microsoftExpiresAt: string;
  cacheControl: string;
  pragma: string;
  expires: string;
  error?: string;
};

export type DesktopWallpaperSmokeResult = {
  present: boolean;
  coversWorkspace: boolean;
  opacity: number;
  inlineOpacity: string;
  animationName: string;
  animationPlayState: string;
  animationCurrentTime: number | null;
  reducedMotion: boolean;
  sidebarPanelOpacity: number;
  messagePanelOpacity: number;
  readerPanelOpacity: number;
};

export type DesktopSettingsUiSmokeResult = {
  settingsOpened: boolean;
  brandName: string;
  lightBrandMarkLoaded: boolean;
  darkBrandMarkLoaded: boolean;
  settingsBackdropFilter: string;
  settingsBackdropColor: string;
  confirmationBackdropFilter: string;
  confirmationBackdropColor: string;
  alertUsesAppUi: boolean;
  alertBackdropFilter: string;
  alertBackdropColor: string;
  alertMessage: string;
  nativeDialogCalls: number;
  errorToastAbsent: boolean;
  focusTrapped: boolean;
  alertDismissedWithEscape: boolean;
  settingsStillOpenAfterEscape: boolean;
  focusRestoredToUpload: boolean;
  displayTextUnselectable: boolean;
  editableTextSelectable: boolean;
  updateStatusPresent: boolean;
  updateStatusText: string;
  updateActionCount: number;
  error?: string;
};

export type DesktopLifecycleSmokeResult = {
  appUserModelId: string;
  closeBehavior: CloseBehavior;
  iconWidth: number;
  iconHeight: number;
  trayCreated: boolean;
  error?: string;
};

export type DesktopClosePromptScenarioSmokeResult = {
  eventPrevented: boolean;
  simulatedNativeDialogCalls: number;
  closeBehavior: CloseBehavior | "";
  trayCreated: boolean;
  windowHidden: boolean;
  quitRequested: boolean;
};

export type DesktopClosePromptSmokeResult = {
  initialCloseBehavior: CloseBehavior | "";
  cancel: DesktopClosePromptScenarioSmokeResult;
  minimizeAndRemember: DesktopClosePromptScenarioSmokeResult;
  quitAndRemember: DesktopClosePromptScenarioSmokeResult;
  finalCloseBehavior: CloseBehavior | "";
  error?: string;
};

export type DesktopSettingsSyncSmokeResult = {
  initialCloseBehavior: CloseBehavior | "";
  updatedCloseBehavior: CloseBehavior | "";
  restoredCloseBehavior: CloseBehavior | "";
  error?: string;
};

export type DesktopSingleInstanceSmokeResult = {
  activationCount: number;
  restored: boolean;
  serviceUrl: string;
};

export type ClosePromptDialogResult = Pick<MessageBoxReturnValue, "response" | "checkboxChecked">;

export type ClosePromptSmokeSession = {
  result: ClosePromptDialogResult;
  simulatedNativeDialogCalls: number;
  quitRequested: boolean;
};

/**
 * Live app context the probes read at call time. The structural local
 * service type is intentionally narrower than the runtime server so this
 * module does not depend on main.mts's types.
 */
export type DesktopSmokeHost = {
  smokeResultPath?: string;
  smokeProgressPath?: string;
  isDesktopSmoke: boolean;
  appUserModelId: string;
  getMainWindow: () => BrowserWindow | undefined;
  getLocalServer: () => {
    url: string;
    getSettings: () => { closeBehavior: CloseBehavior };
    updateSettings: (patch: { closeBehavior: CloseBehavior }) => { closeBehavior: CloseBehavior };
  } | undefined;
  getTray: () => Tray | undefined;
  getAppIcon: () => NativeImage | undefined;
  loadAppIcon: () => NativeImage;
  focusMainWindow: () => void;
  ensureTray: () => Tray;
  destroyTray: () => void;
  requestMainWindowClose: (event: Pick<Electron.Event, "preventDefault">) => Promise<void>;
  rememberCloseBehavior: (closeBehavior: CloseBehavior) => Promise<void>;
  redact: (message: string) => string;
};

let smokeHost: DesktopSmokeHost | undefined;
let closePromptSmokeSession: ClosePromptSmokeSession | undefined;
let desktopSmokeResult: Record<string, unknown> | undefined;
let singleInstanceSmokeResult: DesktopSingleInstanceSmokeResult | undefined;
const desktopSmokeDiagnostics: string[] = [];

function requireHost(): DesktopSmokeHost {
  if (!smokeHost) throw new Error("Desktop smoke host is not initialized.");
  return smokeHost;
}

export function initializeDesktopSmoke(host: DesktopSmokeHost): void {
  smokeHost = host;
}

/** The close-prompt session the native-dialog bridge consults during a smoke run. */
export function getClosePromptSmokeSession(): ClosePromptSmokeSession | undefined {
  return closePromptSmokeSession;
}

export function getSingleInstanceSmokeResult(): DesktopSingleInstanceSmokeResult | undefined {
  return singleInstanceSmokeResult;
}

export function getDesktopSmokeDiagnostics(): string[] {
  return desktopSmokeDiagnostics;
}

export function noteDesktopSmokeDiagnostic(message: string): void {
  desktopSmokeDiagnostics.push(message);
}

export function normalizeDesktopSmokeNotificationResult(value: unknown): DesktopSmokeNotificationResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as Partial<DesktopSmokeNotificationResult>;
  if (typeof result.invoked !== "boolean") return undefined;
  if (result.shown !== undefined && typeof result.shown !== "boolean") return undefined;
  if (result.error !== undefined && typeof result.error !== "string") return undefined;
  return {
    invoked: result.invoked,
    ...(result.shown === undefined ? {} : { shown: result.shown }),
    ...(result.error === undefined ? {} : { error: result.error.slice(0, 500) }),
  };
}

export async function waitForDesktopSmokeNotification(): Promise<DesktopSmokeNotificationResult> {
  const targetWindow = requireHost().getMainWindow();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const serialized = await targetWindow?.webContents.executeJavaScript(
        "document.documentElement.dataset.namiDesktopSmokeNotification ?? ''",
      );
      if (typeof serialized === "string" && serialized) {
        const result = normalizeDesktopSmokeNotificationResult(JSON.parse(serialized));
        if (result) return result;
      }
    } catch {
      // The renderer is still starting or has just navigated; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { invoked: false, error: "Timed out waiting for the desktop notification bridge." };
}

export function desktopSmokeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Desktop local API smoke failed.";
  return requireHost().redact(message).slice(0, 500);
}

export function normalizeDesktopLocalApiSmokeResult(value: unknown): DesktopLocalApiSmokeResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const {
    googleAvailable,
    microsoftAvailable,
    googleClientId,
    microsoftClientId,
    googleRedirectUri,
    microsoftRedirectUri,
    microsoftAuthorizationPathname,
    googleExpiresAt,
    microsoftExpiresAt,
    cacheControl,
    pragma,
    expires,
    error,
  } = value as Partial<DesktopLocalApiSmokeResult>;
  if (
    typeof googleAvailable !== "boolean" ||
    typeof microsoftAvailable !== "boolean" ||
    typeof googleClientId !== "string" ||
    typeof microsoftClientId !== "string" ||
    typeof googleRedirectUri !== "string" ||
    typeof microsoftRedirectUri !== "string" ||
    typeof microsoftAuthorizationPathname !== "string" ||
    typeof googleExpiresAt !== "string" ||
    typeof microsoftExpiresAt !== "string" ||
    typeof cacheControl !== "string" ||
    typeof pragma !== "string" ||
    typeof expires !== "string"
  ) {
    return undefined;
  }
  if (error !== undefined && typeof error !== "string") return undefined;
  return {
    googleAvailable,
    microsoftAvailable,
    googleClientId,
    microsoftClientId,
    googleRedirectUri,
    microsoftRedirectUri,
    microsoftAuthorizationPathname,
    googleExpiresAt,
    microsoftExpiresAt,
    cacheControl,
    pragma,
    expires,
    ...(error === undefined ? {} : { error: error.slice(0, 500) }),
  };
}

export async function inspectDesktopLocalApiSmoke(): Promise<DesktopLocalApiSmokeResult> {
  const host = requireHost();
  const fallback: DesktopLocalApiSmokeResult = {
    googleAvailable: false,
    microsoftAvailable: false,
    googleClientId: "",
    microsoftClientId: "",
    googleRedirectUri: "",
    microsoftRedirectUri: "",
    microsoftAuthorizationPathname: "",
    googleExpiresAt: "",
    microsoftExpiresAt: "",
    cacheControl: "",
    pragma: "",
    expires: "",
  };
  const targetWindow = host.getMainWindow();
  if (!targetWindow) return { ...fallback, error: "Desktop window is unavailable for local API smoke." };

  try {
    // This runs in the real renderer. Its fetches must cross Electron's
    // network stack, where the per-launch capability is injected for the
    // loopback API. Only a redacted, assertion-ready summary comes back.
    const result = await targetWindow.webContents.executeJavaScript(`
      (async () => {
        let observedCachePolicy = null;
        const post = async (pathname, payload) => {
          const response = await fetch(pathname, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!observedCachePolicy) {
            observedCachePolicy = {
              cacheControl: response.headers.get("cache-control") || "",
              pragma: response.headers.get("pragma") || "",
              expires: response.headers.get("expires") || "",
            };
          }
          if (!response.ok) throw new Error("Local API request failed: " + response.status);
          const body = await response.json();
          if (!body || typeof body !== "object") throw new Error("Local API returned an invalid response.");
          return body;
        };
        const summarizeOAuth = (value) => {
          if (!value || typeof value !== "object" || typeof value.authorizationUrl !== "string" || typeof value.expiresAt !== "string") {
            throw new Error("OAuth start returned an invalid response.");
          }
          const authorizationUrl = new URL(value.authorizationUrl);
          const clientId = authorizationUrl.searchParams.get("client_id");
          const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
          if (!clientId || !redirectUri) throw new Error("OAuth start response is incomplete.");
          return { clientId, redirectUri, authorizationPathname: authorizationUrl.pathname, expiresAt: value.expiresAt };
        };
        const [googleDiscovery, microsoftDiscovery] = await Promise.all([
          post("/api/accounts/discover", { email: "desktop-smoke@gmail.com" }),
          post("/api/accounts/discover", { email: "desktop-smoke@outlook.com" }),
        ]);
        const [googleOAuth, microsoftOAuth] = await Promise.all([
          post("/api/oauth/google/start", {}),
          post("/api/oauth/microsoft/start", {}),
        ]);
        const google = summarizeOAuth(googleOAuth);
        const microsoft = summarizeOAuth(microsoftOAuth);
        return {
          googleAvailable: googleDiscovery.oauthAvailable === true,
          microsoftAvailable: microsoftDiscovery.oauthAvailable === true,
          googleClientId: google.clientId,
          microsoftClientId: microsoft.clientId,
          googleRedirectUri: google.redirectUri,
          microsoftRedirectUri: microsoft.redirectUri,
          microsoftAuthorizationPathname: microsoft.authorizationPathname,
          googleExpiresAt: google.expiresAt,
          microsoftExpiresAt: microsoft.expiresAt,
          cacheControl: observedCachePolicy?.cacheControl || "",
          pragma: observedCachePolicy?.pragma || "",
          expires: observedCachePolicy?.expires || "",
        };
      })()
    `);
    return normalizeDesktopLocalApiSmokeResult(result) ?? { ...fallback, error: "Desktop local API smoke returned an invalid result." };
  } catch (error) {
    return { ...fallback, error: desktopSmokeError(error) };
  }
}

export async function inspectDesktopWallpaper(): Promise<DesktopWallpaperSmokeResult> {
  const host = requireHost();
  const fallback: DesktopWallpaperSmokeResult = {
    present: false,
    coversWorkspace: false,
    opacity: 0,
    inlineOpacity: "",
    animationName: "",
    animationPlayState: "",
    animationCurrentTime: null,
    reducedMotion: false,
    sidebarPanelOpacity: 1,
    messagePanelOpacity: 1,
    readerPanelOpacity: 1,
  };
  const targetWindow = host.getMainWindow();
  if (!targetWindow) return fallback;

  try {
    // The smoke window stays hidden so it does not interrupt an operator. In
    // that state Chromium can throttle the decorative reveal animation and
    // retain its zero-opacity first keyframe. Finish only that animation so
    // this probe checks the stable user-visible style rather than scheduler
    // timing; reduced-motion mode has no animation to finish.
    await targetWindow.webContents.executeJavaScript("new Promise((resolve) => setTimeout(resolve, 450))");
    await targetWindow.webContents.executeJavaScript(`
      (() => {
        const wallpaper = document.querySelector('.workspace-background');
        if (!(wallpaper instanceof HTMLElement)) return;
        for (const animation of wallpaper.getAnimations()) animation.finish();
        void getComputedStyle(wallpaper).opacity;
      })()
    `);
    const result = await targetWindow.webContents.executeJavaScript(`
      (() => {
        const workspace = document.querySelector('.workspace-canvas');
        const wallpaper = document.querySelector('.workspace-background');
        const sidebar = document.querySelector('.sidebar');
        const messageColumn = document.querySelector('.message-column');
        const reader = document.querySelector('.reader-column');
        if (!workspace || !wallpaper || !sidebar || !messageColumn || !reader) {
          return { present: false, coversWorkspace: false, opacity: 0, sidebarPanelOpacity: 1, messagePanelOpacity: 1, readerPanelOpacity: 1 };
        }
        const workspaceRect = workspace.getBoundingClientRect();
        const wallpaperRect = wallpaper.getBoundingClientRect();
        const wallpaperStyle = getComputedStyle(wallpaper);
        const animation = wallpaper.getAnimations()[0];
        const panelOpacity = (element) => {
          const backgroundColor = getComputedStyle(element).backgroundColor;
          const slashAlpha = backgroundColor.match(/\\/\\s*([0-9.]+)\\)$/);
          const rgbaAlpha = backgroundColor.match(/^rgba\\([^,]+,[^,]+,[^,]+,\\s*([0-9.]+)\\)$/);
          return Number(slashAlpha?.[1] ?? rgbaAlpha?.[1] ?? 1);
        };
        return {
          present: true,
          coversWorkspace: wallpaperRect.width >= workspaceRect.width && wallpaperRect.height >= workspaceRect.height,
          opacity: Number(wallpaperStyle.opacity),
          inlineOpacity: wallpaper.style.opacity,
          animationName: wallpaperStyle.animationName,
          animationPlayState: animation?.playState ?? "none",
          animationCurrentTime: typeof animation?.currentTime === "number" ? animation.currentTime : null,
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          sidebarPanelOpacity: panelOpacity(sidebar),
          messagePanelOpacity: panelOpacity(messageColumn),
          readerPanelOpacity: panelOpacity(reader),
        };
      })()
    `) as DesktopWallpaperSmokeResult;
    return result;
  } catch {
    return fallback;
  }
}

export async function inspectDesktopSettingsUi(): Promise<DesktopSettingsUiSmokeResult> {
  const host = requireHost();
  const fallback: DesktopSettingsUiSmokeResult = {
    settingsOpened: false,
    brandName: "",
    lightBrandMarkLoaded: false,
    darkBrandMarkLoaded: false,
    settingsBackdropFilter: "",
    settingsBackdropColor: "",
    confirmationBackdropFilter: "",
    confirmationBackdropColor: "",
    alertUsesAppUi: false,
    alertBackdropFilter: "",
    alertBackdropColor: "",
    alertMessage: "",
    nativeDialogCalls: -1,
    errorToastAbsent: false,
    focusTrapped: false,
    alertDismissedWithEscape: false,
    settingsStillOpenAfterEscape: false,
    focusRestoredToUpload: false,
    displayTextUnselectable: false,
    editableTextSelectable: false,
    updateStatusPresent: false,
    updateStatusText: "",
    updateActionCount: -1,
  };
  const targetWindow = host.getMainWindow();
  if (!targetWindow) return fallback;

  try {
    // This only exercises the renderer's early size validation. A structural
    // file object avoids allocating a 50 MB buffer during every smoke run.
    return await targetWindow.webContents.executeJavaScript(`
      (async () => {
        const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        const waitFor = async (predicate, timeout = 5000) => {
          const deadline = performance.now() + timeout;
          while (performance.now() < deadline) {
            const value = predicate();
            if (value) return value;
            await pause(25);
          }
          return null;
        };
        const snapshotBackdrop = (element) => {
          const style = getComputedStyle(element);
          return {
            filter: style.backdropFilter || style.webkitBackdropFilter || '',
            color: style.backgroundColor,
          };
        };
        const settingsButton = document.querySelector('.icon-rail .icon-button');
        if (!(settingsButton instanceof HTMLButtonElement)) throw new Error('Settings button was not rendered.');
        settingsButton.click();

        const settings = await waitFor(() => document.querySelector('.settings-modal'));
        if (!(settings instanceof HTMLElement)) throw new Error('Settings dialog did not open.');
        const lastMissing = [];
        const completeSettings = await waitFor(() => {
          const settingsBackdrop = settings.parentElement;
          const lightBrandMark = document.querySelector('.brand-mark-light');
          const darkBrandMark = document.querySelector('.brand-mark-dark');
          const title = settings.querySelector('#settings-title');
          const editable = settings.querySelector('input[type="range"]');
          const updateRow = settings.querySelector('.update-setting-row');
          const input = settings.querySelector('input[type="file"]');
          const uploadButton = settings.querySelector('.background-actions .secondary-button');
          lastMissing.length = 0;
          if (!(settingsBackdrop instanceof HTMLElement)) lastMissing.push('settings backdrop');
          if (!(lightBrandMark instanceof HTMLImageElement)) lastMissing.push('.brand-mark-light');
          if (!(darkBrandMark instanceof HTMLImageElement)) lastMissing.push('.brand-mark-dark');
          if (!(title instanceof HTMLElement)) lastMissing.push('#settings-title');
          if (!(editable instanceof HTMLInputElement)) lastMissing.push('input[type="range"]');
          if (!(updateRow instanceof HTMLElement)) lastMissing.push('.update-setting-row');
          if (!(input instanceof HTMLInputElement)) lastMissing.push('input[type="file"]');
          if (!(uploadButton instanceof HTMLButtonElement)) lastMissing.push('.background-actions .secondary-button');
          if (lastMissing.length > 0) return null;
          return { settingsBackdrop, lightBrandMark, darkBrandMark, title, editable, updateRow, input, uploadButton };
        });
        if (!completeSettings) {
          let updateBridgeEvidence = 'unavailable';
          try {
            const rawBridge = window.namiDesktop;
            if (rawBridge && typeof rawBridge.getUpdateStatus === 'function') {
              updateBridgeEvidence = JSON.stringify(await rawBridge.getUpdateStatus() ?? null);
            } else {
              updateBridgeEvidence = String(typeof rawBridge);
            }
          } catch (error) {
            updateBridgeEvidence = 'error: ' + (error instanceof Error ? error.message : String(error));
          }
          throw new Error(
            'Settings controls were not rendered after waiting for the desktop update status. Missing: '
            + lastMissing.join(', ')
            + ' | update bridge: ' + updateBridgeEvidence,
          );
        }
        const { settingsBackdrop, lightBrandMark, darkBrandMark, title, editable, updateRow, input, uploadButton } = completeSettings;
        const brandName = document.querySelector('.brand-row strong')?.textContent?.trim() ?? '';

        const displayTextUnselectable = getComputedStyle(title).userSelect === 'none';
        const editableTextSelectable = getComputedStyle(editable).userSelect === 'text';
        const settingsBackdropStyle = snapshotBackdrop(settingsBackdrop);
        const restoreDefaultsButton = settings.querySelector('.settings-footer .secondary-button');
        if (!(restoreDefaultsButton instanceof HTMLButtonElement)) throw new Error('Settings confirmation trigger was not rendered.');
        restoreDefaultsButton.click();
        const confirmation = await waitFor(() => document.querySelector('.confirmation-card[role="alertdialog"]'));
        if (!(confirmation instanceof HTMLElement)) throw new Error('Settings confirmation dialog did not open.');
        const confirmationBackdrop = confirmation.parentElement;
        if (!(confirmationBackdrop instanceof HTMLElement)) throw new Error('Settings confirmation dialog has no backdrop.');
        const confirmationBackdropStyle = snapshotBackdrop(confirmationBackdrop);
        const cancelConfirmation = confirmation.querySelector('[data-dialog-initial-focus]');
        if (!(cancelConfirmation instanceof HTMLButtonElement)) throw new Error('Settings confirmation dialog has no cancel control.');
        cancelConfirmation.click();
        await waitFor(() => !document.querySelector('.confirmation-card'));
        const originalDialogs = {
          alert: window.alert,
          confirm: window.confirm,
          prompt: window.prompt,
        };
        let nativeDialogCalls = 0;
        window.alert = () => { nativeDialogCalls += 1; };
        window.confirm = () => { nativeDialogCalls += 1; return false; };
        window.prompt = () => { nativeDialogCalls += 1; return null; };

        try {
          const oversizedFile = {
            name: 'oversized-wallpaper.png',
            type: 'image/png',
            size: 50 * 1024 * 1024 + 1,
          };
          Object.defineProperty(input, 'files', {
            configurable: true,
            value: { 0: oversizedFile, length: 1, item: (index) => index === 0 ? oversizedFile : null },
          });
          input.dispatchEvent(new Event('change', { bubbles: true }));

          const alert = await waitFor(() => document.querySelector('.settings-alert-card[role="alertdialog"]'));
          if (!(alert instanceof HTMLElement)) throw new Error('Oversized wallpaper did not open an application alert dialog.');
          const alertBackdrop = alert.parentElement;
          if (!(alertBackdrop instanceof HTMLElement)) throw new Error('Application alert dialog has no backdrop.');
          const alertBackdropStyle = snapshotBackdrop(alertBackdrop);
          const dismiss = alert.querySelector('button');
          if (!(dismiss instanceof HTMLButtonElement)) throw new Error('Application alert dialog has no dismiss control.');
          dismiss.focus();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
          await pause(25);
          const focusTrapped = alert.contains(document.activeElement);
          const alertMessage = alert.querySelector('#background-upload-error-description')?.textContent?.trim() ?? '';
          const errorToastAbsent = !document.querySelector('.toast.error');

          dismiss.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          const alertDismissedWithEscape = Boolean(await waitFor(() => !document.querySelector('.settings-alert-card')));
          const settingsStillOpenAfterEscape = Boolean(document.querySelector('.settings-modal'));
          const focusRestoredToUpload = Boolean(await waitFor(() => document.activeElement === uploadButton));

          const closeButton = settings.querySelector('.settings-heading .icon-button');
          if (closeButton instanceof HTMLButtonElement) closeButton.click();
          await waitFor(() => !document.querySelector('.settings-modal'));

          return {
            settingsOpened: true,
            brandName,
            lightBrandMarkLoaded: lightBrandMark.complete && lightBrandMark.naturalWidth >= 128,
            darkBrandMarkLoaded: darkBrandMark.complete && darkBrandMark.naturalWidth >= 128,
            settingsBackdropFilter: settingsBackdropStyle.filter,
            settingsBackdropColor: settingsBackdropStyle.color,
            confirmationBackdropFilter: confirmationBackdropStyle.filter,
            confirmationBackdropColor: confirmationBackdropStyle.color,
            alertUsesAppUi: alert.getAttribute('aria-modal') === 'true',
            alertBackdropFilter: alertBackdropStyle.filter,
            alertBackdropColor: alertBackdropStyle.color,
            alertMessage,
            nativeDialogCalls,
            errorToastAbsent,
            focusTrapped,
            alertDismissedWithEscape,
            settingsStillOpenAfterEscape,
            focusRestoredToUpload,
            displayTextUnselectable,
            editableTextSelectable,
            updateStatusPresent: true,
            updateStatusText: updateRow.textContent?.trim() ?? '',
            updateActionCount: updateRow.querySelectorAll('button').length,
          };
        } finally {
          window.alert = originalDialogs.alert;
          window.confirm = originalDialogs.confirm;
          window.prompt = originalDialogs.prompt;
        }
      })()
    `) as DesktopSettingsUiSmokeResult;
  } catch (error) {
    return {
      ...fallback,
      error: error instanceof Error ? error.message : "Desktop settings UI smoke failed.",
    };
  }
}

export async function inspectDesktopSettingsSync(): Promise<DesktopSettingsSyncSmokeResult> {
  const host = requireHost();
  const fallback: DesktopSettingsSyncSmokeResult = {
    initialCloseBehavior: "",
    updatedCloseBehavior: "",
    restoredCloseBehavior: "",
  };
  const targetWindow = host.getMainWindow();
  const service = host.getLocalServer();
  if (!targetWindow || !service) return fallback;

  const waitForCloseBehavior = async (expected: CloseBehavior, openSettings = false): Promise<CloseBehavior | ""> => {
    return await targetWindow.webContents.executeJavaScript(`
      (async () => {
        const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        const waitFor = async (predicate, timeout = 5000) => {
          const deadline = performance.now() + timeout;
          while (performance.now() < deadline) {
            const value = predicate();
            if (value) return value;
            await pause(25);
          }
          return null;
        };
        if (${openSettings ? "true" : "false"} && !document.querySelector('.settings-modal')) {
          const settingsButton = document.querySelector('.icon-rail .icon-button');
          if (!(settingsButton instanceof HTMLButtonElement)) throw new Error('Settings button was not rendered.');
          settingsButton.click();
        }
        const expected = ${JSON.stringify(expected)};
        const selector = '.close-behavior-grid [data-close-behavior="' + expected + '"][aria-pressed="true"]';
        const activeOption = await waitFor(() => document.querySelector(selector));
        return activeOption instanceof HTMLElement ? activeOption.dataset.closeBehavior ?? '' : '';
      })()
    `) as CloseBehavior | "";
  };

  try {
    const initialCloseBehavior = await waitForCloseBehavior("ask", true);
    await host.rememberCloseBehavior("tray");
    const updatedCloseBehavior = await waitForCloseBehavior("tray");

    // Simulate a setting changed outside React, then use the same focus path
    // as a tray restore to request the authoritative settings again.
    service.updateSettings({ closeBehavior: "ask" });
    host.focusMainWindow();
    const restoredCloseBehavior = await waitForCloseBehavior("ask");
    return { initialCloseBehavior, updatedCloseBehavior, restoredCloseBehavior };
  } catch (error) {
    return {
      ...fallback,
      error: error instanceof Error ? error.message : "Desktop settings synchronization smoke failed.",
    };
  } finally {
    service.updateSettings({ closeBehavior: "ask" });
    targetWindow.webContents.send("nami:settings-changed");
    await targetWindow.webContents.executeJavaScript(`
      document.querySelector('.settings-heading .icon-button')?.click();
    `).catch(() => undefined);
  }
}

export function createClosePromptScenarioFallback(): DesktopClosePromptScenarioSmokeResult {
  return {
    eventPrevented: false,
    simulatedNativeDialogCalls: 0,
    closeBehavior: "",
    trayCreated: false,
    windowHidden: false,
    quitRequested: false,
  };
}

export async function inspectDesktopClosePrompt(): Promise<DesktopClosePromptSmokeResult> {
  const host = requireHost();
  const fallback: DesktopClosePromptSmokeResult = {
    initialCloseBehavior: "",
    cancel: createClosePromptScenarioFallback(),
    minimizeAndRemember: createClosePromptScenarioFallback(),
    quitAndRemember: createClosePromptScenarioFallback(),
    finalCloseBehavior: "",
  };
  const targetWindow = host.getMainWindow();
  const service = host.getLocalServer();
  if (!targetWindow || !service) return fallback;

  const runScenario = async (result: ClosePromptDialogResult): Promise<DesktopClosePromptScenarioSmokeResult> => {
    let eventPrevented = false;
    const session: ClosePromptSmokeSession = {
      result,
      simulatedNativeDialogCalls: 0,
      quitRequested: false,
    };
    service.updateSettings({ closeBehavior: "ask" });
    host.focusMainWindow();
    closePromptSmokeSession = session;
    try {
      await host.requestMainWindowClose({
        preventDefault: () => {
          eventPrevented = true;
        },
      });
      return {
        eventPrevented,
        simulatedNativeDialogCalls: session.simulatedNativeDialogCalls,
        closeBehavior: service.getSettings().closeBehavior,
        trayCreated: Boolean(host.getTray() && !host.getTray()?.isDestroyed()),
        windowHidden: !targetWindow.isVisible(),
        quitRequested: session.quitRequested,
      };
    } finally {
      closePromptSmokeSession = undefined;
    }
  };

  try {
    service.updateSettings({ closeBehavior: "ask" });
    const initialCloseBehavior = service.getSettings().closeBehavior;
    const cancel = await runScenario({ response: 2, checkboxChecked: true });
    const minimizeAndRemember = await runScenario({ response: 0, checkboxChecked: true });
    const quitAndRemember = await runScenario({ response: 1, checkboxChecked: true });
    service.updateSettings({ closeBehavior: "ask" });
    targetWindow.webContents.send("nami:settings-changed");
    host.focusMainWindow();
    return {
      initialCloseBehavior,
      cancel,
      minimizeAndRemember,
      quitAndRemember,
      finalCloseBehavior: service.getSettings().closeBehavior,
    };
  } catch (error) {
    return {
      ...fallback,
      error: error instanceof Error ? error.message : "Desktop close prompt smoke failed.",
    };
  } finally {
    closePromptSmokeSession = undefined;
    service.updateSettings({ closeBehavior: "ask" });
    targetWindow.webContents.send("nami:settings-changed");
    host.focusMainWindow();
  }
}

export function inspectDesktopLifecycle(): DesktopLifecycleSmokeResult {
  const host = requireHost();
  const fallback: DesktopLifecycleSmokeResult = {
    appUserModelId: host.appUserModelId,
    closeBehavior: host.getLocalServer()?.getSettings().closeBehavior ?? "ask",
    iconWidth: 0,
    iconHeight: 0,
    trayCreated: false,
  };
  try {
    const iconSize = (host.getAppIcon() ?? host.loadAppIcon()).getSize();
    host.ensureTray();
    return {
      ...fallback,
      iconWidth: iconSize.width,
      iconHeight: iconSize.height,
      trayCreated: Boolean(host.getTray() && !host.getTray()?.isDestroyed()),
    };
  } catch (error) {
    return {
      ...fallback,
      error: error instanceof Error ? error.message : "Desktop lifecycle smoke failed.",
    };
  } finally {
    host.destroyTray();
  }
}

export async function writeSmokeResult(result: Record<string, unknown>): Promise<void> {
  const host = requireHost();
  if (!host.smokeResultPath) return;
  desktopSmokeResult = result;
  await fs.mkdir(path.dirname(host.smokeResultPath), { recursive: true });
  await fs.writeFile(host.smokeResultPath, JSON.stringify(result), "utf8");
}

export async function writeDesktopSmokeProgress(stage: string): Promise<void> {
  const host = requireHost();
  if (!host.isDesktopSmoke || !host.smokeProgressPath) return;
  try {
    await fs.mkdir(path.dirname(host.smokeProgressPath), { recursive: true });
    await fs.writeFile(host.smokeProgressPath, JSON.stringify({ stage, checkedAt: new Date().toISOString() }), "utf8");
  } catch {
    desktopSmokeDiagnostics.push("Desktop smoke progress could not be written.");
  }
}

export async function recordSingleInstanceSmokeActivation(commandLine: string[]): Promise<void> {
  const host = requireHost();
  if (!host.isDesktopSmoke || !commandLine.includes("--nami-single-instance-smoke")) return;
  const activationCount = (singleInstanceSmokeResult?.activationCount ?? 0) + 1;
  host.focusMainWindow();
  singleInstanceSmokeResult = {
    activationCount,
    restored: Boolean(host.getMainWindow()?.isVisible()) && !host.getMainWindow()?.isMinimized(),
    serviceUrl: host.getLocalServer()?.url ?? "",
  };
  if (desktopSmokeResult) {
    await writeSmokeResult({ ...desktopSmokeResult, desktopSingleInstance: singleInstanceSmokeResult });
  }
}
