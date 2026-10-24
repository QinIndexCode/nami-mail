import { isHttpUrl } from "./desktop-external-open.mjs";

/**
 * Desktop renderer hardening policy, extracted from `main.mts` so the rules are
 * unit-testable without running an Electron runtime.
 *
 * The two policies are deliberately pure/injected here:
 *
 * - **Permissions**: the renderer is a trusted local UI, but an unhandled
 *   permission request defaults to granted in Electron. Deny everything outside
 *   a short allowlist so compromised or misbehaving content cannot reach
 *   cameras, microphones, geolocation or other device surfaces through the
 *   session. `clipboard-sanitized-write` backs the "copy" affordances in the
 *   UI; `notifications` lets the web-side notification path request permission,
 *   while the mail client itself uses the native main-process Notification API.
 * - **Navigation**: a window may only navigate to this app's own origin.
 *   Everything else is denied; plain http(s) links are handed to the OS browser
 *   instead of loading inside the shell, and `<webview>` attachment is refused
 *   outright.
 *
 * The installer shapes are structural so tests can inject fakes; `main.mts`
 * passes the real Electron `Session` / `WebContents`.
 */

export type PermissionCallback = (granted: boolean) => void;

/**
 * The only permissions the renderer may hold. Everything else evaluates to
 * false in both the request and the check handler (default deny).
 */
export const rendererPermissionAllowlist: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "notifications",
]);

export function isPermissionGranted(permission: string): boolean {
  return rendererPermissionAllowlist.has(permission);
}

/** The part of an Electron `Session` this module installs onto. */
export type PermissionPolicySession = {
  setPermissionRequestHandler(
    handler: (webContents: unknown, permission: string, callback: PermissionCallback) => void,
  ): void;
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string) => boolean): void;
};

/**
 * Installs the permission policy on the session every renderer shares.
 * Both handlers consult the same allowlist: Electron can answer a permission
 * check without ever emitting a request, so installing only one would leave the
 * other path at its permissive default.
 */
export function installRendererPermissionPolicy(target: PermissionPolicySession): void {
  target.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isPermissionGranted(permission));
  });
  target.setPermissionCheckHandler((_webContents, permission) => isPermissionGranted(permission));
}

export type PreventableNavigationEvent = {
  preventDefault(): void;
  /** Newer Electron exposes the target URL on the event; older builds pass it separately. */
  url?: string;
};

export type FrameNavigationEvent = {
  preventDefault(): void;
  url: string;
};

export type WindowOpenHandler = (details: { url: string }) => { action: "deny" };

/** The part of an Electron `WebContents` the navigation guards install onto. */
export type NavigationGuardTarget = {
  setWindowOpenHandler(handler: WindowOpenHandler): void;
  on(event: "will-navigate", listener: (event: PreventableNavigationEvent, legacyUrl?: string) => void): unknown;
  on(event: "will-redirect", listener: (event: PreventableNavigationEvent, legacyUrl?: string) => void): unknown;
  on(event: "will-frame-navigate", listener: (event: FrameNavigationEvent) => void): unknown;
  on(event: "will-attach-webview", listener: (event: { preventDefault(): void }) => void): unknown;
};

export type NavigationGuardDeps = {
  /**
   * Origin of this app's renderer, or a getter for it. A getter is accepted
   * because the window shell is created before the local service starts, while
   * the app origin only becomes known once it is listening. `undefined` means
   * "origin not known yet" and fails closed: every navigation is denied until
   * the renderer has an origin to be same-origin with.
   */
  appOrigin: string | undefined | (() => string | undefined);
  openInBrowser: (url: string) => void | Promise<void>;
};

/**
 * True only for a well-formed http(s) URL whose origin equals the app origin.
 * An unknown origin allows nothing.
 *
 * The scheme check is not redundant with the origin check: `blob:<appOrigin>/…`
 * inherits the app origin, so an origin-only comparison would admit a top-level
 * navigation to a renderer-authored blob document (`frame-src` does not govern
 * top-level navigation). Only the schemes the local service can serve pass.
 */
export function isLocalNavigationAllowed(url: string, appOrigin: string | undefined): boolean {
  if (appOrigin === undefined) return false;
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;
    return target.origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

function currentAppOrigin(deps: NavigationGuardDeps): string | undefined {
  return typeof deps.appOrigin === "function" ? deps.appOrigin() : deps.appOrigin;
}

function navigationUrl(event: PreventableNavigationEvent, legacyUrl?: string): string {
  return typeof event.url === "string" ? event.url : (legacyUrl ?? "");
}

/**
 * Installs the navigation guards on the main window.
 *
 * `setWindowOpenHandler` denies every `window.open`; `will-navigate` and
 * `will-redirect` allow only same-origin navigations and forward external
 * http(s) links to the OS browser (a redirect is a navigation the content did
 * not ask for, so it gets the same policy); `will-frame-navigate` blocks
 * subframe escapes too; and `will-attach-webview` refuses `<webview>` guests
 * entirely. Note that http(s) is the only scheme forwarded outward: `file:` /
 * `javascript:` navigations are blocked without being opened anywhere.
 */
export function installNavigationGuards(webContents: NavigationGuardTarget, deps: NavigationGuardDeps): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void deps.openInBrowser(url);
    return { action: "deny" };
  });
  const handleNavigation = (event: PreventableNavigationEvent, legacyUrl?: string): void => {
    const url = navigationUrl(event, legacyUrl);
    if (isLocalNavigationAllowed(url, currentAppOrigin(deps))) return;
    event.preventDefault();
    if (isHttpUrl(url)) void deps.openInBrowser(url);
  };
  webContents.on("will-navigate", handleNavigation);
  webContents.on("will-redirect", handleNavigation);
  webContents.on("will-frame-navigate", (event) => {
    if (isLocalNavigationAllowed(event.url, currentAppOrigin(deps))) return;
    event.preventDefault();
  });
  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}
