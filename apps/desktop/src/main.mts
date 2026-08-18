import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, safeStorage, session, shell, Tray, type NativeImage } from "electron";
import { parse as parseDotenv } from "dotenv";
import type { AgentResponseEnvelope, BrokerJsonValue, CallerContext, ExternalPairingSummary } from "@nami/agent-contracts";
import { createHash, randomBytes } from "node:crypto";
import { exec, spawn as nodeSpawn } from "node:child_process";
import { writeFileSync, existsSync, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { desktopLocalConfigurationFiles } from "./local-configuration.mjs";
import {
  clearLegacyRendererMailCache,
  isLocalApiRequestUrl,
  localApiNoStoreRequestHeaders,
  localApiNoStoreResponseHeaders,
  type RendererCacheCleanupResult,
} from "./renderer-cache-policy.mjs";
import { nativeText, type NativeCopyKey, type NativeTranslationValues } from "./native-localization.mjs";
import {
  applyGlobalShortcut as applyGlobalShortcutPolicy,
  applyLaunchAtStartup as applyLaunchAtStartupPolicy,
  applyUnreadBadge as applyUnreadBadgePolicy,
  BADGE_OVERLAY_DATA_URL,
  buildTrayMenuTemplate,
  extractMailtoUrl,
  FOCUS_GLOBAL_SHORTCUT_ACCELERATOR,
  type GlobalShortcutApi,
  type LaunchAtStartupApi,
  type TrayMenuAction,
  type UnreadBadgeApi,
} from "./desktop-behaviors.mjs";
import { loadOrCreateDesktopMasterKey } from "./secure-master-key.mjs";
import type { DesktopUpdateSnapshot } from "./update-status.mjs";
import { DesktopUpdater } from "./updater.mjs";
import {
  AgentHostUpdateDrainLifecycle,
  resolveDesktopAgentLaunch,
  type VerifiedAgentHost,
} from "./agent/desktop-host-integration.mjs";
import { DesktopAgentBrokerHost, probeDesktopBrokerLiveness } from "./agent/desktop-broker.mjs";
import { BrokerRecoveryCoordinator, type BrokerRecoveryGateState } from "./agent/broker-recovery.mjs";
import {
  DesktopClientProfileStore,
  clientProfilesPath,
  readPairingRequest,
  writePairingOutcome,
} from "./agent/broker-state.mjs";
import { runDesktopCli } from "./agent/cli-entry.mjs";
import {
  agentConfirmationIpcChannel,
  createAgentConfirmationIpcHandler,
  type AgentConfirmationDecision,
} from "./agent/confirmation-ipc.mjs";

type RunningServer = {
  url: string;
  invokeExternalAgentTool: (input: {
    requestId: string;
    caller: CallerContext;
    toolName: string;
    input: unknown;
  }) => Promise<AgentResponseEnvelope<BrokerJsonValue>>;
  listExternalPairingAccountIds: () => string[];
  resolveAgentConfirmation?: (confirmationId: string, decision: AgentConfirmationDecision) => Promise<unknown>;
  getSettings: () => {
    locale: string;
    notificationsEnabled: boolean;
    notifyWhenFocused: boolean;
    notificationSound: NotificationSound;
    closeBehavior: CloseBehavior;
    launchAtStartup: boolean;
    globalShortcutEnabled: boolean;
  };
  updateSettings: (patch: { closeBehavior: CloseBehavior }) => { closeBehavior: CloseBehavior };
  close: () => Promise<void>;
};

type DesktopConfirmationRuntimeOptions = Readonly<{
  capability: unknown;
  verifier: Readonly<{
    verify: (input: unknown) => Readonly<{ principalId: string; surfaceId: string }> | undefined;
  }>;
}>;

type ExternalConfirmationRuntimeOptions = Readonly<{
  request: (input: {
    confirmationId: string;
    requestId: string;
    toolName: string;
    callerLabel: string;
    title: string;
    summary: string;
    fields: readonly { label: string; value: string }[];
  }) => Promise<"approve" | "reject">;
}>;

type ServerRuntimeModule = {
  startServer: (options?: {
    onNewInboxMessages?: (messages: NewMailPayload[]) => void;
    onAutoReplyEvent?: (event: DesktopAutoReplyEvent) => void;
    masterKey?: Buffer;
    desktopConfirmation?: DesktopConfirmationRuntimeOptions;
    externalConfirmation?: ExternalConfirmationRuntimeOptions;
    listExternalPairings?: () => Promise<ExternalPairingSummary[]>;
  }) => Promise<RunningServer>;
};

type NewMailPayload = {
  id: string;
  accountId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
};

type DesktopAutoReplyEvent =
  | {
    kind: "pending";
    confirmationId: string;
    requestId: string;
    accountId: string;
    messageId: string;
    subject: string;
    fromName: string;
    fromAddress: string;
    sensitive: boolean;
    createdAt: string;
    expiresAt: string;
    replyPreview: string;
  }
  | {
    kind: "sent";
    messageId: string;
    accountId: string;
    subject: string;
    toName: string;
    toAddress: string;
    replyPreview: string;
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
// This capability never crosses IPC, preload, HTTP, or persistent storage.
const desktopConfirmationCapability = Symbol("nami-desktop-confirmation");
const desktopConfirmationVerifier: DesktopConfirmationRuntimeOptions["verifier"] = Object.freeze({
  verify: (input: unknown) => {
    if (!input || typeof input !== "object") return undefined;
    const candidate = input as {
      capability?: unknown;
      caller?: { kind?: unknown; interactive?: unknown };
      confirmationId?: unknown;
      requestId?: unknown;
      operation?: unknown;
    };
    if (
      candidate.capability !== desktopConfirmationCapability
      || candidate.caller?.kind !== "desktop-ui"
      || candidate.caller?.interactive !== true
      || typeof candidate.confirmationId !== "string"
      || typeof candidate.requestId !== "string"
      || (candidate.operation !== "record-decision" && candidate.operation !== "consume-approval")
    ) return undefined;
    return { principalId: "nami-desktop-main", surfaceId: "nami-main-window" };
  },
});

/**
 * Native-dialog bridge for paired CLI/MCP write confirmations. The request has
 * no renderer event stream, so Electron main shows a modal dialog listing the
 * caller, operation, preview, and immutable fields. `--yes` or any CLI flag
 * cannot bypass it: the host decides here and records the decision server-side.
 */
function createExternalConfirmationBridge(): ExternalConfirmationRuntimeOptions {
  return {
    request: async ({ callerLabel, toolName, title, summary, fields }) => {
      const window = mainWindow;
      if (!window) return "reject";
      const detail = [
        nativeCopy("externalConfirmCaller", { caller: callerLabel }),
        nativeCopy("externalConfirmOperation", { tool: toolName }),
        "",
        summary,
        ...fields.map((field) => `${field.label}: ${field.value}`),
      ].join("\n");
      const { response } = await dialog.showMessageBox(window, {
        type: "question",
        title: nativeCopy("externalConfirmTitle"),
        message: title,
        detail,
        buttons: [nativeCopy("externalConfirmApprove"), nativeCopy("externalConfirmReject")],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return response === 0 ? "approve" : "reject";
    },
  };
}
let tray: Tray | undefined;
let appIcon: NativeImage | undefined;
let isQuitting = false;
let shutdownPromise: Promise<void> | undefined;
let closePromptPending = false;
let closePromptSmokeSession: ClosePromptSmokeSession | undefined;
let localApiAccessToken: string | undefined;
let desktopUpdater: DesktopUpdater | undefined;
let rendererCacheCleanup: RendererCacheCleanupResult | undefined;
let localApiCachePolicyInstalled = false;
/** A mailto URL received (macOS open-url) before the window existed. */
let pendingMailtoUrl: string | undefined;
const desktopSmokeDiagnostics: string[] = [];
let desktopSmokeResult: Record<string, unknown> | undefined;
let singleInstanceSmokeResult: DesktopSingleInstanceSmokeResult | undefined;
const appUserModelId = app.isPackaged ? "com.nami.mail" : "com.nami.mail.dev";
const localApiAccessHeader = "x-nami-api-token";
const localApiAccessTokenEnvironmentName = "NAMI_MAIL_LOCAL_API_TOKEN";
// Desktop-only behaviors (badge, login item, global shortcut) live in
// desktop-behaviors.mjs; the platform-specific Electron wiring is applied
// through adapters here so the policy layer stays unit-testable.
const unreadBadgeApi: UnreadBadgeApi = {
  platform: process.platform,
  setBadgeCount: (count) => app.setBadgeCount(count),
  setOverlayIcon: (overlay, description) => mainWindow?.setOverlayIcon(overlay as NativeImage | null, description),
  createOverlayIcon: () => nativeImage.createFromDataURL(BADGE_OVERLAY_DATA_URL),
  overlayDescription: () => nativeCopy("trayTooltip"),
};
const launchAtStartupApi: LaunchAtStartupApi = {
  platform: process.platform,
  setLoginItemSettings: (options) => app.setLoginItemSettings(options),
};
const globalShortcutApi: GlobalShortcutApi = {
  isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
  register: (accelerator, listener) => globalShortcut.register(accelerator, listener),
  unregister: (accelerator) => globalShortcut.unregister(accelerator),
};
const desktopCliArguments = readDesktopCliArguments(process.argv);
const desktopAgentLaunch = resolveDesktopAgentLaunch(process.argv);
const initialPairingRequestIds = readAgentPairingRequestIds(process.argv);
let desktopAgentBroker: DesktopAgentBrokerHost | undefined;
let verifiedAgentHost: VerifiedAgentHost | undefined;
let pairingRequestTail: Promise<void> = Promise.resolve();
let desktopHostMode: "gui" | "service" = desktopAgentLaunch.kind === "service" ? "service" : "gui";
let desktopAgentBrokerRecoveryGate: BrokerRecoveryGateState = "accepting";
let desktopBootPromise: Promise<void> | undefined;
const agentUpdateDrain = new AgentHostUpdateDrainLifecycle(() => verifiedAgentHost);

app.setName("Nami Mail");
if (process.platform === "win32") app.setAppUserModelId(appUserModelId);
const customUserDataPath = process.env.NAMI_MAIL_USER_DATA_DIR?.trim();
if (customUserDataPath) app.setPath("userData", path.resolve(customUserDataPath));
const requestedSmokeExitDelay = Number.parseInt(process.env.NAMI_MAIL_SMOKE_EXIT_AFTER_READY_MS ?? "", 10);
const smokeExitDelay = Number.isFinite(requestedSmokeExitDelay) && requestedSmokeExitDelay >= 1_000
  ? requestedSmokeExitDelay
  : 0;

function readDesktopCliArguments(argv: readonly string[]): readonly string[] | undefined {
  const index = argv.indexOf("--cli");
  if (index === -1) return undefined;
  return argv.slice(index + 1);
}

function readAgentPairingRequestIds(argv: readonly string[]): string[] {
  const requestIds: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = token === "--agent-pair"
      ? argv[index + 1]
      : token?.startsWith("--agent-pair=")
        ? token.slice("--agent-pair=".length)
        : undefined;
    if (value && /^[A-Za-z0-9_-]{16,160}$/.test(value)) requestIds.push(value);
    if (token === "--agent-pair") index += 1;
  }
  return [...new Set(requestIds)];
}

function launchNamiMail(argumentsList: readonly string[]): Promise<void> {
  const argumentsForExecutable = app.isPackaged
    ? [...argumentsList]
    : [app.getAppPath(), ...argumentsList];
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn(process.execPath, argumentsForExecutable, {
        // The CLI exits after launching; its independently managed host must survive it.
        detached: process.platform === "win32" && argumentsList.length === 1 && argumentsList[0] === "--agent-host",
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.unref();
    setImmediate(resolve);
  });
}

function agentPipeScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "nami-agent-pipe.ps1")
    : path.join(app.getAppPath(), "apps", "desktop", "resources", "nami-agent-pipe.ps1");
}

function agentPairingFingerprint(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem, "utf8").digest("hex").slice(0, 16).toUpperCase();
}

