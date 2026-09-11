import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, safeStorage, session, shell, Tray, type NativeImage } from "electron";
import { parse as parseDotenv } from "dotenv";
import { createHash, randomBytes } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopLocalConfigurationFiles } from "./local-configuration.mjs";
import { minimalSpawnEnvironment } from "./spawn-environment.mjs";
import {
  clearLegacyRendererMailCache,
  isLocalApiRequestUrl,
  localApiNoStoreRequestHeaders,
  localApiNoStoreResponseHeaders,
  rendererCacheClearRequired,
  skippedRendererCacheCleanup,
  type RendererCacheCleanupResult,
} from "./renderer-cache-policy.mjs";
import { nativeText, type NativeCopyKey, type NativeTranslationValues } from "./native-localization.mjs";
import {
  applyGlobalShortcut as applyGlobalShortcutPolicy,
  applyLaunchAtStartup as applyLaunchAtStartupPolicy,
  applyTrayBadge as applyTrayBadgePolicy,
  buildTrayMenuTemplate,
  extractMailtoUrl,
  FOCUS_GLOBAL_SHORTCUT_ACCELERATOR,
  nextTrayBadge,
  type GlobalShortcutApi,
  type LaunchAtStartupApi,
  type TrayBadgeEvent,
  type TrayIconApi,
  type TrayMenuAction,
} from "./desktop-behaviors.mjs";
import { loadOrCreateDesktopMasterKey } from "./secure-master-key.mjs";
import { DesktopDiagnostics, formatConsoleArgs, serializeRuntimeError } from "./desktop-diagnostics.mjs";
import { openInBrowser as openExternalUrl, isHttpUrl } from "./desktop-external-open.mjs";
import { playCustomNotificationSound } from "./desktop-notification-sound.mjs";
import {
  getClosePromptSmokeSession,
  getDesktopSmokeDiagnostics,
  getSingleInstanceSmokeResult,
  initializeDesktopSmoke,
  inspectDesktopClosePrompt,
  inspectDesktopChipOverlapSweep,
  inspectDesktopDeepDiagnostic,
  inspectDesktopLifecycle,
  inspectDesktopLocalApiSmoke,
  inspectDesktopSettingsSync,
  inspectDesktopSettingsUi,
  inspectDesktopWallpaper,
  noteDesktopSmokeDiagnostic,
  recordSingleInstanceSmokeActivation,
  waitForDesktopSmokeNotification,
  writeDesktopSmokeProgress,
  writeSmokeResult,
  type CloseBehavior,
  type ClosePromptDialogResult,
} from "./desktop-smoke.mjs";
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
} from "./agent/confirmation-ipc.mjs";
import {
  createServerBridgeClient,
  type ServerBridgeHandle,
  type ServerStartParams,
} from "./server-bridge.mjs";
import { forkServerProcess, type ServerProcessHandle } from "./server-process.mjs";

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

/** Payload the service sends back over the bridge for a confirmation request. */
type ExternalConfirmationInput = Parameters<ExternalConfirmationRuntimeOptions["request"]>[0];

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

let mainWindow: BrowserWindow | undefined;
let localServer: ServerBridgeHandle | undefined;
// The local mail service runs in an Electron utility process: SQLite's
// synchronous native calls, IMAP round-trips, payload decryption and the Agent
// loop no longer share the event loop that paints the window (measured before
// the split: 258-426ms of main-thread work per list request, 16s flag batches).
let serverProcess: ServerProcessHandle | undefined;
// Set before an intentional kill so the exit hook does not report a healthy
// shutdown as a crash.
let serverProcessExpectedExit = false;
// The desktop confirmation capability is minted *inside* the service process
// (see server-host.mts): a Symbol cannot cross the structured-clone boundary,
// and it only ever needs to distinguish the service's own UI call path from a
// web caller — a property that is local to the process by definition.

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
// Reliable mirror of the main window's real on-screen visibility. We avoid
// trusting `BrowserWindow.isVisible()` for the tray menu because its return
// value is unreliable across some Windows/Electron combinations; instead we
// maintain the flag at the exact points the window is shown or hidden.
let mainWindowVisible = false;
let isQuitting = false;
let shutdownPromise: Promise<void> | undefined;
let closePromptPending = false;
let localApiAccessToken: string | undefined;
let desktopUpdater: DesktopUpdater | undefined;
let rendererCacheCleanup: RendererCacheCleanupResult | undefined;
let localApiCachePolicyInstalled = false;
/** A mailto URL received (macOS open-url) before the window existed. */
let pendingMailtoUrl: string | undefined;
const appUserModelId = app.isPackaged ? "com.nami.mail" : "com.nami.mail.dev";
const localApiAccessHeader = "x-nami-api-token";
// Desktop-only behaviors (tray badge, login item, global shortcut) live in
// desktop-behaviors.mjs; the platform-specific Electron wiring is applied
// through adapters here so the policy layer stays unit-testable.
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
        env: minimalSpawnEnvironment(),
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
// Probe code ships inside the asar (there is no bundler to shake it out), so
// the activation gate must stay narrow: both the unpackaged smoke harness and
// the release pipeline's installer smoke set NAMI_MAIL_SMOKE plus a dedicated
// result path, and the probes only ever read from that path.
// The gate must stay env-scoped: the release pipeline's installer smoke
// (scripts/smoke-package.mjs) legitimately runs the *installed* app, where
// app.isPackaged is true — an `!app.isPackaged` hardening broke it.
const isDesktopSmoke = process.env.NAMI_MAIL_SMOKE === "1" && Boolean(smokeResultPath);
initializeDesktopSmoke({
  smokeResultPath,
  smokeProgressPath,
  isDesktopSmoke,
  appUserModelId,
  getMainWindow: () => mainWindow,
  getLocalServer: () => localServer,
  getTray: () => tray,
  getAppIcon: () => appIcon,
  loadAppIcon: loadDesktopIcon,
  focusMainWindow,
  ensureTray,
  destroyTray,
  requestMainWindowClose,
  rememberCloseBehavior,
  redact: (message) => (localApiAccessToken ? message.replaceAll(localApiAccessToken, "[redacted]") : message),
});
const desktopLoopbackPort = "0";
const desktopShutdownTimeoutMs = 2_000;
const desktopUpdateCloseTimeoutMs = 30_000;
// Startup/shutdown timing and crash logging live in desktop-diagnostics.mts.
// Every write there is bounded and best-effort: the smoke harness runs with an
// isolated data directory and cannot reveal where a real launch spends its
// time, and a field failure must leave evidence without ever breaking boot.
const desktopDiagnostics = new DesktopDiagnostics();
let desktopDiagnosticsInstalled = false;

