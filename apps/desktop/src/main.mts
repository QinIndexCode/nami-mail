import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, safeStorage, session, shell, Tray, type NativeImage } from "electron";
import { parse as parseDotenv } from "dotenv";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  clearLegacyRendererMailCache,
  isLocalApiRequestUrl,
  localApiNoStoreRequestHeaders,
  localApiNoStoreResponseHeaders,
  type RendererCacheCleanupResult,
} from "./renderer-cache-policy.mjs";
import { loadOrCreateDesktopMasterKey } from "./secure-master-key.mjs";
import type { DesktopUpdateSnapshot } from "./update-status.mjs";
import { DesktopUpdater } from "./updater.mjs";

type RunningServer = {
  url: string;
  getSettings: () => {
    notificationsEnabled: boolean;
    notifyWhenFocused: boolean;
    notificationSound: NotificationSound;
    closeBehavior: CloseBehavior;
  };
  updateSettings: (patch: { closeBehavior: CloseBehavior }) => { closeBehavior: CloseBehavior };
  close: () => Promise<void>;
};

type ServerRuntimeModule = {
  startServer: (options?: {
    onNewInboxMessages?: (messages: NewMailPayload[]) => void;
    masterKey?: Buffer;
  }) => Promise<RunningServer>;
};

type NewMailPayload = {
  id: string;
  accountId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
};

type NativeNotificationPayload = {
  title: string;
  body: string;
  silent: boolean;
};

type NotificationSound = "system" | "soft" | "bright" | "none";
type CloseBehavior = "ask" | "tray" | "quit";

type DesktopSmokeNotificationResult = {
  invoked: boolean;
  shown?: boolean;
  error?: string;
};