function verifiedDesktopBrokerHost(host: DesktopAgentBrokerHost): VerifiedAgentHost {
  return {
    controller: {
      getSnapshot: () => {
        const discovery = host.getDiscovery();
        return {
          state: discovery ? "running" : "stopped",
          ...(discovery ? {
            mode: desktopHostMode,
            endpoint: {
              transport: "windows-named-pipe" as const,
              path: discovery.path,
              ownerSid: discovery.ownerSid,
            },
          } : {}),
          updateDrain: {
            state: discovery ? currentDesktopAgentBrokerRecoveryGate() : "closed" as const,
            activeOperationCount: 0,
          },
        };
      },
      prepareForUpdate: async () => {
        await host.drainForUpdate();
        return true;
      },
      completeUpdateHandoff: () => undefined,
      // Runtime shutdown clears its in-memory master key, so a failed update
      // recovery relaunches the application instead of reviving stale state.
      recoverAfterInstallerFailure: async () => false,
    },
    verifyActiveSidDaclPipe: () => host.verifyActiveSidDaclPipe(),
  };
}

function currentDesktopAgentBrokerRecoveryGate(): BrokerRecoveryGateState {
  return isQuitting ? "closed" : desktopAgentBrokerRecoveryGate;
}

function setDesktopAgentBroker(broker: DesktopAgentBrokerHost | undefined): void {
  desktopAgentBroker = broker;
  verifiedAgentHost = broker ? verifiedDesktopBrokerHost(broker) : undefined;
}