/**
 * Crash and log capture for the packaged app. Installed once per boot; console
 * output is mirrored because that is how the in-process service reports errors.
 */
function installDesktopRuntimeDiagnostics(): void {
  if (desktopDiagnosticsInstalled) return;
  desktopDiagnosticsInstalled = true;

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    desktopDiagnostics.appendRuntimeLog("console.error", { message: formatConsoleArgs(args) });
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    desktopDiagnostics.appendRuntimeLog("console.warn", { message: formatConsoleArgs(args) });
    originalWarn(...args);
  };

  process.on("uncaughtException", (error) => {
    desktopDiagnostics.appendRuntimeLog("uncaught-exception", serializeRuntimeError(error));
    originalError("Uncaught exception:", error);
    // Process state is unknown after an uncaught exception: stop deliberately
    // rather than keep syncing and sending mail from a half-built runtime.
    try {
      dialog.showErrorBox(
        "Nami Mail stopped unexpectedly",
        "Nami Mail hit an unrecoverable error and will close. Details were written to runtime-log.jsonl in the Nami Mail user data folder.",
      );
    } catch {
      // A dialog must never block shutdown.
    }
    app.quit();
  });

  process.on("unhandledRejection", (reason) => {
    desktopDiagnostics.appendRuntimeLog("unhandled-rejection", serializeRuntimeError(reason));
  });

  app.on("render-process-gone", (_event, _contents, details) => {
    desktopDiagnostics.appendRuntimeLog("render-process-gone", { reason: details.reason, exitCode: details.exitCode });
  });

  app.on("child-process-gone", (_event, details) => {
    desktopDiagnostics.appendRuntimeLog("child-process-gone", {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
}
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

// Persists the app version whose renderer cache was last cleared so a version
// bump still triggers the one-time stale-cache purge while identical launches
// skip it entirely. Both helpers are best-effort: a missing/corrupt marker just
// re-enables the clear once for that boot.
function readRendererCacheClearedVersion(filePath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

function writeRendererCacheClearedVersion(filePath: string, version: string): void {
  try {
    writeFileSync(filePath, JSON.stringify({ version }), "utf8");
  } catch {
    // A failed persist only re-clears the cache once on the next launch.
  }
}

function configureLocalService(): void {
  const dataDirectory = path.join(app.getPath("userData"), "data");
  // This is a process-only capability. It is never written to userData,
  // appended to the renderer URL, or placed in process.env (child processes
  // run with a filtered environment and must not inherit it), and it is
  // regenerated on every launch.
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
}

function clearLocalApiAccessToken(): void {
  localApiAccessToken = undefined;
}

function applyTrayBadge(event: TrayBadgeEvent): void {
  try {
    applyTrayBadgePolicy(trayIconApi, nextTrayBadge(event));
  } catch (error) {
    // Tray icon APIs vary by desktop session; a failure must not take the
    // mail client down with it.
    console.warn("Nami Mail could not update its tray icon", error);
  }
}

function setTrayIcon(icon: NativeImage | undefined): void {
  if (!tray || tray.isDestroyed() || !icon) return;
  tray.setImage(icon);
}

let trayBadgeIcon: NativeImage | undefined;

function loadTrayBadgeIcon(): NativeImage | undefined {
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
}

const trayIconApi: TrayIconApi = {
  setBadgeIcon: () => setTrayIcon(loadTrayBadgeIcon()),
  setPlainIcon: () => setTrayIcon(appIcon ?? loadDesktopIcon()),
};

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
  mainWindowVisible = true;
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
  // Use the maintained visibility flag (see mainWindowVisible) rather than
  // `BrowserWindow.isVisible()`, which is unreliable here. The label describes
  // the action that will run on click: when the window is actually visible we
  // show "hide to tray", otherwise "show Nami Mail".
  const template = buildTrayMenuTemplate(
    {
      hide: nativeCopy("trayHide"),
      show: nativeCopy("trayShow"),
      newMail: nativeCopy("trayNewMail"),
      inbox: nativeCopy("trayInbox"),
      quit: nativeCopy("trayQuit"),
    },
    mainWindowVisible,
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
      // focusMainWindow), so the visibility label stays accurate. Driven by the
      // maintained mainWindowVisible flag rather than `isVisible()`.
      if (mainWindowVisible) hideMainWindowToTray();
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
    mainWindowVisible = false;
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
  await localServer.updateSettings({ closeBehavior });
  mainWindow?.webContents.send("nami:settings-changed");
}

async function showClosePrompt(
  targetWindow: BrowserWindow,
  options: Electron.MessageBoxOptions,
): Promise<ClosePromptDialogResult> {
  // The desktop smoke exercises the real close handler but cannot leave a
  // native modal open or terminate its own Electron process midway through.
  const smokeSession = getClosePromptSmokeSession();
  if (smokeResultPath && smokeSession) {
    smokeSession.simulatedNativeDialogCalls += 1;
    return smokeSession.result;
  }
  return dialog.showMessageBox(targetWindow, options);
}

function quitFromClosePrompt(): void {
  const smokeSession = getClosePromptSmokeSession();
  if (smokeResultPath && smokeSession) {
    smokeSession.quitRequested = true;
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

/**
 * Terminates the local-service utility process. Called after a graceful
 * `close()` round-trip, and unconditionally on the teardown/update paths so a
 * service that failed to answer can never outlive the window.
 */
function stopLocalServerProcess(): void {
  serverProcessExpectedExit = true;
  serverProcess?.kill();
  serverProcess = undefined;
}

function closeLocalServerForExit(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  const server = localServer;
  shutdownPromise = (async () => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      // Broker and server shutdown run in parallel, both bounded by the same
      // overall budget: a hung agent request or a stuck server.close() must
      // never keep the process from exiting.
      const brokerClosed = closeDesktopAgentBroker().catch((error) => {
        console.error("Nami Mail Agent Broker shutdown failed", error);
      });
      const serverClosed = server ? server.close() : undefined;
      await Promise.race([
        Promise.all([brokerClosed, serverClosed]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Desktop shutdown exceeded ${desktopShutdownTimeoutMs} ms.`)), desktopShutdownTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } catch (error) {
      console.error("Nami Mail shutdown failed", error);
    } finally {
      if (timeout) clearTimeout(timeout);
      localServer = undefined;
      stopLocalServerProcess();
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
  // Close the window before tearing the local service down. The renderer
  // keeps a long-lived SSE stream open to /api/events and fastify.close()
  // waits for open connections, so leaving the window alive would stall the
  // teardown until the shutdown budget expires. Destroying it (destroy()
  // bypasses the close handler that routes back into this path) also makes
  // the window disappear immediately instead of freezing during teardown.
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
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
    stopLocalServerProcess();
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

/** Opens external URLs through the shared opener, which prefers Chrome on Windows. */
function openInBrowser(url: string): Promise<void> {
  return openExternalUrl(url, { openExternal: (target) => shell.openExternal(target) });
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

// The renderer is a trusted local UI, but an unhandled permission request
// defaults to granted in Electron. Deny everything outside this short
// allowlist so compromised or misbehaving content cannot reach cameras,
// microphones, geolocation or other device surfaces through the session.
// clipboard-sanitized-write backs the "copy" affordances in the UI;
// notifications lets the web-side notification path request permission, while
// the mail client itself uses the native main-process Notification API.
const rendererPermissionAllowlist = new Set(["clipboard-sanitized-write", "notifications"]);

function installRendererPermissionPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(rendererPermissionAllowlist.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return rendererPermissionAllowlist.has(permission);
  });
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

function notifyNewMail(messages: NewMailPayload[]): void {
  const settings = localServer?.getSettings();
  if (!settings) return;
  const first = messages[0];
  if (!first) return;
  // The tray dot marks "new mail while away" independently of the alert
  // settings: it lights only when the window is not focused and clears as
  // soon as the window is focused again.
  applyTrayBadge({ type: "new-mail", windowFocused: mainWindow?.isFocused() ?? false });
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

// Resolved by the shell's ready-to-show so boot can yield to the renderer
// before the service's synchronous startup work claims the main thread.
let resolveSplashPresented: (() => void) | undefined;

// Waits for the native splash to actually reach the screen (ready-to-show),
// bounded by budgetMs: frame presentation is scheduled by the main process,
// so once the service's migrations and agent construction hog the main
// thread, a not-yet-presented splash stays a blank surface for seconds
// (measured ~3s on a real profile). The bounded wait keeps a degraded launch
// from stalling when the signal never arrives.
function waitForSplashPresentation(budgetMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveSplashPresented = undefined;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(settle, budgetMs);
    timer.unref?.();
    resolveSplashPresented = settle;
  });
}

// The web app's inline splash (apps/web/index.html) paints #ececef in light
// mode and #1a1a1e in dark mode; the native splash mirrors that surface, the
// logo/wordmark row and the dark variants, so navigating from the native
// splash to the app URL never flashes a different frame.
function nativeSplashUrl(): string {
  const dark = nativeTheme.shouldUseDarkColors;
  const surfaceColor = dark ? "#1a1a1e" : "#ececef";
  const wordmarkColor = dark ? "#e8e8ec" : "#2b2b30";
  const dividerColor = dark ? "rgba(200,200,210,.2)" : "rgba(128,128,128,.25)";
  let logoBase64 = "";
  try {
    // The splash logo ships inside the packaged web dist (the local service
    // serves it from there), so one relative path resolves in dev and in the
    // packaged asar alike: <app>/apps/desktop/dist -> <app>/apps/web/dist.
    const logo = readFileSync(path.join(import.meta.dirname, "../../web/dist/splash-logo.png"));
    logoBase64 = logo.toString("base64");
  } catch {
    // A missing logo still leaves a faithful wordmark splash.
  }
  const image = logoBase64 ? `<img class="logo" src="data:image/png;base64,${logoBase64}" alt=""/>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"/><style>
html,body{margin:0;height:100%}
body{display:flex;align-items:center;justify-content:center;background:${surfaceColor}}
.content{display:flex;align-items:center;justify-content:center}
.logo{width:64px;height:64px}
.divider{width:1px;height:30px;margin-left:14px;background:${dividerColor}}
.wordmark{margin-left:14px;font-family:"Segoe UI Variable","Segoe UI",system-ui,sans-serif;font-size:25px;font-weight:400;letter-spacing:.3px;color:${wordmarkColor}}
</style></head><body><div class="content">${image}<span class="divider"></span><span class="wordmark">Nami Mail</span></div></body></html>`;
  return `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

// Creates the window and shows the native splash immediately. This runs before
// the local service exists so the launch paints the app surface in well under
// a second instead of staying dark for the whole server boot;
// `loadMainWindowApp` navigates to the real app once the service is up.
async function createMainWindowShell(): Promise<void> {
  desktopDiagnostics.appendStartupLog("main-window-create-start", desktopDiagnostics.elapsedMs, "main");

  // Windows/Linux draw their own window bar (the web app's WindowBar with
  // minimize/maximize/close buttons), so the OS frame is dropped. macOS keeps
  // the native traffic lights behind a hidden title bar; the renderer reserves
  // a leading slot for them and draws no controls.
  const frameless = process.platform !== "darwin";
  // The renderer's splash overlay (apps/web/index.html) paints #ececef in
  // light mode and #1a1a1e in dark mode. Matching the native window surface
  // to that exact color prevents a white/black flash between the OS frame
  // paint and the splash's first render, which is what users see as a flicker
  // right as the window appears.
  const splashSurfaceColor = nativeTheme.shouldUseDarkColors ? "#1a1a1e" : "#ececef";
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    // The minimum size tracks the desktop layout, not the OS frame: below
    // 820px the web app switches to the drawer-style responsive layout, so
    // 840 keeps the three-pane mail view (sidebar + list + rail) reachable
    // at all times; 520 leaves room for a usable message list (header row
    // plus roughly six rows) with the rail and status strip.
    minWidth: 840,
    minHeight: 520,
    show: false,
    title: "Nami Mail",
    icon: appIcon,
    backgroundColor: splashSurfaceColor,
    autoHideMenuBar: true,
    ...(frameless
      ? { frame: false }
      : { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 12, y: 12 } }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(import.meta.dirname, "preload.cjs"),
      // Never throttle the renderer when the window loses focus. With
      // Chromium's default background throttling the SSE event handlers (and
      // the poll fallback) queue up while the window is hidden and then flood
      // the main thread the instant focus returns, producing a visible
      // multi-second freeze. A mail client has to stay responsive in the
      // background anyway, so keep timers and rAF on their normal cadence.
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  // Show the shell immediately: the window surface is the splash color, so
  // the first thing the user sees is the splash surface instead of a
  // multi-second void. Gating the show on ready-to-show is wrong on real
  // profiles — the local service's synchronous migrations and agent
  // construction hold the main-process event loop for seconds, delaying the
  // show IPC long after the renderer painted the splash (measured 5.9s vs
  // 0.5s on a cold real profile). The renderer paints and updates the visible
  // window independently of the busy main process.
  if (!smokeExitDelay) {
    mainWindow.show();
    mainWindowVisible = true;
  }
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    if (!smokeResultPath) return;
    noteDesktopSmokeDiagnostic(`Preload ${preloadPath}: ${error.message}`);
  });
  mainWindow.webContents.on("console-message", (event) => {
    // Renderer startup instrumentation: the web app logs "[nami-startup] <stage>"
    // markers at its key milestones (React mounted, first data load done, splash
    // dismissed). Forward them into the same startup log so a slow renderer boot
    // can be dissected alongside the main/server stages. Renderer content is
    // untrusted for sizing: cap a single line so one huge console message
    // cannot bloat the file and stall the next boot's synchronous prune.
    if (typeof event.message === "string" && event.message.startsWith("[nami-startup]")) {
      const stage = event.message.slice("[nami-startup]".length).trim().slice(0, 512);
      desktopDiagnostics.appendStartupLog(stage, desktopDiagnostics.elapsedMs, "renderer");
    }
    if (typeof event.message === "string" && event.message.startsWith("[nami-perf]")) {
      // Renderer perf telemetry (slow spans / api calls / commits / long
      // tasks) lands in the runtime log so a janky session can be dissected
      // after the fact instead of being observed only in a live console.
      desktopDiagnostics.appendRuntimeLog("renderer-perf", { message: event.message.slice(0, 512) });
    }
    if (!smokeResultPath || !["warning", "error"].includes(event.level)) return;
    noteDesktopSmokeDiagnostic(`Renderer ${event.level}: ${event.message}`);
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
    // Purely diagnostic since the shell shows itself at creation: the
    // renderer's first splash paint, however late the busy main process
    // delivers the event. Also releases boot's presentation wait.
    desktopDiagnostics.appendStartupLog("window-splash-ready-to-show", desktopDiagnostics.elapsedMs, "main");
    desktopDiagnostics.recordStartupTiming("window-splash-visible");
    resolveSplashPresented?.();
  });
  mainWindow.on("close", handleMainWindowClose);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  // The frameless window has no OS caption buttons, so the renderer tracks the
  // maximize state itself to swap the maximize/restore glyphs.
  mainWindow.on("maximize", () => mainWindow?.webContents.send("nami:window-maximized-changed", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("nami:window-maximized-changed", false));
  // Focusing the window clears the tray "new mail" dot; every restore path
  // (notification click, tray click, global shortcut) ends in focusMainWindow,
  // which shows and focuses the window and thus fires this event.
  mainWindow.on("focus", () => applyTrayBadge({ type: "window-focused" }));
  await mainWindow.loadURL(nativeSplashUrl());
}

// Navigates the existing window shell from the native splash to the app URL
// once the local service is listening. The splash phase consumed the first
// ready-to-show (the window is already visible by then), so the real app's
// first paint is recorded at did-finish-load here.
async function loadMainWindowApp(): Promise<void> {
  if (!mainWindow) throw new Error("Nami Mail window shell was not created.");
  if (!localServer) throw new Error("Nami Mail local service was not started.");
  // CSS image loads do not pass through the renderer's fetch wrapper. The
  // session-level injection covers those API resources without ever placing
  // the capability in a URL. It needs the listening server's origin and the
  // per-launch token, so it installs here rather than at shell creation.
  installLocalApiHeaderInjection(mainWindow);
  const appUrl = new URL(localServer.url);
  desktopDiagnostics.appendStartupLog("main-window-loadurl-start", desktopDiagnostics.elapsedMs, "main");
  appUrl.searchParams.set("desktop", "1");
  // The renderer needs the host platform to pick the window-bar layout: the
  // macOS native traffic lights leave a leading slot, other platforms draw
  // their own maximize/restore/close buttons.
  appUrl.searchParams.set("platform", process.platform);
  if (isDesktopSmoke) {
    appUrl.searchParams.set("desktopSmoke", "1");
    // Demo mode fills the mail list with real message rows so the smoke can
    // measure scroll/layout cost on the actual list instead of an empty one.
    appUrl.searchParams.set("demo", "1");
  }
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
  // did-finish-load fires after the renderer bundle ran and the app mounted;
  // it precedes the splash dismissal (which waits for the first data load).
  // The listener must be attached before loadURL: the load event and
  // did-finish-load are the same navigation milestone, so a late once()
  // would miss it.
  mainWindow.webContents.once("did-finish-load", () => {
    desktopDiagnostics.recordStartupTiming("window-did-finish-load");
    desktopDiagnostics.recordStartupTiming("window-first-paint");
  });
  await mainWindow.loadURL(appUrl.toString());
}

// Pairing flows can bring the window up on demand after the service is
// already running: shell first, then straight into the app.
async function createMainWindow(): Promise<void> {
  if (!localServer) throw new Error("Nami Mail local service was not started.");
  await createMainWindowShell();
  await loadMainWindowApp();
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
  const accountIds = await server.listExternalPairingAccountIds();
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
    server.listExternalPairingAccountIds(),
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

// The renderer keeps a splash overlay up until its animation, the first mail
// load, and the agent bootstrap preload all finish. Polling for the overlay's
// "done" class (or removal) gives the real "app is usable" timestamp. The poll
// runs only during startup and stops once the overlay is gone (or after 20s).
function observeSplashDismissal(): void {
  const timer = setInterval(() => {
    const target = mainWindow;
    if (!target || target.isDestroyed() || desktopDiagnostics.elapsedMs > 20_000) {
      clearInterval(timer);
      return;
    }
    void target.webContents
      .executeJavaScript("(() => { const el = document.getElementById('nami-splash'); return el === null || el.classList.contains('done'); })()")
      .then((dismissed) => {
        if (!dismissed) return;
        clearInterval(timer);
        desktopDiagnostics.recordStartupTiming("splash-dismissed");
      })
      .catch(() => undefined);
  }, 500);
}

/** Absolute path to the compiled utility-process entry shipped next to main. */
function serverHostModulePath(): string {
  return fileURLToPath(new URL("./server-host.mjs", import.meta.url));
}

/**
 * Forwards the service's pino output into the bounded runtime log. A packaged
 * install has no console attached, so without this the child's logs — the only
 * place sync, IMAP and Agent failures surface — would be lost.
 */
function forwardServerProcessOutput(stream: "stdout" | "stderr", chunk: string): void {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    desktopDiagnostics.appendRuntimeLog("server-process-output", { stream, message: trimmed });
  }
}

/**
 * Boots the local mail service in its own utility process and returns the
 * bridge handle main talks to. Call sites keep the shape they had when the
 * service ran in-process; only settings reads are served from a snapshot the
 * service pushes, because native menus and dialogs are synchronous.
 */
async function startLocalServiceInUtilityProcess(options: {
  dataDirectory: string;
  masterKey: Buffer;
}): Promise<ServerBridgeHandle> {
  const forked = forkServerProcess({
    modulePath: serverHostModulePath(),
    env: { WEB_DIST_PATH: path.join(app.getAppPath(), "apps", "web", "dist") },
    onOutput: forwardServerProcessOutput,
    onExit: (code) => {
      if (!serverProcessExpectedExit) {
        desktopDiagnostics.appendRuntimeLog("server-process-exited", { code });
      }
    },
  });
  serverProcess = forked;
  serverProcessExpectedExit = false;

  const bridge = createServerBridgeClient(forked.transport, {
    onNewInboxMessages: notifyNewMail,
    onAutoReplyEvent: (event) => notifyAutoReplyEvent(event as DesktopAutoReplyEvent),
    onStartupTiming: (stage, elapsedMs) => {
      desktopDiagnostics.appendStartupLog(stage, elapsedMs, "server");
      desktopDiagnostics.recordStartupTiming(stage, elapsedMs);
    },
    // The service persisted settings (settings page or Agent tool); re-apply
    // the desktop-only bits that main owns.
    onSettingsChanged: () => applyDesktopSettingsFromServer(),
    listExternalPairings: () => (desktopAgentBroker ? desktopAgentBroker.describePairings() : Promise.resolve([])),
    requestExternalConfirmation: (input) => createExternalConfirmationBridge().request(input as ExternalConfirmationInput),
  });

  const startParams: ServerStartParams = {
    host: "127.0.0.1",
    port: desktopLoopbackPort,
    databasePath: path.join(options.dataDirectory, "nami-mail.db"),
    masterKey: new Uint8Array(options.masterKey),
    localApiAccessToken,
    userDataPath: app.getPath("userData"),
    env: {},
  };
  try {
    await bridge.start(startParams);
  } catch (error) {
    // A service that failed to start must not linger as an orphan process.
    stopLocalServerProcess();
    throw error;
  }
  return bridge.handle;
}

async function boot(): Promise<void> {
  desktopAgentBrokerRecoveryGate = "accepting";
  desktopDiagnostics.initialize(app.getPath("userData"));
  installDesktopRuntimeDiagnostics();
  desktopDiagnostics.recordStartupTiming("boot-start");
  await writeDesktopSmokeProgress("waiting-for-electron-ready");
  await app.whenReady();
  desktopDiagnostics.recordStartupTiming("electron-ready");
  installRendererPermissionPolicy();
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
  // Prune once the configuration is final so a kill switch from nami-mail.env
  // is honored for this same launch; earlier appends (boot-start, at most a
  // couple of lines) are trimmed here when appending stays enabled.
  desktopDiagnostics.pruneStartupLog();
  desktopDiagnostics.recordStartupTiming("configuration-loaded");
  await writeDesktopSmokeProgress("configuration-loaded");

  // The window shell with the native splash needs no local service: create it
  // before the service boot so the launch shows the app surface immediately
  // instead of a dark desktop for the whole server start.
  if (desktopHostMode === "gui") {
    await createMainWindowShell();
    // Yield to the renderer so the splash is actually on screen before the
    // service's synchronous startup claims the main thread (see
    // waitForSplashPresentation).
    await waitForSplashPresentation(1200);
    await writeDesktopSmokeProgress("window-splash-visible");
  }

  try {
    // The session exists only after `ready`. Clear historical HTTP and
    // Service Worker cache before creating or loading any renderer window only
    // when the app version changed since the last cleared run. On an identical
    // version there is no new code to serve stale and the local API is already
    // no-store, so every-launch re-clearing only adds fixed startup cost
    // (amplified by AV scanners on Windows). This deliberately excludes cookies,
    // auth cache, localStorage and IDB.
    //
    // These operations are independent — run them in parallel to
    // shorten the startup critical path before the window can appear.
    const dataDirectory = path.join(app.getPath("userData"), "data");
    const rendererCacheClearVersionPath = path.join(app.getPath("userData"), "renderer-cache-clear-version.json");
    const lastClearedVersion = readRendererCacheClearedVersion(rendererCacheClearVersionPath);
    const currentAppVersion = app.getVersion();
    const clearDue = rendererCacheClearRequired(lastClearedVersion, currentAppVersion);
    const [rendererCacheCleanupResult, desktopMasterKey] = await Promise.all([
      clearDue
        ? clearLegacyRendererMailCache(session.defaultSession).then((result) => {
            writeRendererCacheClearedVersion(rendererCacheClearVersionPath, currentAppVersion);
            return result;
          })
        : Promise.resolve(skippedRendererCacheCleanup),
      loadOrCreateDesktopMasterKey(dataDirectory, safeStorage),
    ]);
    rendererCacheCleanup = rendererCacheCleanupResult;
    desktopDiagnostics.recordStartupTiming("renderer-cache-cleared");
    await writeDesktopSmokeProgress("renderer-cache-cleared");
    try {
      localServer = await startLocalServiceInUtilityProcess({
        dataDirectory,
        masterKey: desktopMasterKey.key,
      });
      desktopDiagnostics.recordStartupTiming("local-service-ready");
      await writeDesktopSmokeProgress("local-service-ready");
      applyDesktopSettingsFromServer();
    } finally {
      // The key copy exists only to cross the process boundary into the
      // service; the service holds its own copy for its lifetime.
      desktopMasterKey.key.fill(0);
    }
    if (desktopHostMode === "gui") {
      // The external Agent broker only serves pairing and CLI/MCP bridges,
      // none of which the first paint needs: start it alongside the window
      // instead of blocking the startup path on its PowerShell handshake.
      // GUI mode tolerates failure (diagnostic only); the initial pairing
      // requests below still wait for the broker either way.
      const brokerReady = startDesktopAgentBroker().catch((error) => {
        noteDesktopSmokeDiagnostic(`Desktop Agent Broker unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
      await loadMainWindowApp();
      desktopDiagnostics.recordStartupTiming("window-loaded");
      await writeDesktopSmokeProgress("window-loaded");
      observeSplashDismissal();
      await brokerReady;
      scheduleAgentPairingRequests(initialPairingRequestIds);
      void warnExternalPairingScopeDrift().catch(() => undefined);
    } else {
      await startDesktopAgentBroker();
    }
    if (desktopHostMode === "gui") {
      const desktopUpdate = await startDesktopUpdaterIfNeeded();
      if (smokeResultPath) await writeDesktopSmokeProgress("notification-probe");
      const desktopNotificationTest = smokeResultPath ? await waitForDesktopSmokeNotification() : undefined;
      const desktopWindowBar = !smokeResultPath
        ? undefined
        : !mainWindow
          ? true
          : await mainWindow.webContents.executeJavaScript("Boolean(document.querySelector('.window-bar'))").catch(() => true);
      const desktopWindowBarBlend = !smokeResultPath || !mainWindow
        ? undefined
        : await mainWindow.webContents.executeJavaScript(`(() => {
            const bar = document.querySelector(".window-bar");
            const sidebar = document.querySelector(".sidebar");
            if (!bar || !sidebar) return null;
            const barStyle = getComputedStyle(bar);
            const sidebarStyle = getComputedStyle(sidebar);
            const colorAlpha = (cssColor) => {
              const match = /rgba?\\(([^)]+)\\)/.exec(cssColor);
              if (!match) return 1;
              const channels = match[1].split(",").map((channel) => Number.parseFloat(channel));
              return channels.length > 3 ? channels[3] : 1;
            };
            return {
              // The floating window bar must be fully transparent so it blends
              // into whatever sits behind it and never paints an opaque strip
              // of its own over the workspace backdrop.
              backgroundColor: barStyle.backgroundColor,
              sidebarBackgroundColor: sidebarStyle.backgroundColor,
              borderBottomWidth: barStyle.borderBottomWidth,
              isTransparent: colorAlpha(barStyle.backgroundColor) === 0,
              hasBottomSeparator: Number.parseFloat(barStyle.borderBottomWidth) > 0,
            };
          })()`).catch(() => null);
      const desktopWindowBarLayout = !smokeResultPath || !mainWindow
        ? undefined
        : await mainWindow.webContents.executeJavaScript(`(() => {
            const bar = document.querySelector(".window-bar");
            const shell = document.querySelector(".mail-shell");
            if (!bar || !shell) return null;
            const sidebar = document.querySelector(".sidebar");
            const columnHeader = document.querySelector(".column-header");
            const searchWrap = document.querySelector(".search-wrap");
            const listFilterWrap = document.querySelector(".list-filter-wrap");
            const headerActions = document.querySelector(".header-actions");
            const agentHeader = document.querySelector(".agent-workspace-header");
            const agentActions = document.querySelector(".agent-header-actions");
            const controls = document.querySelector(".window-controls");
            const rail = document.querySelector(".icon-rail");
            const railButton = document.querySelector(".icon-rail .icon-button");
            const overlaps = (a, b) => a && b && !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
            const controlsRect = controls ? controls.getBoundingClientRect() : null;
            const railStyle = rail ? getComputedStyle(rail) : null;
            return {
              // The window bar floats over the columns instead of owning a
              // 42px row, so the sidebar and the column header reach the top
              // edge and nothing sits empty above the app content.
              barPosition: getComputedStyle(bar).position,
              barHeight: bar.getBoundingClientRect().height,
              shellTop: shell.getBoundingClientRect().top,
              sidebarTop: sidebar ? sidebar.getBoundingClientRect().top : null,
              sidebarHeight: sidebar ? sidebar.getBoundingClientRect().height : null,
              sidebarGridRow: sidebar ? getComputedStyle(sidebar).gridRow : null,
              messageColumnGridRow: (() => {
                const column = document.querySelector(".message-column");
                return column ? getComputedStyle(column).gridRow : null;
              })(),
              railGridRow: railStyle ? railStyle.gridRow : null,
              shellDisplay: getComputedStyle(shell).display,
              messageColumnCandidates: Array.from(document.querySelectorAll(".message-column")).map((column) => {
                const match = getComputedStyle(column);
                return {
                  parent: column.parentElement?.className ?? column.parentElement?.tagName ?? null,
                  height: column.getBoundingClientRect().height,
                  gridRow: match.gridRow,
                  gridColumn: match.gridColumn,
                  display: match.display,
                  position: match.position,
                  alignSelf: match.alignSelf,
                  heightStyle: match.height,
                };
              }),
              shellChildren: Array.from(shell.children).map((child) => {
                const match = getComputedStyle(child);
                return {
                  className: child.className,
                  tag: child.tagName,
                  height: child.getBoundingClientRect().height,
                  gridRow: match.gridRow,
                  gridColumn: match.gridColumn,
                  display: match.display,
                  position: match.position,
                };
              }),
              columnHeaderTop: columnHeader ? columnHeader.getBoundingClientRect().top : null,
              // The header keeps its compact height and its first row sits
              // inside the floating bar zone instead of being pushed down.
              columnHeaderHeight: columnHeader ? columnHeader.getBoundingClientRect().height : null,
              columnActiveTop: searchWrap ? searchWrap.getBoundingClientRect().top : listFilterWrap ? listFilterWrap.getBoundingClientRect().top : null,
              // Interactive elements under the floating bar still receive
              // clicks instead of the window drag.
              searchWrapDragRegion: searchWrap ? getComputedStyle(searchWrap).getPropertyValue("-webkit-app-region") : null,
              // The right-hand columns make room for the window controls, so
              // they never sit on top of each other in the corner.
              searchClearOfControls: searchWrap ? !overlaps(searchWrap.getBoundingClientRect(), controlsRect) : true,
              searchClearOfControlsList: listFilterWrap ? !overlaps(listFilterWrap.getBoundingClientRect(), controlsRect) : true,
              railButtonClearOfControls: railButton ? !overlaps(railButton.getBoundingClientRect(), controlsRect) : true,
              railButtonTop: railButton ? railButton.getBoundingClientRect().top : null,
              // The agent workspace header also shifts right of the window
              // controls instead of losing its title row height.
              agentHeaderActionsClearOfControls: agentActions ? !overlaps(agentActions.getBoundingClientRect(), controlsRect) : true,
              // The rail's separator line starts below the floating bar, so
              // it never crosses the window controls' background.
              railBorderLeftColor: railStyle ? railStyle.borderLeftColor : null,
              railBackgroundColor: railStyle ? railStyle.backgroundColor : null,
              // The whole chrome circle (sidebar + header + window bar +
              // rail) must share one translucent surface that follows
              // --bg-panel-opacity, so no corner reads as an opaque strip.
              railBackgroundMatchesSidebar: rail && sidebar ? getComputedStyle(sidebar).backgroundColor === railStyle?.backgroundColor : null,
              // The rail column's top strip behind the window controls is
              // painted by the mail-shell ::before; it must carry the same
              // panel surface as the message column so no bare canvas shows
              // through the transparent window bar.
              controlsStripBackdrop: (() => {
                const stripStyle = getComputedStyle(shell, "::before");
                const messageColumn = document.querySelector(".message-column");
                const columnStyle = messageColumn ? getComputedStyle(messageColumn) : null;
                return {
                  content: stripStyle.content,
                  gridColumn: stripStyle.gridColumn,
                  backgroundColor: stripStyle.backgroundColor,
                  matchesColumnSurface: columnStyle ? stripStyle.backgroundColor === columnStyle.backgroundColor : null,
                };
              })(),
              railTop: rail ? rail.getBoundingClientRect().top : null,
              // The header row must end flush at the window's right edge and
              // the rail must start exactly on the header's bottom edge —
              // no overhang past the window, no gap between the two.
              windowWidth: document.documentElement.clientWidth,
              documentWidth: document.documentElement.scrollWidth,
              shellRight: shell.getBoundingClientRect().right,
              headerRight: columnHeader ? columnHeader.getBoundingClientRect().right : null,
              headerBottom: columnHeader ? columnHeader.getBoundingClientRect().bottom : null,
              railMarginTop: railStyle ? railStyle.marginTop : null,
              railPosition: railStyle ? railStyle.position : null,
              junctionGap: columnHeader && rail ? rail.getBoundingClientRect().top - columnHeader.getBoundingClientRect().bottom : null,
              railBottom: rail ? rail.getBoundingClientRect().bottom : null,
              shellBottom: shell.getBoundingClientRect().bottom,
              // The header must never be flex-crushed by its parent column:
              // report the column's fit state and every child's geometry so
              // an overflow source is visible in the smoke report.
              messageColumn: (() => {
                const column = document.querySelector(".message-column");
                if (!column) return null;
                const columnStyle = getComputedStyle(column);
                return {
                  height: column.getBoundingClientRect().height,
                  scrollHeight: column.scrollHeight,
                  clientHeight: column.clientHeight,
                  overflowY: columnStyle.overflowY,
                  headerFlexShrink: (() => {
                    const header = document.querySelector(".column-header");
                    if (!header) return null;
                    const headerStyle = getComputedStyle(header);
                    return {
                      flexShrink: headerStyle.flexShrink,
                      flexBasis: headerStyle.flexBasis,
                      minHeight: headerStyle.minHeight,
                      height: headerStyle.height,
                    };
                  })(),
                  children: Array.from(column.children).map((child) => {
                    const style = getComputedStyle(child);
                    return {
                      className: child.className,
                      tag: child.tagName,
                      height: child.getBoundingClientRect().height,
                      flexShrink: style.flexShrink,
                      flexGrow: style.flexGrow,
                      flexBasis: style.flexBasis,
                      minHeight: style.minHeight,
                    };
                  }),
                };
              })(),
              // The window controls, the column header's first row and the
              // sidebar brand all rest on one shared vertical line, so the
              // drag strip does not visually separate the top edge.
              controlsCenter: controls ? controls.getBoundingClientRect().top + controls.getBoundingClientRect().height / 2 : null,
              columnRowCenter: searchWrap ? searchWrap.getBoundingClientRect().top + searchWrap.getBoundingClientRect().height / 2 : null,
              sidebarBrandCenter: (() => { const mark = document.querySelector(".brand-mark"); return mark ? mark.getBoundingClientRect().top + mark.getBoundingClientRect().height / 2 : null; })(),
              // The header's right-most control sits one header gap away
              // from the window controls instead of leaving a wide hole.
              headerActionsGapToControls: (() => {
                if (!controls) return null;
                const wraps = [searchWrap, listFilterWrap, headerActions].filter(Boolean);
                const rightmost = wraps.reduce((maxRight, wrap) => Math.max(maxRight, wrap.getBoundingClientRect().right), Number.NEGATIVE_INFINITY);
                return Number.isFinite(rightmost) ? controls.getBoundingClientRect().left - rightmost : null;
              })(),
            };
          })()`).catch(() => null);
      const desktopWindowControls = !smokeResultPath || !mainWindow
        ? undefined
        : await mainWindow.webContents.executeJavaScript("Boolean(document.querySelector('.window-controls') || document.querySelector('.window-control-slot'))").catch(() => true);
      await writeDesktopSmokeProgress("wallpaper-probe");
      const desktopWallpaper = smokeResultPath ? await inspectDesktopWallpaper() : undefined;
      await writeDesktopSmokeProgress("deep-diagnostic-probe");
      const desktopDeepDiagnostic = smokeResultPath ? await inspectDesktopDeepDiagnostic() : undefined;
      const desktopChipOverlapSweep = smokeResultPath && process.env.NAMI_CHIP_OVERLAP_PROBE === "1"
        ? await inspectDesktopChipOverlapSweep()
        : null;
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
        desktopWindowBar,
        desktopWindowBarBlend,
        desktopWindowBarLayout,
        desktopWindowControls,
        desktopWallpaper,
        desktopDeepDiagnostic,
        desktopChipOverlapSweep,
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
        desktopSingleInstance: getSingleInstanceSmokeResult(),
        desktopUpdate,
        desktopDiagnostics: getDesktopSmokeDiagnostics(),
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
    stopLocalServerProcess();
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
  ipcMain.on("nami:window-minimize", (event) => {
    if (!isCurrentRenderer(event)) return;
    mainWindow?.minimize();
  });
  ipcMain.on("nami:window-maximize-toggle", (event) => {
    if (!isCurrentRenderer(event)) return;
    const window = mainWindow;
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on("nami:window-close", (event) => {
    if (!isCurrentRenderer(event)) return;
    // Route through the normal close handler so the configured close behavior
    // (ask, tray, or quit) applies instead of an unconditional app.quit().
    mainWindow?.close();
  });
  ipcMain.handle("nami:window-is-maximized", (event) => {
    if (!isCurrentRenderer(event)) return false;
    return mainWindow?.isMaximized() ?? false;
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
    // Reveal only an existing absolute local path. The renderer strings must
    // not point Explorer at arbitrary locations or network shares.
    const resolved = path.resolve(filePath);
    if (!path.isAbsolute(resolved) || resolved.startsWith("\\\\") || !existsSync(resolved)) return;
    try {
      shell.showItemInFolder(resolved);
    } catch (error) {
      console.warn("Nami Mail could not show item in folder", error);
    }
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
    // While shutdown teardown is in flight the window is deliberately
    // destroyed first (see shutdownLocalServerAndQuit); window-all-closed
    // must not quit the app until the local service finished closing.
    if (desktopHostMode === "gui" && !isQuitting) app.quit();
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
    desktopDiagnostics.recordStartupTiming("quit-requested");
    if (!localServer || isQuitting) return;
    event.preventDefault();
    shutdownLocalServerAndQuit();
  });
  app.on("will-quit", () => {
    desktopAgentBrokerRecoveryGate = "closed";
    desktopDiagnostics.recordStartupTiming("quit-complete");
    globalShortcut.unregisterAll();
    powerMonitor.removeListener("resume", checkForUpdatesAfterExternalTrigger);
    desktopUpdater?.dispose();
  });
  desktopBootPromise = boot();
}
