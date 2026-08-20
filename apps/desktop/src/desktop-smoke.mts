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

// Deep runtime diagnostic: rail/wallpaper surface facts, main-window
// responsiveness, and the agent hand-off state — all measured in the live
// renderer so regressions are visible as numbers instead of screenshots.
export type DesktopDeepDiagnosticResult = {
  rail: {
    className: string;
    rect: { x: number; y: number; w: number; h: number; right: number; bottom: number };
    backgroundColor: string;
    backgroundAlpha: number;
    backgroundImage: string;
    position: string;
    gridColumn: string;
    gridRow: string;
  } | null;
  canvas: { className: string; backgroundColor: string; backgroundImage: string } | null;
  wallpaper: {
    rect: { x: number; y: number; w: number; h: number; right: number; bottom: number };
    opacity: string;
    backgroundImage: string;
    backgroundSize: string;
    backgroundPosition: string;
  } | null;
  variables: {
    scrimGlobal: string;
    scrimRegion: string;
    panelSolid: string;
    panelMuted: string;
    frame: string;
    bgCanvasTint: string;
    bgVignette: string;
  };
  navigation: {
    domContentLoadedMs: number;
    loadMs: number;
    rendererStartedMs: number;
  } | null;
  idle: {
    longtasks: Array<{ start: number; duration: number }>;
    mutations: number;
    animationCount: number;
    animationNames: string;
    timerMaxGapMs: number;
    timerSampleMs: number;
  };
  scroll: {
    rowCount: number;
    frameCostMs: number[];
    maxScroll: number;
    clientHeight: number;
    note?: string;
  } | null;
  agent: {
    launchButtonPresent: boolean;
    phase: string | null;
    agentRevealed: boolean;
    agentRect: { x: number; y: number; w: number; h: number; right: number; bottom: number } | null;
    agentScrollHeight: number | null;
    agentClientHeight: number | null;
    agentChildren: Array<{ className: string; h: number; w: number; display: string }> | null;
    backdropFilter: string | null;
    background: string | null;
    shellChildren: Array<{ className: string; display: string; h: number }> | null;
    contentEl: { className: string; h: number; display: string } | null;
    railAfterOpen: { rect: { x: number; y: number; w: number; h: number; right: number; bottom: number }; gridColumn: string; gridRow: string } | null;
    workspacePosition: string | null;
    citationsAnchorClearance: number | null;
    agentContextChip: {
      rect: { x: number; y: number; w: number; h: number; right: number; bottom: number };
      tag: string;
      ariaLabel: string;
      subject: string;
      railClearance: number;
      panelClearance: number;
    } | null;
    agentScopePicker: {
      rect: { x: number; y: number; w: number; h: number; right: number; bottom: number };
      tag: string;
      ariaLabel: string;
      label: string;
      railClearance: number;
      panelClearance: number;
    } | null;
    afterOpenPerf: {
      longtasks: Array<{ start: number; duration: number }>;
      mutations: number;
      animationCount: number;
      animationNames: string;
      timerMaxGapMs: number;
      timerSampleMs: number;
    };
  };
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
// Module import time lands inside the Electron boot path (before the app
// ready event), so progress timestamps measure the real startup journey.
const desktopSmokeProcessStartedAt = Date.now();
const desktopSmokeTimeline: Array<{ stage: string; elapsedMs: number }> = [];
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

export async function inspectDesktopDeepDiagnostic(): Promise<DesktopDeepDiagnosticResult> {
  const host = requireHost();
  const targetWindow = host.getMainWindow();
  const fallback: DesktopDeepDiagnosticResult = {
    rail: null,
    canvas: null,
    wallpaper: null,
    variables: { scrimGlobal: "", scrimRegion: "", panelSolid: "", panelMuted: "", frame: "", bgCanvasTint: "", bgVignette: "" },
    navigation: null,
    idle: { longtasks: [], mutations: 0, animationCount: 0, animationNames: "", timerMaxGapMs: 0, timerSampleMs: 0 },
    scroll: null,
    agent: {
      launchButtonPresent: false,
      phase: null,
      agentRevealed: false,
      agentRect: null,
      agentScrollHeight: null,
      agentClientHeight: null,
      agentChildren: null,
      backdropFilter: null,
      background: null,
      railAfterOpen: null,
      workspacePosition: null,
      citationsAnchorClearance: null,
      shellChildren: null,
      contentEl: null,
      agentContextChip: null,
      agentScopePicker: null,
      afterOpenPerf: { longtasks: [], mutations: 0, animationCount: 0, animationNames: "", timerMaxGapMs: 0, timerSampleMs: 0 },
    },
  };
  if (!targetWindow) return fallback;
  try {
    const result = await targetWindow.webContents.executeJavaScript(`
      (async () => {
        const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        const rgbAlpha = (color) => {
          const rgba = color.match(/^rgba\\(([^)]+)\\)$/);
          if (rgba) return Number(rgba[1].split(",")[3] ?? 1);
          const slash = color.match(/\\/\\s*([0-9.]+)\\)$/);
          if (slash) return Number(slash[1]);
          return /^rgb\\(/i.test(color) ? 1 : 0;
        };
        const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
        const samplePerf = (ms) => new Promise((resolve) => {
          const longtasks = [];
          let observer;
          try {
            observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longtasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) }); });
            observer.observe({ entryTypes: ["longtask"] });
          } catch { observer = undefined; }
          let mutations = 0;
          const mo = new MutationObserver(() => { mutations += 1; });
          mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
          const delays = [];
          const interval = setInterval(() => { delays.push(performance.now()); }, 50);
          setTimeout(() => {
            clearInterval(interval);
            mo.disconnect();
            if (observer) observer.disconnect();
            const gaps = [];
            for (let i = 1; i < delays.length; i += 1) gaps.push(Math.round(delays[i] - delays[i - 1]));
            gaps.shift();
            const maxGap = gaps.length ? Math.max(...gaps) : 0;
            const anims = document.getAnimations();
            const names = anims.slice(0, 12).map((a) => {
              const t = (a.effect && a.effect.target);
              const name = t ? getComputedStyle(t).animationName : "?";
              return name + (a.playState === "running" ? ":run" : ":idle");
            }).join(",");
            resolve({ longtasks, mutations, animationCount: anims.length, animationNames: names, timerMaxGapMs: maxGap, timerSampleMs: ms });
          }, ms);
        });
        const out = {};
        const rail = document.querySelector(".icon-rail");
        const canvas = document.querySelector(".workspace-canvas");
        const wallpaper = document.querySelector(".workspace-background");
        const shell = document.querySelector(".mail-shell");
        out.rail = rail ? { className: rail.className, rect: rect(rail), backgroundColor: getComputedStyle(rail).backgroundColor, backgroundAlpha: rgbAlpha(getComputedStyle(rail).backgroundColor), backgroundImage: getComputedStyle(rail).backgroundImage, position: getComputedStyle(rail).position, gridColumn: getComputedStyle(rail).gridColumn, gridRow: getComputedStyle(rail).gridRow } : null;
        out.canvas = canvas ? { className: canvas.className, backgroundColor: getComputedStyle(canvas).backgroundColor, backgroundImage: getComputedStyle(canvas).backgroundImage.slice(0, 200) } : null;
        out.wallpaper = wallpaper ? { rect: rect(wallpaper), opacity: getComputedStyle(wallpaper).opacity, backgroundImage: getComputedStyle(wallpaper).backgroundImage.slice(0, 140), backgroundSize: getComputedStyle(wallpaper).backgroundSize, backgroundPosition: getComputedStyle(wallpaper).backgroundPosition } : null;
        out.variables = { scrimGlobal: cssVar("--scrim-global"), scrimRegion: cssVar("--scrim-region"), panelSolid: cssVar("--panel-solid"), panelMuted: cssVar("--panel-muted"), frame: cssVar("--frame"), bgCanvasTint: cssVar("--bg-canvas-tint"), bgVignette: cssVar("--bg-vignette") };
        const nav = performance.getEntriesByType("navigation")[0];
        out.navigation = nav ? { domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd), loadMs: Math.round(nav.loadEventEnd), rendererStartedMs: Math.round(performance.timeOrigin) } : null;
        out.idle = await samplePerf(2200);
        // Select the first demo message so the Agent workspace renders its
        // reference-mail chip (currentMessage) and the chip geometry can be
        // checked against the icon rail.
        const firstMessageRow = document.querySelector(".message-list .message-item");
        if (firstMessageRow instanceof HTMLElement) firstMessageRow.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Force real layout cycles on the demo mail list: each scrollTop
        // mutation plus a layout read measures what one scroll frame costs
        // the main thread when rows are present. Three passes average out
        // scheduling noise; a single cost near the 16.7ms frame budget means
        // the list itself is the jank source.
        const scrollable = document.querySelector(".message-list");
        if (scrollable instanceof HTMLElement) {
          const rowCount = scrollable.querySelectorAll(".message-list-row").length;
          if (rowCount > 0 && scrollable.scrollHeight > scrollable.clientHeight) {
            const maxScroll = scrollable.scrollHeight - scrollable.clientHeight;
            const frameCostMs = [];
            for (let pass = 0; pass < 3; pass += 1) {
              const start = performance.now();
              for (let step = 0; step < 24; step += 1) {
                scrollable.scrollTop = (step % 2) * maxScroll;
                void scrollable.offsetHeight;
              }
              frameCostMs.push(Math.round(((performance.now() - start) / 24) * 10) / 10);
            }
            out.scroll = { rowCount, frameCostMs, maxScroll, clientHeight: scrollable.clientHeight };
          } else {
            out.scroll = { rowCount, frameCostMs: [], maxScroll: 0, clientHeight: scrollable.clientHeight, note: rowCount === 0 ? "empty-list" : "not-scrollable" };
          }
        }
        const launch = document.querySelector(".agent-launch-button");
        out.agent = { launchButtonPresent: Boolean(launch) };
        if (launch) launch.click();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const agentWs = document.querySelector(".agent-workspace");
        out.agent.phase = shell ? shell.getAttribute("data-agent-phase") : null;
        out.agent.agentRevealed = agentWs ? Boolean(agentWs.getClientRects().length) : false;
        out.agent.agentRect = agentWs ? rect(agentWs) : null;
        out.agent.agentScrollHeight = agentWs ? agentWs.scrollHeight : null;
        out.agent.agentClientHeight = agentWs ? agentWs.clientHeight : null;
        out.agent.agentChildren = agentWs ? Array.from(agentWs.children).map((c) => ({ className: c.className, h: Math.round(c.getBoundingClientRect().height), w: Math.round(c.getBoundingClientRect().width), display: getComputedStyle(c).display })) : null;
        out.agent.backdropFilter = agentWs ? getComputedStyle(agentWs).backdropFilter : null;
        out.agent.background = agentWs ? getComputedStyle(agentWs).backgroundColor : null;
        out.agent.shellChildren = shell ? Array.from(shell.children).map((c) => ({ className: c.className, display: getComputedStyle(c).display, h: Math.round(c.getBoundingClientRect().height) })) : null;
        const stream = agentWs ? agentWs.querySelector("[class*='message'], [class*='conversation'], [class*='thread']") : null;
        out.agent.contentEl = stream ? { className: stream.className, h: Math.round(stream.getBoundingClientRect().height), display: getComputedStyle(stream).display } : null;
        out.agent.railAfterOpen = rail ? { rect: rect(rail), gridColumn: getComputedStyle(rail).gridColumn, gridRow: getComputedStyle(rail).gridRow } : null;
        // The absolutely-positioned citations sidebar (right:14px) must anchor
        // to the workspace, not to the canvas: with position:static on the
        // workspace its containing block is the full canvas, putting it under
        // the rail. Assert the workspace is the positioned ancestor and that a
        // right:14px child would land clear of the rail.
        out.agent.workspacePosition = agentWs ? getComputedStyle(agentWs).position : null;
        out.agent.citationsAnchorClearance = agentWs && rail ? Math.round(rail.getBoundingClientRect().left - (agentWs.getBoundingClientRect().right - 14)) : null;
        const chip = document.querySelector(".agent-current-context");
        const scopePicker = document.querySelector(".agent-scope-picker");
        const mainPanel = agentWs ? agentWs.querySelector(".agent-main-panel") : null;
        out.agent.agentContextChip = chip instanceof HTMLElement && mainPanel instanceof HTMLElement && rail instanceof HTMLElement ? {
          rect: rect(chip),
          tag: chip.tagName,
          ariaLabel: chip.getAttribute("aria-label") ?? "",
          subject: (chip.querySelector("span")?.textContent ?? "").slice(0, 60),
          railClearance: Math.round(rail.getBoundingClientRect().left - chip.getBoundingClientRect().right),
          panelClearance: Math.round(mainPanel.getBoundingClientRect().right - chip.getBoundingClientRect().right),
        } : null;
        out.agent.agentScopePicker = scopePicker instanceof HTMLElement && mainPanel instanceof HTMLElement && rail instanceof HTMLElement ? {
          rect: rect(scopePicker),
          tag: scopePicker.tagName,
          ariaLabel: scopePicker.getAttribute("aria-label") ?? "",
          label: (scopePicker.querySelector("span")?.textContent ?? "").slice(0, 60),
          railClearance: Math.round(rail.getBoundingClientRect().left - scopePicker.getBoundingClientRect().right),
          panelClearance: Math.round(mainPanel.getBoundingClientRect().right - scopePicker.getBoundingClientRect().right),
        } : null;
        out.agent.afterOpenPerf = await samplePerf(1600);
        return out;
      })()
    `) as DesktopDeepDiagnosticResult;
    return result;
  } catch (error) {
    return { ...fallback, error: desktopSmokeError(error) };
  }
}

/**
 * Temporary reference-mail chip vs rail overlap sweep. Gated behind
 * NAMI_CHIP_OVERLAP_PROBE so the normal smoke run keeps its exact probe
 * sequence; the app is driven through several window widths in both the
 * desktop and the browser layout and every sample records the chip's and
 * the rail's geometry. scripts/check-chip-overlap.mjs prints the table.
 */
export async function inspectDesktopChipOverlapSweep(): Promise<Record<string, unknown> | null> {
  if (process.env.NAMI_CHIP_OVERLAP_PROBE !== "1") return null;
  const host = requireHost();
  const targetWindow = host.getMainWindow();
  if (!targetWindow) return { error: "no-window" };
  const sweepWidths = [1440, 1280, 1100, 1024, 940, 860, 800, 760, 700];
  const desktopUrl = targetWindow.webContents.getURL();
  const samples: Record<string, unknown>[] = [];
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const cleanup = async () => {
    try {
      if (!targetWindow.webContents.isDestroyed()) await targetWindow.loadURL(desktopUrl).catch(() => undefined);
      targetWindow.setSize(1440, 922);
      await settle(1200);
    } catch {
      // Best-effort restore; the sweep data is already in the report.
    }
  };
  const measureScript = `
    (() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
      const rail = document.querySelector(".icon-rail");
      const chip = document.querySelector(".agent-current-context");
      const picker = document.querySelector(".agent-scope-picker");
      const workspace = document.querySelector(".agent-workspace");
      const panel = workspace ? workspace.querySelector(":scope > .agent-main-panel") : null;
      const strip = panel ? panel.querySelector(":scope > .agent-context-strip") : null;
      const header = panel ? panel.querySelector(":scope > .agent-workspace-header") : null;
      const sidebar = workspace ? workspace.querySelector(":scope > .agent-conversation-sidebar") : null;
      const railEntry = rail ? { rect: rect(rail), display: getComputedStyle(rail).display } : null;
      const workspacePosition = workspace ? getComputedStyle(workspace).position : null;
      // A right:14px citation anchor inside the workspace must clear the rail
      // (it lands 14px before the workspace's right edge). If the workspace
      // were not the positioned ancestor, the anchor would resolve against
      // the canvas and end up under the rail.
      const citationsAnchor = workspace && rail ? Math.round(rail.getBoundingClientRect().left - (workspace.getBoundingClientRect().right - 14)) : null;
      const boxInfo = (el) => el ? { rect: rect(el), display: getComputedStyle(el).display, position: getComputedStyle(el).position, width: getComputedStyle(el).width, minWidth: getComputedStyle(el).minWidth, maxWidth: getComputedStyle(el).maxWidth, paddingLeft: getComputedStyle(el).paddingLeft, paddingRight: getComputedStyle(el).paddingRight, gridColumn: getComputedStyle(el).gridColumn, children: Array.from(el.children).map((c) => ({ className: String(c.className).slice(0, 40), rect: rect(c) })) } : null;
      const chipEntry = chip ? {
        rect: rect(chip),
        position: getComputedStyle(chip).position,
        maxWidth: getComputedStyle(chip).maxWidth,
        marginLeft: getComputedStyle(chip).marginLeft,
        subjectLength: (chip.querySelector("span")?.textContent ?? "").length,
        subject: (chip.querySelector("span")?.textContent ?? "").slice(0, 40),
      } : null;
      const pickerEntry = picker ? {
        rect: rect(picker),
        position: getComputedStyle(picker).position,
        maxWidth: getComputedStyle(picker).maxWidth,
        marginLeft: getComputedStyle(picker).marginLeft,
        labelLength: (picker.querySelector("span")?.textContent ?? "").length,
        label: (picker.querySelector("span")?.textContent ?? "").slice(0, 40),
      } : null;
      let overlap = null;
      if (chip && rail && getComputedStyle(rail).display !== "none") {
        const cr = chip.getBoundingClientRect();
        const rr = rail.getBoundingClientRect();
        const horizontal = Math.max(0, Math.min(cr.right, rr.right) - Math.max(cr.left, rr.left));
        const vertical = Math.max(0, Math.min(cr.bottom, rr.bottom) - Math.max(cr.top, rr.top));
        overlap = { horizontalOverlapPx: Math.round(horizontal), verticalOverlapPx: Math.round(vertical), overlapping: horizontal > 0 && vertical > 0, clearancePx: Math.round(rr.left - cr.right) };
      }
      let pickerOverlap = null;
      if (picker && rail && getComputedStyle(rail).display !== "none") {
        const pr = picker.getBoundingClientRect();
        const rr = rail.getBoundingClientRect();
        const horizontal = Math.max(0, Math.min(pr.right, rr.right) - Math.max(pr.left, rr.left));
        const vertical = Math.max(0, Math.min(pr.bottom, rr.bottom) - Math.max(pr.top, rr.top));
        pickerOverlap = { horizontalOverlapPx: Math.round(horizontal), verticalOverlapPx: Math.round(vertical), overlapping: horizontal > 0 && vertical > 0, clearancePx: Math.round(rr.left - pr.right) };
      }
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        pageScrollWidth: document.documentElement.scrollWidth,
        agentOpen: Boolean(workspace && workspace.getClientRects().length),
        workspace: workspace ? rect(workspace) : null,
        workspacePosition,
        citationsAnchor,
        panelBox: boxInfo(panel),
        stripBox: boxInfo(strip),
        headerBox: boxInfo(header),
        sidebar: sidebar ? rect(sidebar) : null,
        chip: chipEntry,
        picker: pickerEntry,
        rail: railEntry,
        overlap,
        pickerOverlap,
      };
    })()
  `;
  const selectLongestSubjectRowScript = `
    (() => {
      const rows = Array.from(document.querySelectorAll(".message-list .message-item"));
      let best = null;
      let bestLength = -1;
      for (const row of rows) {
        const subject = row.querySelector(".message-subject");
        const text = subject instanceof HTMLElement ? subject.textContent ?? "" : "";
        if (text.length > bestLength) { bestLength = text.length; best = row; }
      }
      if (best instanceof HTMLElement) best.click();
    })()
  `;
  const openAgentIfNeeded = async () => {
    const alreadyOpen = await targetWindow.webContents
      .executeJavaScript("Boolean(document.querySelector('.agent-workspace')?.getClientRects().length)")
      .catch(() => false);
    if (!alreadyOpen) {
      await targetWindow.webContents.executeJavaScript("document.querySelector('.agent-launch-button')?.click()").catch(() => undefined);
      await settle(1200);
    }
  };
  const sample = async (mode: string, width: number) => {
    targetWindow.setSize(width, 922);
    await settle(550);
    const geometry = await targetWindow.webContents.executeJavaScript(measureScript).catch((error) => ({ error: desktopSmokeError(error) }));
    samples.push({ mode, width, ...geometry });
  };
  try {
    // Longest subject first (the mail list is still visible), then open the
    // Agent workspace so the chip renders the worst-case subject length.
    await targetWindow.webContents.executeJavaScript(selectLongestSubjectRowScript);
    await settle(500);
    await openAgentIfNeeded();
    for (const width of sweepWidths) await sample("desktop", width);
    // Same sweep in the browser layout: reload without the desktop markers.
    const browserUrl = new URL(desktopUrl);
    browserUrl.searchParams.delete("desktop");
    browserUrl.searchParams.delete("platform");
    browserUrl.searchParams.delete("desktopSmoke");
    await targetWindow.loadURL(browserUrl.toString());
    await settle(1200);
    await targetWindow.webContents.executeJavaScript(selectLongestSubjectRowScript);
    await settle(500);
    await openAgentIfNeeded();
    for (const width of sweepWidths) await sample("browser", width);
  } catch (error) {
    await cleanup();
    return { samples, desktopUrl, error: desktopSmokeError(error) };
  }
  await cleanup();
  const overlapping = samples.filter((sample) => {
    const overlap = sample.overlap as { overlapping?: boolean } | null | undefined;
    const pickerOverlap = sample.pickerOverlap as { overlapping?: boolean } | null | undefined;
    return overlap?.overlapping === true || pickerOverlap?.overlapping === true;
  });
  const browserUrl = new URL(desktopUrl);
  browserUrl.searchParams.delete("desktop");
  browserUrl.searchParams.delete("platform");
  browserUrl.searchParams.delete("desktopSmoke");
  return {
    samples,
    overlappingCount: overlapping.length,
    overlappingWidths: overlapping.map((sample) => `${sample.mode}@${String(sample.width)}`),
    desktopUrl,
    browserUrl: browserUrl.toString(),
  };
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
    const isDemoRender = await targetWindow.webContents.executeJavaScript("new URLSearchParams(window.location.search).get('demo') === '1'");
    const initialCloseBehavior = await waitForCloseBehavior("ask", true);
    await host.rememberCloseBehavior("tray");
    if (isDemoRender) {
      // Demo mode never re-fetches settings from the local service (the web
      // app's loadSettings is a no-op there), so an open dialog cannot reflect
      // a native write by design. Guard the server-side write itself instead.
      const nativeTray = service.getSettings().closeBehavior === "tray" ? "tray" : "";
      await host.rememberCloseBehavior("ask");
      const nativeRestored = service.getSettings().closeBehavior === "ask" ? "ask" : "";
      return { initialCloseBehavior, updatedCloseBehavior: nativeTray, restoredCloseBehavior: nativeRestored };
    }
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
  desktopSmokeResult = { ...result, desktopStartupTimeline: desktopSmokeTimeline };
  await fs.mkdir(path.dirname(host.smokeResultPath), { recursive: true });
  await fs.writeFile(host.smokeResultPath, JSON.stringify(desktopSmokeResult), "utf8");
}

export async function writeDesktopSmokeProgress(stage: string): Promise<void> {
  const host = requireHost();
  if (!host.isDesktopSmoke || !host.smokeProgressPath) return;
  const elapsedMs = Date.now() - desktopSmokeProcessStartedAt;
  desktopSmokeTimeline.push({ stage, elapsedMs });
  try {
    await fs.mkdir(path.dirname(host.smokeProgressPath), { recursive: true });
    await fs.writeFile(host.smokeProgressPath, JSON.stringify({ stage, checkedAt: new Date().toISOString(), elapsedMs }), "utf8");
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