type DesktopLocalApiSmokeResult = {
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

type DesktopWallpaperSmokeResult = {
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

type DesktopSettingsUiSmokeResult = {
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

type DesktopLifecycleSmokeResult = {
  appUserModelId: string;
  closeBehavior: CloseBehavior;
  iconWidth: number;
  iconHeight: number;
  trayCreated: boolean;
  error?: string;
};

type DesktopClosePromptScenarioSmokeResult = {
  eventPrevented: boolean;
  simulatedNativeDialogCalls: number;
  closeBehavior: CloseBehavior | "";
  trayCreated: boolean;
  windowHidden: boolean;
  quitRequested: boolean;
};

type DesktopClosePromptSmokeResult = {
  initialCloseBehavior: CloseBehavior | "";
  cancel: DesktopClosePromptScenarioSmokeResult;
  minimizeAndRemember: DesktopClosePromptScenarioSmokeResult;
  quitAndRemember: DesktopClosePromptScenarioSmokeResult;
  finalCloseBehavior: CloseBehavior | "";
  error?: string;
};

type DesktopSettingsSyncSmokeResult = {
  initialCloseBehavior: CloseBehavior | "";
  updatedCloseBehavior: CloseBehavior | "";
  restoredCloseBehavior: CloseBehavior | "";
  error?: string;
};

type DesktopSingleInstanceSmokeResult = {
  activationCount: number;
  restored: boolean;
  serviceUrl: string;
};

type ClosePromptDialogResult = Pick<Electron.MessageBoxReturnValue, "response" | "checkboxChecked">;

type ClosePromptSmokeSession = {
  result: ClosePromptDialogResult;
  simulatedNativeDialogCalls: number;
  quitRequested: boolean;
};

let mainWindow: BrowserWindow | undefined;
let localServer: RunningServer | undefined;
let tray: Tray | undefined;
let appIcon: NativeImage | undefined;
let isQuitting = false;
let shutdownPromise: Promise<void> | undefined;
let closePromptPending = false;
let closePromptSmokeSession: ClosePromptSmokeSession | undefined;
let rendererCustomNotificationAudioReady = false;
let localApiAccessToken: string | undefined;
let desktopUpdater: DesktopUpdater | undefined;
let rendererCacheCleanup: RendererCacheCleanupResult | undefined;
let localApiCachePolicyInstalled = false;
const desktopSmokeDiagnostics: string[] = [];
let desktopSmokeResult: Record<string, unknown> | undefined;
let singleInstanceSmokeResult: DesktopSingleInstanceSmokeResult | undefined;
const appUserModelId = app.isPackaged ? "com.nami.mail" : "com.nami.mail.dev";
const localApiAccessHeader = "x-nami-api-token";
const localApiAccessTokenEnvironmentName = "NAMI_MAIL_LOCAL_API_TOKEN";

app.setName("Nami Mail");
if (process.platform === "win32") app.setAppUserModelId(appUserModelId);
const customUserDataPath = process.env.NAMI_MAIL_USER_DATA_DIR?.trim();
if (customUserDataPath) app.setPath("userData", path.resolve(customUserDataPath));
const requestedSmokeExitDelay = Number.parseInt(process.env.NAMI_MAIL_SMOKE_EXIT_AFTER_READY_MS ?? "", 10);
const smokeExitDelay = Number.isFinite(requestedSmokeExitDelay) && requestedSmokeExitDelay >= 1_000
  ? requestedSmokeExitDelay
  : 0;
const smokeResultPath = process.env.NAMI_MAIL_SMOKE_RESULT_PATH?.trim()
  ? path.resolve(process.env.NAMI_MAIL_SMOKE_RESULT_PATH)
  : undefined;
const isDesktopSmoke = process.env.NAMI_MAIL_SMOKE === "1" && Boolean(smokeResultPath);
const desktopLoopbackPort = "0";
const desktopShutdownTimeoutMs = 8_000;
const desktopOAuthEnvironmentNames = [
  "NAMI_MAIL_GOOGLE_OAUTH_CLIENT_ID",
  "NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID",
  "NAMI_MAIL_MICROSOFT_TENANT",
  "NAMI_MAIL_OAUTH_FLOW_TTL_SECONDS",
] as const;

async function loadDesktopOAuthEnvironment(): Promise<void> {
  // The installed app cannot rely on a project-root .env. Restrict the
  // user-data file to public OAuth configuration so it cannot change the
  // desktop service's loopback, database, or key paths.
  const paths = [path.join(app.getPath("userData"), "nami-mail.env")];
  if (!app.isPackaged) paths.push(path.join(app.getAppPath(), ".env"));

  for (const filePath of paths) {
    try {
      const values = parseDotenv(await fs.readFile(filePath, "utf8"));
      for (const name of desktopOAuthEnvironmentNames) {
        const value = values[name]?.trim();
        if (value && process.env[name] === undefined) process.env[name] = value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Nami Mail could not read desktop OAuth configuration: ${filePath}`, error);
      }
    }
  }
}

function configureLocalService(): void {
  const dataDirectory = path.join(app.getPath("userData"), "data");
  // This is a process-only capability. It is never written to userData or
  // appended to the renderer URL, and is regenerated on every launch.
  localApiAccessToken = randomBytes(32).toString("base64url");
  process.env.HOST = "127.0.0.1";
  // Let Windows allocate an ephemeral loopback port. The installed app never
  // reserves a conventional development port such as 3000 or 5173.
  process.env.PORT = desktopLoopbackPort;
  process.env.DATABASE_PATH = path.join(dataDirectory, "nami-mail.db");
  // The Electron runtime always passes its DPAPI-unwrapped key in memory.
  // Do not inherit or create a plaintext desktop MASTER_KEY_PATH fallback.
  delete process.env.MASTER_KEY_PATH;
  process.env.WEB_DIST_PATH = path.join(app.getAppPath(), "apps", "web", "dist");
  process.env[localApiAccessTokenEnvironmentName] = localApiAccessToken;
}

function clearLocalApiAccessToken(): void {
  if (process.env[localApiAccessTokenEnvironmentName] === localApiAccessToken) {
    delete process.env[localApiAccessTokenEnvironmentName];
  }
  localApiAccessToken = undefined;
}

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("nami:settings-changed");
}

function loadDesktopIcon(): NativeImage {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(app.getAppPath(), "build", "icon.ico");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error(`Nami Mail icon could not be loaded: ${iconPath}`);
  return icon;
}

function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = undefined;
}

function ensureTray(): Tray {
  if (tray && !tray.isDestroyed()) return tray;
  const nextTray = new Tray(appIcon ?? loadDesktopIcon());
  nextTray.setToolTip("Nami Mail");
  nextTray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Nami Mail", click: focusMainWindow },
    { type: "separator" },
    { label: "退出 Nami Mail", click: () => app.quit() },
  ]));
  nextTray.on("click", focusMainWindow);
  nextTray.on("double-click", focusMainWindow);
  tray = nextTray;
  return nextTray;
}

function hideMainWindowToTray(): boolean {
  if (!mainWindow) return false;
  try {
    ensureTray();
    mainWindow.hide();
    return true;
  } catch (error) {
    console.error("Nami Mail could not create its tray icon", error);
    dialog.showErrorBox(
      "无法最小化到托盘",
      "系统托盘图标创建失败，窗口将保持打开。请重新启动 Nami Mail 后再试。",
    );
    return false;
  }
}

async function rememberCloseBehavior(closeBehavior: CloseBehavior): Promise<void> {
  if (!localServer) throw new Error("Nami Mail local service is not available.");
  localServer.updateSettings({ closeBehavior });
  mainWindow?.webContents.send("nami:settings-changed");
}

async function showClosePrompt(
  targetWindow: BrowserWindow,
  options: Electron.MessageBoxOptions,
): Promise<ClosePromptDialogResult> {
  // The desktop smoke exercises the real close handler but cannot leave a
  // native modal open or terminate its own Electron process midway through.
  if (smokeResultPath && closePromptSmokeSession) {
    closePromptSmokeSession.simulatedNativeDialogCalls += 1;
    return closePromptSmokeSession.result;
  }
  return dialog.showMessageBox(targetWindow, options);
}

function quitFromClosePrompt(): void {
  if (smokeResultPath && closePromptSmokeSession) {
    closePromptSmokeSession.quitRequested = true;
    return;
  }
  app.quit();
}

async function askHowToClose(): Promise<void> {
  if (!mainWindow || closePromptPending) return;
  closePromptPending = true;
  const targetWindow = mainWindow;
  try {
    const result = await showClosePrompt(targetWindow, {
      type: "question",
      title: "关闭窗口时",
      message: "关闭窗口后，Nami Mail 要继续在后台接收新邮件吗？",
      detail: "最小化到托盘后会继续同步邮件和发送通知。以后可在“设置 > 桌面应用”中更改。",
      buttons: ["最小化到托盘", "退出 Nami Mail", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      checkboxLabel: "记住我的选择",
      checkboxChecked: true,
    });
    if (result.response === 2) return;

    const closeBehavior: CloseBehavior = result.response === 0 ? "tray" : "quit";
    if (closeBehavior === "tray" && !hideMainWindowToTray()) return;
    if (result.checkboxChecked) {
      try {
        await rememberCloseBehavior(closeBehavior);
      } catch (error) {
        console.error("Nami Mail could not save its close behavior", error);
        dialog.showErrorBox("无法保存关闭偏好", "本次选择仍会执行，但下次关闭窗口时会再次询问。");
      }
    }
    if (closeBehavior === "quit") quitFromClosePrompt();
  } finally {
    closePromptPending = false;
  }
}

async function requestMainWindowClose(event: Pick<Electron.Event, "preventDefault">): Promise<void> {
  if (isQuitting) return;
  const closeBehavior = localServer?.getSettings().closeBehavior ?? "ask";
  event.preventDefault();
  if (closeBehavior === "quit") {
    app.quit();
    return;
  }
  if (closeBehavior === "tray") {
    hideMainWindowToTray();
    return;
  }
  await askHowToClose();
}

function handleMainWindowClose(event: Electron.Event): void {
  void requestMainWindowClose(event);
}

function closeLocalServerForExit(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  const server = localServer;
  shutdownPromise = (async () => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      if (server) {
        await Promise.race([
          server.close(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error(`Desktop shutdown exceeded ${desktopShutdownTimeoutMs} ms.`)), desktopShutdownTimeoutMs);
            timeout.unref?.();
          }),
        ]);
      }
    } catch (error) {
      console.error("Nami Mail shutdown failed", error);
    } finally {
      if (timeout) clearTimeout(timeout);
      localServer = undefined;
      clearLocalApiAccessToken();
      destroyTray();
    }
  })();
  return shutdownPromise;
}

function shutdownLocalServerAndQuit(): void {
  if (isQuitting) return;
  isQuitting = true;
  void closeLocalServerForExit().finally(() => app.quit());
}

async function prepareLocalServerForUpdateInstall(): Promise<boolean> {
  if (isQuitting || !localServer) return false;
  const server = localServer;
  try {
    // Do not race this close against the normal bounded quit timeout. Starting
    // NSIS while SQLite or an SMTP attempt is still closing can corrupt local
    // state or turn a known delivery into an interrupted one.
    await server.close();
    localServer = undefined;
    clearLocalApiAccessToken();
    destroyTray();
    isQuitting = true;
    return true;
  } catch (error) {
    console.error("Nami Mail could not prepare its data for update", error);
    return false;
  }
}

function recoverAfterUpdateInstallFailure(): void {
  // The service has already closed and its in-memory key has been cleared.
  // Relaunching is the smallest recovery that restores a fully usable app and
  // unwraps the DPAPI key again without retaining another plaintext key copy.
  app.relaunch();
  app.exit(0);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isLocalAppUrl(value: string): boolean {
  try {
    return new URL(value).origin === new URL(localServer?.url ?? "http://invalid.local").origin;
  } catch {
    return false;
  }
}

function isCurrentRenderer(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const window = mainWindow;
  const frame = event.senderFrame;
  return Boolean(
    window
    && event.sender.id === window.webContents.id
    && frame
    && frame === window.webContents.mainFrame
    && isLocalAppUrl(frame.url),
  );
}

function checkForUpdatesAfterExternalTrigger(): void {
  void desktopUpdater?.checkAfterExternalTrigger();
}

function installLocalApiHeaderInjection(window: BrowserWindow): void {
  const service = localServer;
  const token = localApiAccessToken;
  if (!service || !token) throw new Error("Nami Mail local API access token is unavailable.");

  const localOrigin = new URL(service.url).origin;
  const requestFilter = { urls: [`${localOrigin}/api/*`] };
  const webRequest = window.webContents.session.webRequest;
  webRequest.onBeforeSendHeaders(requestFilter, (details, callback) => {
    try {
      if (!isLocalApiRequestUrl(details.url, localOrigin)) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      const headers = localApiNoStoreRequestHeaders(details.requestHeaders);
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === localApiAccessHeader) delete headers[name];
      }
      headers[localApiAccessHeader] = token;
      callback({ requestHeaders: headers });
    } catch {
      callback({ requestHeaders: details.requestHeaders });
    }
  });
  webRequest.onHeadersReceived(requestFilter, (details, callback) => {
    if (!isLocalApiRequestUrl(details.url, localOrigin)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({ responseHeaders: localApiNoStoreResponseHeaders(details.responseHeaders) });
  });
  localApiCachePolicyInstalled = true;
}

function normalizeNotificationPayload(value: unknown): NativeNotificationPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as Partial<NativeNotificationPayload>;
  if (typeof payload.title !== "string" || typeof payload.body !== "string" || typeof payload.silent !== "boolean") return undefined;
  const title = payload.title.trim().slice(0, 120);
  const body = payload.body.trim().slice(0, 500);
  if (!title) return undefined;
  return { title, body, silent: payload.silent };
}

function normalizeVerificationCode(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4,8}$/.test(value) ? value : undefined;
}

function showNativeNotification(payload: NativeNotificationPayload, onClick?: () => void): boolean {
  if (!Notification.isSupported()) return false;
  try {
    const notification = new Notification(payload);
    if (onClick) notification.on("click", onClick);
    notification.show();
    return true;
  } catch (error) {
    // Windows can reject a notification when its policy is disabled. That must
    // not interrupt local mail sync or make the desktop shell fail to launch.
    console.warn("Nami Mail could not show a native notification", error);
    return false;
  }
}

function shouldUseRendererCustomSound(sound: NotificationSound): boolean {
  return (sound === "soft" || sound === "bright")
    && Boolean(mainWindow?.isFocused())
    && rendererCustomNotificationAudioReady;
}

function normalizeDesktopSmokeNotificationResult(value: unknown): DesktopSmokeNotificationResult | undefined {
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

async function waitForDesktopSmokeNotification(): Promise<DesktopSmokeNotificationResult> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const serialized = await mainWindow?.webContents.executeJavaScript(
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

function desktopSmokeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Desktop local API smoke failed.";
  return (localApiAccessToken ? message.replaceAll(localApiAccessToken, "[redacted]") : message).slice(0, 500);
}

function normalizeDesktopLocalApiSmokeResult(value: unknown): DesktopLocalApiSmokeResult | undefined {
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

async function inspectDesktopLocalApiSmoke(): Promise<DesktopLocalApiSmokeResult> {
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
  if (!mainWindow) return { ...fallback, error: "Desktop window is unavailable for local API smoke." };

  try {
    // This runs in the real renderer. Its fetches must cross Electron's
    // network stack, where the per-launch capability is injected for the
    // loopback API. Only a redacted, assertion-ready summary comes back.
    const result = await mainWindow.webContents.executeJavaScript(`
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

async function inspectDesktopWallpaper(): Promise<DesktopWallpaperSmokeResult> {
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
  if (!mainWindow) return fallback;

  try {
    // The smoke window stays hidden so it does not interrupt an operator. In
    // that state Chromium can throttle the decorative reveal animation and
    // retain its zero-opacity first keyframe. Finish only that animation so
    // this probe checks the stable user-visible style rather than scheduler
    // timing; reduced-motion mode has no animation to finish.
    await mainWindow.webContents.executeJavaScript("new Promise((resolve) => setTimeout(resolve, 450))");
    await mainWindow.webContents.executeJavaScript(`
      (() => {
        const wallpaper = document.querySelector('.workspace-background');
        if (!(wallpaper instanceof HTMLElement)) return;
        for (const animation of wallpaper.getAnimations()) animation.finish();
        void getComputedStyle(wallpaper).opacity;
      })()
    `);
    const result = await mainWindow.webContents.executeJavaScript(`
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

async function inspectDesktopSettingsUi(): Promise<DesktopSettingsUiSmokeResult> {
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
  if (!mainWindow) return fallback;

  try {
    // This only exercises the renderer's early size validation. A structural
    // file object avoids allocating a 50 MB buffer during every smoke run.
    return await mainWindow.webContents.executeJavaScript(`
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
        const settingsButton = Array.from(document.querySelectorAll('button'))
          .find((button) => button.getAttribute('aria-label') === '设置');
        if (!(settingsButton instanceof HTMLButtonElement)) throw new Error('Settings button was not rendered.');
        settingsButton.click();

        const settings = await waitFor(() => document.querySelector('.settings-modal'));
        if (!(settings instanceof HTMLElement)) throw new Error('Settings dialog did not open.');
        const completeSettings = await waitFor(() => {
          const settingsBackdrop = settings.parentElement;
          const lightBrandMark = document.querySelector('.brand-mark-light');
          const darkBrandMark = document.querySelector('.brand-mark-dark');
          const title = settings.querySelector('#settings-title');
          const editable = settings.querySelector('input[type="range"]');
          const updateRow = settings.querySelector('.update-setting-row');
          const input = settings.querySelector('input[type="file"]');
          const uploadButton = settings.querySelector('.background-actions .secondary-button');
          if (
            !(settingsBackdrop instanceof HTMLElement)
            || !(lightBrandMark instanceof HTMLImageElement)
            || !(darkBrandMark instanceof HTMLImageElement)
            || !(title instanceof HTMLElement)
            || !(editable instanceof HTMLInputElement)
            || !(updateRow instanceof HTMLElement)
            || !(input instanceof HTMLInputElement)
            || !(uploadButton instanceof HTMLButtonElement)
          ) {
            return null;
          }
          return { settingsBackdrop, lightBrandMark, darkBrandMark, title, editable, updateRow, input, uploadButton };
        });
        if (!completeSettings) throw new Error('Settings controls were not rendered after waiting for the desktop update status.');
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

          const closeButton = settings.querySelector('button[aria-label="关闭设置"]');
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

async function inspectDesktopSettingsSync(): Promise<DesktopSettingsSyncSmokeResult> {
  const fallback: DesktopSettingsSyncSmokeResult = {
    initialCloseBehavior: "",
    updatedCloseBehavior: "",
    restoredCloseBehavior: "",
  };
  if (!mainWindow || !localServer) return fallback;

  const targetWindow = mainWindow;
  const service = localServer;
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
          const settingsButton = document.querySelector('.sidebar-footer-actions .icon-button');
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
    await rememberCloseBehavior("tray");
    const updatedCloseBehavior = await waitForCloseBehavior("tray");

    // Simulate a setting changed outside React, then use the same focus path
    // as a tray restore to request the authoritative settings again.
    service.updateSettings({ closeBehavior: "ask" });
    focusMainWindow();
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

function createClosePromptScenarioFallback(): DesktopClosePromptScenarioSmokeResult {
  return {
    eventPrevented: false,
    simulatedNativeDialogCalls: 0,
    closeBehavior: "",
    trayCreated: false,
    windowHidden: false,
    quitRequested: false,
  };
}

async function inspectDesktopClosePrompt(): Promise<DesktopClosePromptSmokeResult> {
  const fallback: DesktopClosePromptSmokeResult = {
    initialCloseBehavior: "",
    cancel: createClosePromptScenarioFallback(),
    minimizeAndRemember: createClosePromptScenarioFallback(),
    quitAndRemember: createClosePromptScenarioFallback(),
    finalCloseBehavior: "",
  };
  if (!mainWindow || !localServer) return fallback;

  const targetWindow = mainWindow;
  const service = localServer;
  const runScenario = async (result: ClosePromptDialogResult): Promise<DesktopClosePromptScenarioSmokeResult> => {
    let eventPrevented = false;
    const session: ClosePromptSmokeSession = {
      result,
      simulatedNativeDialogCalls: 0,
      quitRequested: false,
    };
    service.updateSettings({ closeBehavior: "ask" });
    focusMainWindow();
    closePromptSmokeSession = session;
    try {
      await requestMainWindowClose({
        preventDefault: () => {
          eventPrevented = true;
        },
      });
      return {
        eventPrevented,
        simulatedNativeDialogCalls: session.simulatedNativeDialogCalls,
        closeBehavior: service.getSettings().closeBehavior,
        trayCreated: Boolean(tray && !tray.isDestroyed()),
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
    focusMainWindow();
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
    focusMainWindow();
  }
}

function notifyNewMail(messages: NewMailPayload[]): void {
  const settings = localServer?.getSettings();
  if (!settings) return;
  const first = messages[0];
  if (!first) return;
  // The renderer still needs a new-mail event to refresh its local list when
  // alerts are disabled. shouldAlert only controls user-facing interruption.
  const shouldAlert = settings.notificationsEnabled && (!mainWindow?.isFocused() || settings.notifyWhenFocused);
  const useRendererCustomSound = shouldAlert && shouldUseRendererCustomSound(settings.notificationSound);
  mainWindow?.webContents.send("nami:new-mail", {
    id: first.id,
    subject: first.subject,
    fromName: first.fromName,
    fromAddress: first.fromAddress,
    count: messages.length,
    shouldAlert,
    playCustomSound: useRendererCustomSound,
  });
  if (!shouldAlert) return;

  const sender = first.fromName || first.fromAddress || "新联系人";
  const title = messages.length === 1 ? `${sender} · Nami Mail` : `Nami Mail · ${messages.length} 封新邮件`;
  const body = messages.length === 1 ? first.subject : `${sender} 等邮件已同步到收件箱`;
  // Soft and bright sounds are muted only after the renderer has explicitly
  // reported a user-unlocked running AudioContext in the focused window.
  // All other paths fall back to the Windows sound; "none" remains silent.
  showNativeNotification({
    title,
    body,
    silent: settings.notificationSound === "none" || useRendererCustomSound,
  }, () => {
    focusMainWindow();
    mainWindow?.webContents.send("nami:open-message", first.id);
  });
}

async function createMainWindow(): Promise<void> {
  if (!localServer) throw new Error("Nami Mail local service was not started.");

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 360,
    minHeight: 520,
    show: false,
    title: "Nami Mail",
    icon: appIcon,
    backgroundColor: "#ececef",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(import.meta.dirname, "preload.cjs"),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  // CSS image loads do not pass through the renderer's fetch wrapper. The
  // session-level injection covers those API resources without ever placing
  // the capability in a URL.
  installLocalApiHeaderInjection(mainWindow);
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    if (!smokeResultPath) return;
    desktopSmokeDiagnostics.push(`Preload ${preloadPath}: ${error.message}`);
  });
  mainWindow.webContents.on("did-start-loading", () => {
    rendererCustomNotificationAudioReady = false;
  });
  mainWindow.webContents.on("console-message", (event) => {
    if (!smokeResultPath || !["warning", "error"].includes(event.level)) return;
    desktopSmokeDiagnostics.push(`Renderer ${event.level}: ${event.message}`);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isLocalAppUrl(url)) return;
    event.preventDefault();
    if (isHttpUrl(url)) void shell.openExternal(url);
  });
  mainWindow.once("ready-to-show", () => {
    if (!smokeExitDelay) mainWindow?.show();
  });
  mainWindow.on("close", handleMainWindowClose);
  mainWindow.on("closed", () => {
    rendererCustomNotificationAudioReady = false;
    mainWindow = undefined;
  });
  mainWindow.on("blur", () => {
    rendererCustomNotificationAudioReady = false;
  });

  const appUrl = new URL(localServer.url);
  appUrl.searchParams.set("desktop", "1");
  if (isDesktopSmoke) appUrl.searchParams.set("desktopSmoke", "1");
  await mainWindow.loadURL(appUrl.toString());
}

function inspectDesktopLifecycle(): DesktopLifecycleSmokeResult {
  const fallback: DesktopLifecycleSmokeResult = {
    appUserModelId,
    closeBehavior: localServer?.getSettings().closeBehavior ?? "ask",
    iconWidth: 0,
    iconHeight: 0,
    trayCreated: false,
  };
  try {
    const iconSize = (appIcon ?? loadDesktopIcon()).getSize();
    ensureTray();
    return {
      ...fallback,
      iconWidth: iconSize.width,
      iconHeight: iconSize.height,
      trayCreated: Boolean(tray && !tray.isDestroyed()),
    };
  } catch (error) {
    return {
      ...fallback,
      error: error instanceof Error ? error.message : "Desktop lifecycle smoke failed.",
    };
  } finally {
    destroyTray();
  }
}

async function writeSmokeResult(result: Record<string, unknown>): Promise<void> {
  if (!smokeResultPath) return;
  desktopSmokeResult = result;
  await fs.mkdir(path.dirname(smokeResultPath), { recursive: true });
  await fs.writeFile(smokeResultPath, JSON.stringify(result), "utf8");
}

async function recordSingleInstanceSmokeActivation(commandLine: string[]): Promise<void> {
  if (!isDesktopSmoke || !commandLine.includes("--nami-single-instance-smoke")) return;
  const activationCount = (singleInstanceSmokeResult?.activationCount ?? 0) + 1;
  focusMainWindow();
  singleInstanceSmokeResult = {
    activationCount,
    restored: Boolean(mainWindow?.isVisible()) && !mainWindow?.isMinimized(),
    serviceUrl: localServer?.url ?? "",
  };
  if (desktopSmokeResult) {
    await writeSmokeResult({ ...desktopSmokeResult, desktopSingleInstance: singleInstanceSmokeResult });
  }
}

async function boot(): Promise<void> {
  await app.whenReady();
  appIcon = loadDesktopIcon();
  await loadDesktopOAuthEnvironment();
  configureLocalService();

  try {
    // The session exists only after `ready`. Clear historical HTTP and
    // Service Worker cache before creating or loading any renderer window.
    // This deliberately excludes cookies, auth cache, localStorage and IDB.
    rendererCacheCleanup = await clearLegacyRendererMailCache(session.defaultSession);
    const runtimePath = "../../server/dist/runtime.js";
    const runtime = await import(runtimePath) as ServerRuntimeModule;
    const dataDirectory = path.join(app.getPath("userData"), "data");
    const desktopMasterKey = await loadOrCreateDesktopMasterKey(dataDirectory, safeStorage);
    try {
      localServer = await runtime.startServer({
        masterKey: desktopMasterKey.key,
        onNewInboxMessages: notifyNewMail,
      });
    } finally {
      // startServer copies the key for its own lifetime. This copy exists only
      // to cross the Electron-to-runtime boundary and is no longer needed.
      desktopMasterKey.key.fill(0);
    }
    await createMainWindow();
    desktopUpdater = new DesktopUpdater({
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      updateConfigPath: path.join(process.resourcesPath, "app-update.yml"),
      updateTrustPath: path.join(process.resourcesPath, "nami-update-trust.json"),
      userDataPath: app.getPath("userData"),
      executablePath: process.execPath,
      disabled: isDesktopSmoke,
      broadcast: (snapshot) => mainWindow?.webContents.send("nami:update-status", snapshot),
      prepareForInstall: prepareLocalServerForUpdateInstall,
      recoverAfterInstallFailure: recoverAfterUpdateInstallFailure,
      quitForInstall: () => app.quit(),
    });
    const desktopUpdate: DesktopUpdateSnapshot = await desktopUpdater.start();
    powerMonitor.on("resume", checkForUpdatesAfterExternalTrigger);
    const desktopNotificationTest = smokeResultPath
      ? await waitForDesktopSmokeNotification()
      : undefined;
    const simulatedWebFrameVisible = !smokeResultPath
      ? undefined
      : !mainWindow
        ? true
        : await mainWindow.webContents.executeJavaScript("Boolean(document.querySelector('.window-bar'))").catch(() => true);
    const desktopWallpaper = smokeResultPath ? await inspectDesktopWallpaper() : undefined;
    const desktopSettingsUi = smokeResultPath ? await inspectDesktopSettingsUi() : undefined;
    const desktopSettingsSync = smokeResultPath ? await inspectDesktopSettingsSync() : undefined;
    const desktopClosePrompt = smokeResultPath ? await inspectDesktopClosePrompt() : undefined;
    const desktopLifecycle = smokeResultPath ? inspectDesktopLifecycle() : undefined;
    const desktopLocalApiSmoke = isDesktopSmoke ? await inspectDesktopLocalApiSmoke() : undefined;
    if (isDesktopSmoke) mainWindow?.minimize();
    await writeSmokeResult({
      rendererUrl: mainWindow?.webContents.getURL(),
      title: mainWindow?.getTitle(),
      simulatedWebFrameVisible,
      desktopWallpaper,
      desktopSettingsUi,
      desktopSettingsSync,
      desktopClosePrompt,
      desktopLifecycle,
      desktopApiAvailable: desktopNotificationTest?.invoked ?? false,
      desktopNotificationTest,
      desktopLocalApiSmoke,
      desktopCacheProtection: {
        cleanup: rendererCacheCleanup,
        localApiPolicyInstalled: localApiCachePolicyInstalled,
        responseNoStoreObserved: desktopLocalApiSmoke?.cacheControl.toLowerCase().split(",").map((value) => value.trim()).includes("no-store") ?? false,
        responseCacheControl: desktopLocalApiSmoke?.cacheControl ?? "",
        responsePragma: desktopLocalApiSmoke?.pragma ?? "",
        responseExpires: desktopLocalApiSmoke?.expires ?? "",
        untouchedStorageTypes: ["cookies", "indexdb", "localstorage"],
      },
      desktopSingleInstance: singleInstanceSmokeResult,
      desktopUpdate,
      desktopDiagnostics: desktopSmokeDiagnostics,
    });
    if (smokeExitDelay) {
      const timer = setTimeout(() => app.quit(), smokeExitDelay);
      timer.unref();
    }
  } catch (error) {
    console.error("Nami Mail startup failed", error);
    await writeSmokeResult({ error: error instanceof Error ? error.message : "Local service startup failed." }).catch(() => undefined);
    await localServer?.close().catch(() => undefined);
    localServer = undefined;
    clearLocalApiAccessToken();
    dialog.showErrorBox("Nami Mail 无法启动", error instanceof Error ? error.message : "本地服务启动失败。");
    app.exit(1);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  ipcMain.on("nami:custom-notification-sound-ready", (event, ready: unknown) => {
    if (!isCurrentRenderer(event) || typeof ready !== "boolean") return;
    rendererCustomNotificationAudioReady = ready;
  });
  ipcMain.on("nami:update-network-online", (event) => {
    if (!isCurrentRenderer(event)) return;
    checkForUpdatesAfterExternalTrigger();
  });
  ipcMain.handle("nami:notify", (event, payload: unknown) => {
    if (!isCurrentRenderer(event)) return { shown: false };
    const normalized = normalizeNotificationPayload(payload);
    if (!normalized) return { shown: false };
    return { shown: showNativeNotification(normalized) };
  });
  ipcMain.handle("nami:copy-verification-code", (event, value: unknown) => {
    if (!isCurrentRenderer(event)) return { copied: false };
    const code = normalizeVerificationCode(value);
    if (!code) return { copied: false };
    try {
      clipboard.writeText(code);
      return { copied: true };
    } catch (error) {
      // Do not include the code in logs. Clipboard availability varies by
      // desktop session, and the renderer has a browser-only fallback.
      console.warn("Nami Mail could not copy a verification code", error);
      return { copied: false };
    }
  });
  ipcMain.handle("nami:local-api-request-headers", (event) => {
    if (!isCurrentRenderer(event) || !localServer || !localApiAccessToken) return {};
    return { [localApiAccessHeader]: localApiAccessToken };
  });
  ipcMain.handle("nami:update-get-status", (event) => {
    if (!isCurrentRenderer(event)) return undefined;
    return desktopUpdater?.getSnapshot();
  });
  ipcMain.handle("nami:update-check", async (event) => {
    if (!isCurrentRenderer(event)) return undefined;
    return desktopUpdater?.checkForUpdates();
  });
  ipcMain.handle("nami:update-download", async (event) => {
    if (!isCurrentRenderer(event)) return undefined;
    return desktopUpdater?.downloadAvailableUpdate();
  });
  ipcMain.handle("nami:update-skip", async (event) => {
    if (!isCurrentRenderer(event)) return undefined;
    return desktopUpdater?.skipAvailableUpdate();
  });
  ipcMain.handle("nami:update-snooze", async (event, durationMinutes: unknown) => {
    if (!isCurrentRenderer(event) || typeof durationMinutes !== "number" || !Number.isFinite(durationMinutes)) return undefined;
    return desktopUpdater?.snoozeAvailableUpdate(durationMinutes);
  });
  ipcMain.handle("nami:update-install", async (event) => {
    if (!isCurrentRenderer(event)) return { accepted: false };
    return desktopUpdater?.installDownloadedUpdate() ?? { accepted: false };
  });
  app.on("second-instance", (_event, commandLine) => {
    void recordSingleInstanceSmokeActivation(commandLine);
    focusMainWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (!localServer || isQuitting) return;
    event.preventDefault();
    shutdownLocalServerAndQuit();
  });
  app.on("will-quit", () => {
    powerMonitor.removeListener("resume", checkForUpdatesAfterExternalTrigger);
    desktopUpdater?.dispose();
  });
  void boot();
}