async function createDesktopAgentBroker(): Promise<DesktopAgentBrokerHost> {
  const server = localServer;
  if (!server) throw new Error("Nami Mail local service was not started.");
  const scriptPath = agentPipeScriptPath();
  await fs.access(scriptPath);
  const broker = new DesktopAgentBrokerHost({
    userDataPath: app.getPath("userData"),
    safeStorage,
    scriptPath,
    invokeExternalAgentTool: (input) => server.invokeExternalAgentTool(input),
    onDiagnostic: (message) => console.warn(message),
    onHostShutdown: () => { void closeLocalServerForExit().finally(() => app.quit()); },
  });
  try {
    await broker.start();
    return broker;
  } catch (error) {
    await broker.close().catch(() => undefined);
    throw error;
  }
}

const desktopAgentBrokerRecovery = new BrokerRecoveryCoordinator<DesktopAgentBrokerHost>({
  getGateState: currentDesktopAgentBrokerRecoveryGate,
  getCurrentBroker: () => desktopAgentBroker,
  setCurrentBroker: setDesktopAgentBroker,
  closeBroker: (broker) => broker.close(),
  startBroker: createDesktopAgentBroker,
  probeSignedBroker: async (broker) => (
    await broker.verifyActiveSidDaclPipe()
    && await probeDesktopBrokerLiveness(app.getPath("userData"))
  ),
});

async function startDesktopAgentBroker(): Promise<void> {
  const result = await desktopAgentBrokerRecovery.ensureHealthy();
  if (result.status === "not-accepting") {
    throw new Error(`Nami Mail Agent Broker recovery is unavailable while the desktop is ${result.state}.`);
  }
}

async function closeDesktopAgentBroker(): Promise<void> {
  const broker = desktopAgentBroker;
  setDesktopAgentBroker(undefined);
  await broker?.close();
}

async function startDesktopUpdaterIfNeeded(): Promise<DesktopUpdateSnapshot | undefined> {
  if (desktopUpdater) return desktopUpdater.getSnapshot();
  if (desktopHostMode !== "gui") return undefined;
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
    quitForInstall: quitForUpdateInstall,
  });
  const snapshot = await desktopUpdater.start();
  powerMonitor.on("resume", checkForUpdatesAfterExternalTrigger);
  return snapshot;
}
const smokeResultPath = process.env.NAMI_MAIL_SMOKE_RESULT_PATH?.trim()
  ? path.resolve(process.env.NAMI_MAIL_SMOKE_RESULT_PATH)
  : undefined;
const smokeProgressPath = process.env.NAMI_MAIL_SMOKE_PROGRESS_PATH?.trim()
  ? path.resolve(process.env.NAMI_MAIL_SMOKE_PROGRESS_PATH)
  : undefined;
