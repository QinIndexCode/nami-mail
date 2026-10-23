import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  installNavigationGuards,
  installRendererPermissionPolicy,
  isLocalNavigationAllowed,
  isPermissionGranted,
  rendererPermissionAllowlist,
  type FrameNavigationEvent,
  type NavigationGuardDeps,
  type NavigationGuardTarget,
  type PermissionPolicySession,
  type WindowOpenHandler,
} from "../src/window-hardening.mts";

const permissionAllowlist = ["clipboard-sanitized-write", "notifications"];
const localOrigin = "http://127.0.0.1:3187";

type PermissionRequestHandler = Parameters<PermissionPolicySession["setPermissionRequestHandler"]>[0];
type PermissionCheckHandler = Parameters<PermissionPolicySession["setPermissionCheckHandler"]>[0];

function installPermissionPolicy(): { request: PermissionRequestHandler; check: PermissionCheckHandler } {
  let requestHandler: PermissionRequestHandler | undefined;
  let checkHandler: PermissionCheckHandler | undefined;
  installRendererPermissionPolicy({
    setPermissionRequestHandler(handler) {
      requestHandler = handler;
    },
    setPermissionCheckHandler(handler) {
      checkHandler = handler;
    },
  });
  assert.ok(requestHandler, "setPermissionRequestHandler must be installed");
  assert.ok(checkHandler, "setPermissionCheckHandler must be installed");
  return { request: requestHandler, check: checkHandler };
}

test("the permission policy defaults to deny and its allowlist is exactly two entries", () => {
  // The list is the policy, not an example: widening it is a security change.
  assert.deepEqual([...rendererPermissionAllowlist].sort(), [...permissionAllowlist].sort());
  assert.equal(rendererPermissionAllowlist.size, permissionAllowlist.length);

  const { request, check } = installPermissionPolicy();
  const denied = ["media", "geolocation", "openExternal", "display-capture", "clipboard-read", "midi", "fileSystem", "unknown"];
  for (const permission of denied) {
    const decisions: boolean[] = [];
    request(null, permission, (granted) => decisions.push(granted));
    assert.deepEqual(decisions, [false], `${permission} must be denied by the request handler`);
    assert.equal(check(null, permission), false, `${permission} must be denied by the check handler`);
    assert.equal(isPermissionGranted(permission), false, `${permission} must not be in the allowlist`);
  }
  for (const permission of permissionAllowlist) {
    const decisions: boolean[] = [];
    request(null, permission, (granted) => decisions.push(granted));
    assert.deepEqual(decisions, [true], `${permission} must be granted by the request handler`);
    assert.equal(check(null, permission), true, `${permission} must be granted by the check handler`);
    assert.equal(isPermissionGranted(permission), true);
  }
  // Matching is exact: no prefix/suffix fallback can smuggle a permission in.
  assert.equal(isPermissionGranted("clipboard-sanitized-write-extra"), false);
  assert.equal(isPermissionGranted("notifications "), false);
  assert.equal(isPermissionGranted("Notifications"), false);
});

test("only same-origin URLs are local navigations, and an unknown origin allows nothing", () => {
  assert.equal(isLocalNavigationAllowed(`${localOrigin}/index.html?desktop=1`, localOrigin), true);
  assert.equal(isLocalNavigationAllowed(`${localOrigin}/`, `${localOrigin}/`), true);
  for (const foreign of [
    "https://evil.example/",
    "http://127.0.0.1:3199/",
    "http://localhost:3187/",
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "not a url",
    "",
  ]) {
    assert.equal(isLocalNavigationAllowed(foreign, localOrigin), false, foreign);
  }
  assert.equal(isLocalNavigationAllowed(`${localOrigin}/index.html`, localOrigin), true);
  // Blob documents inherit the app origin, so an origin-only comparison admits
  // them; the scheme gate is what keeps top-level navigation to http(s).
  assert.equal(isLocalNavigationAllowed(`blob:${localOrigin}/2a1f-session`, localOrigin), false);
  assert.equal(isLocalNavigationAllowed("data:text/html,<b>x</b>", localOrigin), false);
  // Before the local service starts there is no app origin; fail closed instead
  // of admitting a placeholder origin.
  assert.equal(isLocalNavigationAllowed(`${localOrigin}/index.html`, undefined), false);
  assert.equal(isLocalNavigationAllowed(`${localOrigin}/index.html`, ""), false);
});

type Listener = (...args: never[]) => void;