const isDesktopSmoke = process.env.NAMI_MAIL_SMOKE === "1" && Boolean(smokeResultPath);
const desktopLoopbackPort = "0";
const desktopShutdownTimeoutMs = 8_000;
const desktopUpdateCloseTimeoutMs = 30_000;
async function loadDesktopLocalConfiguration(): Promise<void> {
  // The installed app cannot rely on a project-root .env. Restrict the
  // user-data file to public OAuth settings and non-secret translation
  // endpoint/timing values so it cannot change loopback, database, or keys.
  const configurationFiles = desktopLocalConfigurationFiles({
    userDataPath: app.getPath("userData"),
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  });

  for (const { filePath, environmentNames } of configurationFiles) {
    try {
      const values = parseDotenv(await fs.readFile(filePath, "utf8"));
      for (const name of environmentNames) {
        const value = values[name]?.trim();
        if (value && process.env[name] === undefined) process.env[name] = value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Nami Mail could not read desktop configuration: ${filePath}`, error);
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

function applyUnreadBadge(count: number): void {
  try {
    applyUnreadBadgePolicy(unreadBadgeApi, count);
  } catch (error) {
    // Badge APIs vary by desktop session; a failure must not take the mail
    // client down with it.
    console.warn("Nami Mail could not update its unread badge", error);
  }
}

function applyLaunchAtStartup(enabled: boolean): void {
  try {
    applyLaunchAtStartupPolicy(launchAtStartupApi, enabled);
  } catch (error) {
    // Login-item registration varies by desktop session; a failure must not
    // take the mail client down with it.
    console.warn("Nami Mail could not update its login item", error);
  }
}

function applyGlobalShortcut(enabled: boolean): void {
  try {
    const registered = applyGlobalShortcutPolicy(
      globalShortcutApi,
      enabled,
      FOCUS_GLOBAL_SHORTCUT_ACCELERATOR,
      () => focusMainWindow(),
    );
    if (!registered) {
      console.warn(`Nami Mail could not register ${FOCUS_GLOBAL_SHORTCUT_ACCELERATOR} as a global shortcut.`);
    }
  } catch (error) {
    console.warn("Nami Mail could not update its global shortcut", error);
  }
}

function applyDesktopSettingsFromServer(): void {
  if (!localServer) return;
  try {
    const settings = localServer.getSettings();
    applyLaunchAtStartup(settings.launchAtStartup);
    applyGlobalShortcut(settings.globalShortcutEnabled);
  } catch {
    // Settings are not available yet (server still starting); the renderer
    // applies the same values over IPC once it loads and saves settings.
  }
}

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (tray && !tray.isDestroyed()) refreshTrayMenu(tray);
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

function currentNativeLocale(): string | undefined {
  try {
    return localServer?.getSettings().locale;
  } catch {
    return undefined;
  }
}

function nativeCopy(key: NativeCopyKey, values?: NativeTranslationValues): string {
  return nativeText(currentNativeLocale(), key, values);
}

function refreshTrayMenu(targetTray: Tray): void {
  targetTray.setToolTip(nativeCopy("trayTooltip"));
  const template = buildTrayMenuTemplate(
    {
      hide: nativeCopy("trayHide"),
      show: nativeCopy("trayShow"),
      newMail: nativeCopy("trayNewMail"),
      inbox: nativeCopy("trayInbox"),
      quit: nativeCopy("trayQuit"),
    },
    mainWindow?.isVisible() ?? false,
  );
  targetTray.setContextMenu(Menu.buildFromTemplate(template.map((item) => {
    if (item.type === "separator") return { type: "separator" as const };
    return { label: item.label, click: () => runTrayAction(item.action) };
  })));
}

function runTrayAction(action: TrayMenuAction): void {
  switch (action.kind) {
    case "toggle-window": {
      // Both branches refresh the menu (hide via ensureTray, show via
      // focusMainWindow), so the visibility label stays accurate.
      if (mainWindow?.isVisible()) hideMainWindowToTray();
      else focusMainWindow();
      break;
    }
    case "compose-new":
      focusMainWindow();
      mainWindow?.webContents.send("nami:compose-new");
      break;
    case "open-inbox":
      focusMainWindow();
      mainWindow?.webContents.send("nami:open-inbox");
      break;
    case "quit":
      app.quit();
      break;
  }
}

function ensureTray(): Tray {
  if (tray && !tray.isDestroyed()) {
    refreshTrayMenu(tray);
    return tray;
  }
  const nextTray = new Tray(appIcon ?? loadDesktopIcon());
  refreshTrayMenu(nextTray);
  nextTray.on("click", focusMainWindow);
  nextTray.on("double-click", focusMainWindow);
  nextTray.on("right-click", () => refreshTrayMenu(nextTray));
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
      nativeCopy("trayFailureTitle"),
      nativeCopy("trayFailureMessage"),
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
      title: nativeCopy("closePromptTitle"),
      message: nativeCopy("closePromptMessage"),
      detail: nativeCopy("closePromptDetail"),
      buttons: [nativeCopy("closePromptMinimize"), nativeCopy("closePromptQuit"), nativeCopy("closePromptCancel")],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      checkboxLabel: nativeCopy("closePromptRemember"),
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
        dialog.showErrorBox(nativeCopy("closePreferenceFailureTitle"), nativeCopy("closePreferenceFailureMessage"));
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
      await closeDesktopAgentBroker().catch((error) => {
        console.error("Nami Mail Agent Broker shutdown failed", error);
      });
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
  desktopAgentBrokerRecoveryGate = "closed";
  isQuitting = true;
  void closeLocalServerForExit().finally(() => app.quit());
}

async function prepareLocalServerForUpdateInstall(): Promise<boolean> {
  if (isQuitting || !localServer) return false;
  desktopAgentBrokerRecoveryGate = "draining";
  if (!await agentUpdateDrain.prepareForUpdateInstall()) {
    desktopAgentBrokerRecoveryGate = "accepting";
    console.error("Nami Mail could not verify and drain the active Agent host for update.");
    return false;
  }
  const server = localServer;
  try {
    // Bound the close so a hung Fastify/SQLite shutdown cannot stall the
    // update installer indefinitely. The close is never raced against the
    // installer; a timeout only aborts this update attempt while the app
    // keeps running with its data intact.
    let closeTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        server.close(),
        new Promise((_, reject) => {
          closeTimeout = setTimeout(
            () => reject(new Error(`Desktop update close exceeded ${desktopUpdateCloseTimeoutMs} ms.`)),
            desktopUpdateCloseTimeoutMs,
          );
          closeTimeout.unref?.();
        }),
      ]);
    } finally {
      if (closeTimeout) clearTimeout(closeTimeout);
    }
    setDesktopAgentBroker(undefined);
    localServer = undefined;
    clearLocalApiAccessToken();
    destroyTray();
    isQuitting = true;
    desktopAgentBrokerRecoveryGate = "closed";
    return true;
  } catch (error) {
    if (agentUpdateDrain.hasDrainedHost()) await agentUpdateDrain.recoverAfterInstallerFailure();
    desktopAgentBrokerRecoveryGate = "closed";
    console.error("Nami Mail could not prepare its data for update", error);
    return false;
  }
}

function recoverAfterUpdateInstallFailure(): void {
  void (async () => {
    desktopAgentBrokerRecoveryGate = "closed";
    if (await agentUpdateDrain.recoverAfterInstallerFailure()) {
      desktopAgentBrokerRecoveryGate = "accepting";
      return;
    }
    // The service has already closed and its in-memory key has been cleared.
    // Relaunching is the smallest recovery that restores a fully usable app and
    // unwraps the DPAPI key again without retaining another plaintext key copy.
    app.relaunch();
    app.exit(0);
  })();
}

function quitForUpdateInstall(): void {
  desktopAgentBrokerRecoveryGate = "closed";
  if (!agentUpdateDrain.completeUpdateHandoff()) {
    console.error("Nami Mail could not record the Agent host update handoff.");
  }
  app.quit();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

let cachedSystemBrowser: string | null | undefined;

function resolveChromePath(): Promise<string | null> {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return Promise.resolve(candidate);
  }
  return new Promise((resolve) => {
    exec('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve', (error, stdout) => {
      if (error || !stdout) {
        resolve(null);
        return;
      }
      const match = /REG_SZ\s+(.+)\r?$/.exec(stdout.trim());
      resolve(match ? match[1]!.trim() : null);
    });
  });
}

/**
 * Opens external URLs in a real browser. On Windows the OAuth authorization
 * page is handed to Chrome when installed (matching the "log in with
 * Google" flow), falling back to the OS default browser otherwise.
 */
async function openInBrowser(url: string): Promise<void> {
  if (process.platform === "win32") {
    if (cachedSystemBrowser === undefined) cachedSystemBrowser = await resolveChromePath();
    if (cachedSystemBrowser !== null) {
      const child = nodeSpawn(cachedSystemBrowser, [url], { detached: true, stdio: "ignore" });
      child.unref();
      return;
    }
  }
  await shell.openExternal(url);
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

// --- Main-process notification sound playback ---
// The renderer's Web Audio API can only play when the window is focused and
// the AudioContext has been unlocked by a user gesture. New-mail notifications
// almost always arrive when the window is NOT focused, so the custom sound
// never plays and Windows falls back to its default. To fix this, we generate
// WAV files in the main process and play them via a system command, which
// works regardless of window focus or AudioContext state.

type ToneSpec = { freq: number; start: number; duration: number; volume: number };

const softTones: ToneSpec[] = [
  { freq: 659.25, start: 0.025, duration: 0.23, volume: 0.055 },
  { freq: 783.99, start: 0.145, duration: 0.34, volume: 0.042 },
];

const brightTones: ToneSpec[] = [
  { freq: 880, start: 0.025, duration: 0.14, volume: 0.06 },
  { freq: 1174.66, start: 0.125, duration: 0.18, volume: 0.052 },
  { freq: 1567.98, start: 0.245, duration: 0.28, volume: 0.04 },
];

/** Generates a 16-bit PCM mono WAV buffer for the given tone specification. */
function generateNotificationSoundWav(sound: "soft" | "bright"): Buffer {
  const sampleRate = 44100;
  const tones = sound === "soft" ? softTones : brightTones;
  const totalDuration = Math.max(...tones.map((t) => t.start + t.duration)) + 0.03;
  const totalSamples = Math.ceil(totalDuration * sampleRate);
  const dataSize = totalSamples * 2; // 16-bit mono

  const samples = new Float32Array(totalSamples);
  for (const tone of tones) {
    const startSample = Math.floor(tone.start * sampleRate);
    const durationSamples = Math.floor(tone.duration * sampleRate);
    const fadeSamples = Math.floor(0.015 * sampleRate);
    for (let i = 0; i < durationSamples; i++) {
      const idx = startSample + i;
      if (idx >= totalSamples) break;
      const t = i / sampleRate;
      // Exponential envelope: ramp up over 15ms, then ramp down to silence.
      let envelope: number;
      if (i < fadeSamples) {
        envelope = 0.0001 * Math.pow(tone.volume / 0.0001, i / fadeSamples);
      } else {
        const progress = (i - fadeSamples) / (durationSamples - fadeSamples);
        envelope = tone.volume * Math.pow(0.0001 / tone.volume, progress);
      }
      samples[idx] = (samples[idx] ?? 0) + Math.sin(2 * Math.PI * tone.freq * t) * envelope;
    }
  }

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < totalSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buffer;
}

const soundFilePathCache: Partial<Record<"soft" | "bright", string>> = {};

/** Lazily generates and caches the WAV file for the given sound. */
function getNotificationSoundFile(sound: "soft" | "bright"): string | undefined {
  const cached = soundFilePathCache[sound];
  if (cached) return cached;
  try {
    const filePath = path.join(tmpdir(), `nami-notification-${sound}.wav`);
    if (!existsSync(filePath)) {
      const wav = generateNotificationSoundWav(sound);
      writeFileSync(filePath, wav);
    }
    soundFilePathCache[sound] = filePath;
    return filePath;
  } catch {
    return undefined;
  }
}

/** Plays a notification sound from the main process using a system command. */
function playCustomNotificationSound(sound: "soft" | "bright"): void {
  const filePath = getNotificationSoundFile(sound);
  if (!filePath) return;
  // Escape single quotes for shell safety.
  const safePath = filePath.replace(/'/g, `'\\''`);
  let command: string;
  if (process.platform === "win32") {
    // PowerShell SoundPlayer.PlaySync blocks until the sound finishes, but
    // exec runs it in a child process so the main process is not blocked.
    command = `powershell -NoProfile -NonInteractive -Command "(New-Object Media.SoundPlayer '${safePath}').PlaySync()"`;
  } else if (process.platform === "darwin") {
    command = `afplay '${safePath}'`;
  } else {
    command = `aplay '${safePath}' 2>/dev/null || paplay '${safePath}' 2>/dev/null`;
  }
  exec(command, () => undefined);
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
        const settingsButton = document.querySelector('.icon-rail .icon-button');
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
  const { notificationSound } = settings;
  // Custom sounds (soft/bright) are now played from the main process via a
  // generated WAV file, which works regardless of window focus or AudioContext
  // state. The renderer no longer needs to play the custom sound.
  const useMainProcessCustomSound = shouldAlert && (notificationSound === "soft" || notificationSound === "bright");
  mainWindow?.webContents.send("nami:new-mail", {
    id: first.id,
    subject: first.subject,
    fromName: first.fromName,
    fromAddress: first.fromAddress,
    count: messages.length,
    shouldAlert,
    playCustomSound: false,
  });
  if (!shouldAlert) return;

  // Play the custom sound from the main process before showing the notification.
  // The native notification is silenced so only the custom sound is heard.
  if (useMainProcessCustomSound) {
    playCustomNotificationSound(notificationSound);
  }

  const locale = currentNativeLocale();
  const sender = first.fromName || first.fromAddress || nativeText(locale, "notificationUnknownSender");
  const title = messages.length === 1
    ? nativeText(locale, "notificationSingleTitle", { sender })
    : nativeText(locale, "notificationMultipleTitle", { count: messages.length });
  const body = messages.length === 1 ? first.subject : nativeText(locale, "notificationMultipleBody", { sender });
  // silent: true when "none" (no sound at all) or when the custom sound was
  // already played by the main process. Otherwise let the OS play its default.
  showNativeNotification({
    title,
    body,
    silent: notificationSound === "none" || useMainProcessCustomSound,
  }, () => {
    focusMainWindow();
    mainWindow?.webContents.send("nami:open-message", first.id);
  });
}

function notifyAutoReplyEvent(event: DesktopAutoReplyEvent): void {
  // The renderer drives the popup; there is no native notification here.
  mainWindow?.webContents.send("nami:auto-reply", event);
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
      // The smoke window is intentionally hidden. Keep its polling probes on
      // their normal timer cadence without changing production window behavior.
      backgroundThrottling: !isDesktopSmoke,
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
  mainWindow.webContents.on("console-message", (event) => {
    if (!smokeResultPath || !["warning", "error"].includes(event.level)) return;
    desktopSmokeDiagnostics.push(`Renderer ${event.level}: ${event.message}`);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void openInBrowser(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isLocalAppUrl(url)) return;
    event.preventDefault();
    if (isHttpUrl(url)) void openInBrowser(url);
  });
  mainWindow.once("ready-to-show", () => {
    if (!smokeExitDelay) mainWindow?.show();
  });
  mainWindow.on("close", handleMainWindowClose);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  const appUrl = new URL(localServer.url);
  appUrl.searchParams.set("desktop", "1");
  if (isDesktopSmoke) appUrl.searchParams.set("desktopSmoke", "1");
  // A cold start or a pre-window open-url hand-off queues one mailto compose.
  // did-finish-load fires after the renderer bundle ran, so the web app's
  // subscription is already registered by the time the event is sent.
  const coldMailtoUrl = pendingMailtoUrl ?? extractMailtoUrl(process.argv);
  pendingMailtoUrl = undefined;
  if (coldMailtoUrl) {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow?.webContents.send("nami:compose-new", coldMailtoUrl);
    });
  }
  await mainWindow.loadURL(appUrl.toString());
}

async function ensureMainWindowForAgentPairing(): Promise<BrowserWindow | undefined> {
  if (!mainWindow) {
    desktopHostMode = "gui";
    await createMainWindow();
    await startDesktopUpdaterIfNeeded();
  }
  focusMainWindow();
  return mainWindow;
}

async function recordPairingFailure(requestId: string): Promise<void> {
  await writePairingOutcome(app.getPath("userData"), { requestId, status: "failed" }).catch(() => undefined);
}

async function processAgentPairingRequest(requestId: string): Promise<void> {
  const request = await readPairingRequest(app.getPath("userData"), requestId);
  const broker = desktopAgentBroker;
  const server = localServer;
  if (!request || !broker || !server) {
    await recordPairingFailure(requestId);
    return;
  }
  if (Date.now() - Date.parse(request.requestedAt) > 5 * 60_000) {
    await recordPairingFailure(requestId);
    return;
  }
  const profileStore = new DesktopClientProfileStore(clientProfilesPath(app.getPath("userData")), safeStorage);
  const profile = await profileStore.read(request.profile).catch(() => undefined);
  if (!profile || profile.clientId !== request.clientId || profile.publicKeyPem !== request.clientPublicKeyPem) {
    await recordPairingFailure(requestId);
    return;
  }
  const window = await ensureMainWindowForAgentPairing();
  if (!window) {
    await recordPairingFailure(requestId);
    return;
  }
  const fingerprint = agentPairingFingerprint(request.clientPublicKeyPem);
  const accountIds = server.listExternalPairingAccountIds();
  if (request.operation === "pair" && accountIds.length === 0) {
    await dialog.showMessageBox(window, {
      type: "info",
      title: "NamiMail Agent",
      message: "Connect a mail account before approving external Agent access.",
      buttons: ["OK"],
    });
    await recordPairingFailure(requestId);
    return;
  }
  const isRevocation = request.operation === "revoke";
  const decision = await dialog.showMessageBox(window, {
    type: "question",
    title: "NamiMail Agent",
    message: isRevocation
      ? `Revoke external access for profile “${request.profile}”?`
      : `Allow external read-only access for profile “${request.profile}”?`,
    detail: isRevocation
      ? `Profile fingerprint: ${fingerprint}\n\nThe profile will no longer be able to read mail through NamiMail.`
      : [
        `Profile fingerprint: ${fingerprint}`,
        `Authorized account snapshot: ${accountIds.length} connected account${accountIds.length === 1 ? "" : "s"}.`,
        "The external interface can only list or read bounded mail data. It cannot send, move, delete, or change mail.",
      ].join("\n\n"),
    buttons: [isRevocation ? "Revoke access" : "Allow read-only access", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (decision.response !== 0) {
    await writePairingOutcome(app.getPath("userData"), { requestId, status: "rejected" });
    return;
  }
  try {
    if (isRevocation) {
      const revoked = await broker.revokeReadOnlyPairing(request.clientId);
      if (!revoked) throw new Error("Pairing record was not found.");
      await profileStore.remove(request.profile);
      const discovery = broker.getDiscovery();
      if (!discovery) throw new Error("Agent Broker is not available.");
      await writePairingOutcome(app.getPath("userData"), {
        requestId,
        status: "approved",
        hostId: discovery.hostId,
        hostPublicKeyPem: discovery.hostPublicKeyPem,
      });
      return;
    }
    const host = await broker.createReadOnlyPairing({
      clientId: request.clientId,
      clientPublicKeyPem: request.clientPublicKeyPem,
      accountIds,
    });
    await profileStore.completePairing(request.profile, {
      schemaVersion: 1,
      requestId,
      status: "approved",
      completedAt: new Date().toISOString(),
      hostId: host.hostId,
      hostPublicKeyPem: host.hostPublicKeyPem,
    });
    await writePairingOutcome(app.getPath("userData"), {
      requestId,
      status: "approved",
      hostId: host.hostId,
      hostPublicKeyPem: host.hostPublicKeyPem,
    });
  } catch {
    await recordPairingFailure(requestId);
  }
}

function scheduleAgentPairingRequests(requestIds: readonly string[]): void {
  for (const requestId of requestIds) {
    pairingRequestTail = pairingRequestTail
      .then(() => processAgentPairingRequest(requestId))
      .catch(() => recordPairingFailure(requestId));
  }
}

let pairingScopeDriftNotified = false;

/**
 * Pairings capture an account snapshot at approval time and are fail-closed:
 * accounts added later are invisible to the client until it is paired again.
 * The desktop surfaces that drift once per run so the user can re-pair.
 */
async function warnExternalPairingScopeDrift(): Promise<void> {
  const server = localServer;
  const broker = desktopAgentBroker;
  if (pairingScopeDriftNotified || !server || !broker) return;
  const [pairings, currentIds] = await Promise.all([
    broker.describePairings(),
    Promise.resolve(server.listExternalPairingAccountIds()),
  ]);
  const current = new Set(currentIds);
  const drifted = pairings.filter((pairing) => {
    if (pairing.revokedAt) return false;
    if (pairing.expiresAt && Date.parse(pairing.expiresAt) <= Date.now()) return false;
    if (pairing.accountIds.length !== current.size) return true;
    return pairing.accountIds.some((accountId) => !current.has(accountId));
  });
  if (drifted.length === 0) return;
  pairingScopeDriftNotified = true;
  const locale = currentNativeLocale();
  showNativeNotification({
    title: nativeText(locale, "externalAccessDriftTitle"),
    body: nativeText(locale, "externalAccessDriftBody", { count: drifted.length }),
    silent: true,
  }, () => {
    focusMainWindow();
  });
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

async function writeDesktopSmokeProgress(stage: string): Promise<void> {
  if (!isDesktopSmoke || !smokeProgressPath) return;
  try {
    await fs.mkdir(path.dirname(smokeProgressPath), { recursive: true });
    await fs.writeFile(smokeProgressPath, JSON.stringify({ stage, checkedAt: new Date().toISOString() }), "utf8");
  } catch {
    desktopSmokeDiagnostics.push("Desktop smoke progress could not be written.");
  }
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
  desktopAgentBrokerRecoveryGate = "accepting";
  await writeDesktopSmokeProgress("waiting-for-electron-ready");
  await app.whenReady();
  await writeDesktopSmokeProgress("electron-ready");
  appIcon = loadDesktopIcon();
  // Windows/Linux register the mailto protocol with the OS; macOS receives
  // open-url events instead (the packaged Info.plist declares the scheme).
  if (process.platform !== "darwin") {
    try {
      if (app.isPackaged) {
        app.setAsDefaultProtocolClient("mailto", process.execPath);
      } else {
        app.setAsDefaultProtocolClient("mailto", process.execPath, [path.resolve(app.getAppPath())]);
      }
    } catch {
      // Registration can fail in locked-down development shells; the window
      // still handles mailto arguments handed to a new instance.
    }
  }
  await loadDesktopLocalConfiguration();
  configureLocalService();
  await writeDesktopSmokeProgress("configuration-loaded");

  try {
    // The session exists only after `ready`. Clear historical HTTP and
    // Service Worker cache before creating or loading any renderer window.
    // This deliberately excludes cookies, auth cache, localStorage and IDB.
    rendererCacheCleanup = await clearLegacyRendererMailCache(session.defaultSession);
    await writeDesktopSmokeProgress("renderer-cache-cleared");
    const runtimePath = "../../server/dist/runtime.js";
    const runtime = await import(runtimePath) as ServerRuntimeModule;
    const dataDirectory = path.join(app.getPath("userData"), "data");
    const desktopMasterKey = await loadOrCreateDesktopMasterKey(dataDirectory, safeStorage);
    try {
      localServer = await runtime.startServer({
        masterKey: desktopMasterKey.key,
        onNewInboxMessages: notifyNewMail,
        onAutoReplyEvent: notifyAutoReplyEvent,
        desktopConfirmation: {
          capability: desktopConfirmationCapability,
          verifier: desktopConfirmationVerifier,
        },
        externalConfirmation: createExternalConfirmationBridge(),
        listExternalPairings: () => (desktopAgentBroker ? desktopAgentBroker.describePairings() : Promise.resolve([])),
      });
      await writeDesktopSmokeProgress("local-service-ready");
      applyDesktopSettingsFromServer();
    } finally {
      // startServer copies the key for its own lifetime. This copy exists only
      // to cross the Electron-to-runtime boundary and is no longer needed.
      desktopMasterKey.key.fill(0);
    }
    if (desktopHostMode === "gui") {
      // The external Agent interface is optional for the mail client. A Broker
      // failure (for example, Windows PowerShell 5.1 unavailable) must not
      // prevent the window or the local mail service from starting; pairing
      // and external CLI/MCP simply stay unavailable until the Broker is
      // healthy again.
      try {
        await startDesktopAgentBroker();
      } catch (error) {
        desktopSmokeDiagnostics.push(`Desktop Agent Broker unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      await startDesktopAgentBroker();
    }
    void warnExternalPairingScopeDrift().catch(() => undefined);
    if (desktopHostMode === "gui") {
      await createMainWindow();
      await writeDesktopSmokeProgress("window-loaded");
      scheduleAgentPairingRequests(initialPairingRequestIds);
      const desktopUpdate = await startDesktopUpdaterIfNeeded();
      if (smokeResultPath) await writeDesktopSmokeProgress("notification-probe");
      const desktopNotificationTest = smokeResultPath ? await waitForDesktopSmokeNotification() : undefined;
      const simulatedWebFrameVisible = !smokeResultPath
        ? undefined
        : !mainWindow
          ? true
          : await mainWindow.webContents.executeJavaScript("Boolean(document.querySelector('.window-bar'))").catch(() => true);
      await writeDesktopSmokeProgress("wallpaper-probe");
      const desktopWallpaper = smokeResultPath ? await inspectDesktopWallpaper() : undefined;
      await writeDesktopSmokeProgress("settings-ui-probe");
      const desktopSettingsUi = smokeResultPath ? await inspectDesktopSettingsUi() : undefined;
      await writeDesktopSmokeProgress("settings-sync-probe");
      const desktopSettingsSync = smokeResultPath ? await inspectDesktopSettingsSync() : undefined;
      await writeDesktopSmokeProgress("close-prompt-probe");
      const desktopClosePrompt = smokeResultPath ? await inspectDesktopClosePrompt() : undefined;
      const desktopLifecycle = smokeResultPath ? inspectDesktopLifecycle() : undefined;
      await writeDesktopSmokeProgress("local-api-probe");
      const desktopLocalApiSmoke = isDesktopSmoke ? await inspectDesktopLocalApiSmoke() : undefined;
      if (isDesktopSmoke) mainWindow?.minimize();
      await writeDesktopSmokeProgress("writing-result");
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
      await writeDesktopSmokeProgress("result-written");
    }
    if (smokeExitDelay) {
      const timer = setTimeout(() => app.quit(), smokeExitDelay);
      timer.unref();
    }
  } catch (error) {
    desktopAgentBrokerRecoveryGate = "closed";
    const locale = currentNativeLocale();
    console.error("Nami Mail startup failed", error);
    await writeDesktopSmokeProgress("startup-failed");
    await writeSmokeResult({ error: error instanceof Error ? error.message : "Local service startup failed." }).catch(() => undefined);
    await closeDesktopAgentBroker().catch(() => undefined);
    await localServer?.close().catch(() => undefined);
    localServer = undefined;
    clearLocalApiAccessToken();
    dialog.showErrorBox(
      nativeText(locale, "startupFailureTitle"),
      error instanceof Error ? error.message : nativeText(locale, "startupFailureMessage"),
    );
    app.exit(1);
  }
}

if (desktopCliArguments !== undefined) {
  void app.whenReady()
    .then(() => runDesktopCli({
      argv: desktopCliArguments,
      version: app.getVersion(),
      userDataPath: app.getPath("userData"),
      safeStorage,
      input: createReadStream("", { fd: 0 }),
      output: process.stdout,
      error: process.stderr,
      launchNamiMail,
    }))
    .then((exitCode) => app.exit(exitCode))
    .catch((error) => {
      const message = error instanceof Error ? error.message : "NamiMail CLI could not start.";
      process.stderr.write(`HOST_UNAVAILABLE: ${message}\n`);
      app.exit(3);
    });
} else if (desktopAgentLaunch.kind === "rejected") {
  console.error(`NamiMail Agent startup failed [${desktopAgentLaunch.error.code}]: ${desktopAgentLaunch.error.message}`);
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  ipcMain.on("nami:quit", (event) => {
    if (!isCurrentRenderer(event)) return;
    app.quit();
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
  ipcMain.handle("nami:show-item-in-folder", (event, filePath: unknown) => {
    if (!isCurrentRenderer(event)) return;
    if (typeof filePath !== "string" || !filePath.trim()) return;
    try {
      shell.showItemInFolder(filePath);
    } catch (error) {
      console.warn("Nami Mail could not show item in folder", error);
    }
  });
  ipcMain.on("nami:set-unread-badge", (event, count: unknown) => {
    if (!isCurrentRenderer(event)) return;
    applyUnreadBadge(typeof count === "number" ? count : 0);
  });
  ipcMain.on("nami:set-launch-at-startup", (event, enabled: unknown) => {
    if (!isCurrentRenderer(event) || typeof enabled !== "boolean") return;
    applyLaunchAtStartup(enabled);
  });
  ipcMain.on("nami:set-global-shortcut", (event, enabled: unknown) => {
    if (!isCurrentRenderer(event) || typeof enabled !== "boolean") return;
    applyGlobalShortcut(enabled);
  });
  ipcMain.handle(agentConfirmationIpcChannel, createAgentConfirmationIpcHandler({
    getMainWindow: () => mainWindow,
    isLocalAppUrl,
    resolve: (confirmationId, decision) => {
      const server = localServer;
      return server?.resolveAgentConfirmation?.(confirmationId, decision);
    },
  }));
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
    const mailtoUrl = extractMailtoUrl(commandLine);
    if (mailtoUrl) {
      desktopHostMode = "gui";
      void (async () => {
        if (!mainWindow && localServer) {
          await createMainWindow();
          await startDesktopUpdaterIfNeeded();
        }
        focusMainWindow();
        mainWindow?.webContents.send("nami:compose-new", mailtoUrl);
      })();
      return;
    }
    const pairingRequests = readAgentPairingRequestIds(commandLine);
    if (pairingRequests.length) {
      desktopHostMode = "gui";
      void ensureMainWindowForAgentPairing().then(() => scheduleAgentPairingRequests(pairingRequests));
      return;
    }
    if (commandLine.includes("--agent-host")) {
      void (async () => {
        try {
          if (!localServer) await desktopBootPromise;
          await startDesktopAgentBroker();
        } catch (error) {
          console.error("Nami Mail could not restore the Agent Broker for the requested service host.", error);
        }
      })();
      return;
    }
    desktopHostMode = "gui";
    void (async () => {
      if (!mainWindow && localServer) {
        await createMainWindow();
        await startDesktopUpdaterIfNeeded();
      }
      focusMainWindow();
    })();
  });
  app.on("window-all-closed", () => {
    if (desktopHostMode === "gui") app.quit();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const mailtoUrl = extractMailtoUrl([url]);
    if (!mailtoUrl) return;
    if (mainWindow) {
      focusMainWindow();
      mainWindow.webContents.send("nami:compose-new", mailtoUrl);
    } else {
      // macOS can deliver open-url before `ready`; createMainWindow drains it.
      pendingMailtoUrl = mailtoUrl;
    }
  });
  app.on("before-quit", (event) => {
    desktopAgentBrokerRecoveryGate = "closed";
    if (!localServer || isQuitting) return;
    event.preventDefault();
    shutdownLocalServerAndQuit();
  });
  app.on("will-quit", () => {
    desktopAgentBrokerRecoveryGate = "closed";
    globalShortcut.unregisterAll();
    powerMonitor.removeListener("resume", checkForUpdatesAfterExternalTrigger);
    desktopUpdater?.dispose();
  });
  desktopBootPromise = boot();
}