type FakeWebContents = {
  target: NavigationGuardTarget;
  openHandlers: WindowOpenHandler[];
  listeners: Record<string, Listener[]>;
  emit(event: string, ...args: unknown[]): void;
};

function createFakeWebContents(): FakeWebContents {
  const openHandlers: WindowOpenHandler[] = [];
  const listeners: Record<string, Listener[]> = {};
  const target = {
    setWindowOpenHandler(handler: WindowOpenHandler) {
      openHandlers.push(handler);
    },
    on(event: string, listener: Listener) {
      (listeners[event] ??= []).push(listener);
      return target;
    },
  } as unknown as NavigationGuardTarget;
  return {
    target,
    openHandlers,
    listeners,
    emit(event, ...args) {
      const handlers = listeners[event] ?? [];
      assert.equal(handlers.length, 1, `exactly one ${event} listener must be installed`);
      (handlers[0] as (...inner: unknown[]) => void)(...args);
    },
  };
}

function installGuards(
  appOrigin: string | undefined | (() => string | undefined),
): { webContents: FakeWebContents; opened: string[] } {
  const opened: string[] = [];
  const webContents = createFakeWebContents();
  const deps: NavigationGuardDeps = {
    appOrigin,
    openInBrowser: (url) => {
      opened.push(url);
    },
  };
  installNavigationGuards(webContents.target, deps);
  assert.equal(webContents.openHandlers.length, 1, "setWindowOpenHandler must be installed once");
  for (const event of ["will-navigate", "will-redirect", "will-frame-navigate", "will-attach-webview"]) {
    assert.equal((webContents.listeners[event] ?? []).length, 1, `${event} must be installed once`);
  }
  return { webContents, opened };
}

type FakeNavigationEvent = {
  prevented: boolean;
  preventDefault(): void;
};

function navigationEvent(url?: string): FakeNavigationEvent & { url?: string } {
  const event = {
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
  } as FakeNavigationEvent & { url?: string };
  if (url !== undefined) event.url = url;
  return event;
}

test("window.open is always denied and only http(s) links reach the OS browser", () => {
  const { webContents, opened } = installGuards(localOrigin);
  const handler = webContents.openHandlers[0]!;

  assert.deepEqual(handler({ url: "https://evil.example/phish" }), { action: "deny" });
  assert.deepEqual(opened, ["https://evil.example/phish"]);

  for (const url of ["file:///C:/Windows/System32/calc.exe", "mailto:someone@example.com", "javascript:alert(1)"]) {
    assert.deepEqual(handler({ url }), { action: "deny" });
  }
  assert.deepEqual(opened, ["https://evil.example/phish"], "non-http(s) schemes must not be opened externally");
});

test("will-navigate allows this origin and blocks everything else", () => {
  const { webContents, opened } = installGuards(localOrigin);

  const local = navigationEvent(`${localOrigin}/index.html?desktop=1`);
  webContents.emit("will-navigate", local, `${localOrigin}/index.html?desktop=1`);
  assert.equal(local.prevented, false, "same-origin navigation must be allowed");

  const external = navigationEvent("https://evil.example/phish");
  webContents.emit("will-navigate", external, "https://evil.example/phish");
  assert.equal(external.prevented, true, "external navigation must be prevented");
  assert.deepEqual(opened, ["https://evil.example/phish"], "http(s) navigations are forwarded to the OS browser");

  // Pre-extraction main.mts passed the target URL as the second event argument;
  // the same listener must still work when the event object carries no url.
  const legacyLocal = navigationEvent();
  webContents.emit("will-navigate", legacyLocal, `${localOrigin}/mail`);
  assert.equal(legacyLocal.prevented, false, "the legacy second-argument URL must still count as local");

  const fileNavigation = navigationEvent("file:///C:/secret.txt");
  webContents.emit("will-navigate", fileNavigation, "file:///C:/secret.txt");
  assert.equal(fileNavigation.prevented, true, "file: navigation must be blocked");
  assert.deepEqual(opened, ["https://evil.example/phish"], "file: must be blocked without opening it externally");
});

test("will-redirect follows the same policy as will-navigate", () => {
  const { webContents, opened } = installGuards(localOrigin);

  const local = navigationEvent(`${localOrigin}/index.html`);
  webContents.emit("will-redirect", local, `${localOrigin}/index.html`);
  assert.equal(local.prevented, false, "same-origin redirect must be allowed");

  const external = navigationEvent("https://evil.example/redirected");
  webContents.emit("will-redirect", external, "https://evil.example/redirected");
  assert.equal(external.prevented, true, "external redirect must be prevented");
  assert.deepEqual(opened, ["https://evil.example/redirected"], "http(s) redirects are forwarded to the OS browser");

  const fileRedirect = navigationEvent("file:///C:/secret.txt");
  webContents.emit("will-redirect", fileRedirect, "file:///C:/secret.txt");
  assert.equal(fileRedirect.prevented, true, "file: redirect must be blocked");
  assert.deepEqual(opened, ["https://evil.example/redirected"], "file: redirects must not be opened externally");
});

test("will-frame-navigate blocks subframe escapes without opening them", () => {
  const { webContents, opened } = installGuards(localOrigin);

  const local = navigationEvent(`${localOrigin}/frame.html`) as FrameNavigationEvent & FakeNavigationEvent;
  webContents.emit("will-frame-navigate", local);
  assert.equal(local.prevented, false);

  const external = navigationEvent("https://evil.example/frame") as FrameNavigationEvent & FakeNavigationEvent;
  webContents.emit("will-frame-navigate", external);
  assert.equal(external.prevented, true, "foreign subframe navigation must be prevented");
  assert.deepEqual(opened, [], "subframe navigation must not be opened externally");
});

test("will-attach-webview is refused", () => {
  const { webContents } = installGuards(localOrigin);
  const event = navigationEvent();
  webContents.emit("will-attach-webview", event, {}, { src: "https://evil.example" });
  assert.equal(event.prevented, true, "attaching a <webview> guest must be prevented");
});

test("an unknown app origin denies every navigation", () => {
  const { webContents, opened } = installGuards(undefined);
  // Even a URL that will match the real origin later is just another foreign
  // navigation while the origin is unknown.
  for (const eventName of ["will-navigate", "will-redirect"]) {
    const event = navigationEvent(`${localOrigin}/index.html`);
    webContents.emit(eventName, event, `${localOrigin}/index.html`);
    assert.equal(event.prevented, true, `${eventName} must be prevented while the origin is unknown`);
  }
  const frameEvent = navigationEvent(`${localOrigin}/frame.html`) as FrameNavigationEvent & FakeNavigationEvent;
  webContents.emit("will-frame-navigate", frameEvent);
  assert.equal(frameEvent.prevented, true, "subframe navigation must be prevented while the origin is unknown");
  // A foreign http(s) URL is still forwarded to the OS browser (same policy as
  // any other external navigation); the app itself never loads it.
  assert.deepEqual(opened, [`${localOrigin}/index.html`, `${localOrigin}/index.html`]);
});

test("a lazily resolved app origin still admits the real app URL after the service starts", () => {
  // The window shell exists before the local service; pre-extraction main.mts
  // resolved the local origin at event time (`localServer?.url`), and the
  // extracted guard keeps that behaviour through an origin getter.
  const originState: { current: string | undefined } = { current: undefined };
  const { webContents } = installGuards(() => originState.current);

  const duringSplash = navigationEvent(`${localOrigin}/index.html`);
  webContents.emit("will-navigate", duringSplash, `${localOrigin}/index.html`);
  assert.equal(duringSplash.prevented, true, "the app URL is not local until the service origin is known");

  originState.current = localOrigin;
  const afterStartup = navigationEvent(`${localOrigin}/index.html`);
  webContents.emit("will-navigate", afterStartup, `${localOrigin}/index.html`);
  assert.equal(afterStartup.prevented, false, "once the service origin is known, the app URL is local");
});

test("the main window keeps sandboxing, context isolation and the extracted guards wired", () => {
  // The guards above are only real if main.mts installs them on the window and
  // keeps the renderer sandboxed; this is the regression check for the wiring
  // that the extraction moved around.
  const mainSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/main.mts"), "utf8");
  const webPreferences = /webPreferences:\s*\{([\s\S]*?)\n {4}\},/.exec(mainSource)?.[1];
  assert.ok(webPreferences, "main.mts must create a BrowserWindow with webPreferences");
  assert.match(webPreferences, /sandbox: true/);
  assert.match(webPreferences, /contextIsolation: true/);
  assert.match(webPreferences, /nodeIntegration: false/);
  assert.match(webPreferences, /preload:/);
  assert.match(mainSource, /installNavigationGuards\(mainWindow\.webContents,/);
  assert.match(mainSource, /installRendererPermissionPolicy\(session\.defaultSession\)/);
});
