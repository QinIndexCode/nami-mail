import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGlobalShortcut,
  applyLaunchAtStartup,
  applyUnreadBadge,
  buildTrayMenuTemplate,
  normalizeUnreadBadgeCount,
  resolveTrayVisibilityAction,
} from "../src/desktop-behaviors.mts";

function callRecorder<T extends (...args: never[]) => unknown>(): { calls: Parameters<T>[]; fn: (...args: Parameters<T>) => void } {
  const calls: Parameters<T>[] = [];
  return {
    calls,
    fn: (...args: Parameters<T>) => void calls.push(args),
  };
}

function fakeUnreadBadgeApi(platform: NodeJS.Platform) {
  const badgeCount = callRecorder<(...args: [number]) => void>();
  const overlay = callRecorder<(...args: [unknown | null, string]) => void>();
  const icon = callRecorder<(...args: []) => void>();
  const description = callRecorder<(...args: []) => void>();
  return {
    api: {
      platform,
      setBadgeCount: badgeCount.fn,
      setOverlayIcon: overlay.fn,
      createOverlayIcon: () => { icon.fn(); return { kind: "overlay-icon" }; },
      overlayDescription: () => { description.fn(); return "Nami Mail"; },
    },
    badgeCount,
    overlay,
    icon,
    description,
  };
}

test("normalizeUnreadBadgeCount drops non-finite and non-positive values to zero", () => {
  assert.equal(normalizeUnreadBadgeCount(undefined), 0);
  assert.equal(normalizeUnreadBadgeCount(null), 0);
  assert.equal(normalizeUnreadBadgeCount("3"), 0);
  assert.equal(normalizeUnreadBadgeCount(Number.NaN), 0);
  assert.equal(normalizeUnreadBadgeCount(Number.POSITIVE_INFINITY), 0);
  assert.equal(normalizeUnreadBadgeCount(-2), 0);
  assert.equal(normalizeUnreadBadgeCount(0), 0);
});

test("normalizeUnreadBadgeCount floors positive fractional counts", () => {
  assert.equal(normalizeUnreadBadgeCount(3), 3);
  assert.equal(normalizeUnreadBadgeCount(3.9), 3);
  assert.equal(normalizeUnreadBadgeCount(0.5), 0);
});

test("unread badge uses the native badge count on macOS", () => {
  const { api, badgeCount, icon } = fakeUnreadBadgeApi("darwin");
  applyUnreadBadge(api, 4);
  assert.deepEqual(badgeCount.calls, [[4]]);
  assert.equal(icon.calls.length, 0);
});

test("unread badge uses the native badge count on Linux", () => {
  const { api, badgeCount } = fakeUnreadBadgeApi("linux");
  applyUnreadBadge(api, 0);
  assert.deepEqual(badgeCount.calls, [[0]]);
});

test("unread badge shows the taskbar overlay dot on Windows when unread mail exists", () => {
  const { api, overlay, icon, description } = fakeUnreadBadgeApi("win32");
  applyUnreadBadge(api, 7.8);
  assert.equal(icon.calls.length, 1);
  assert.deepEqual(overlay.calls, [[{ kind: "overlay-icon" }, "Nami Mail"]]);
  assert.equal(description.calls.length, 1);
});

test("unread badge clears the taskbar overlay on Windows when unread mail is gone", () => {
  const { api, overlay, icon } = fakeUnreadBadgeApi("win32");
  applyUnreadBadge(api, 0);
  assert.equal(icon.calls.length, 0);
  assert.deepEqual(overlay.calls, [[null, ""]]);
});

for (const platform of ["darwin", "win32"]) {
  test(`launch-at-startup registers the login item on ${platform}`, () => {
    const loginItem = callRecorder<(...args: [{ openAtLogin: boolean; openAsHidden: boolean }]) => void>();
    applyLaunchAtStartup({ platform: platform as NodeJS.Platform, setLoginItemSettings: loginItem.fn }, true);
    assert.deepEqual(loginItem.calls, [[{ openAtLogin: true, openAsHidden: false }]]);
  });

  test(`launch-at-startup removes the login item on ${platform}`, () => {
    const loginItem = callRecorder<(...args: [{ openAtLogin: boolean; openAsHidden: boolean }]) => void>();
    applyLaunchAtStartup({ platform: platform as NodeJS.Platform, setLoginItemSettings: loginItem.fn }, false);
    assert.deepEqual(loginItem.calls, [[{ openAtLogin: false, openAsHidden: false }]]);
  });
}

for (const platform of ["linux", "freebsd"]) {
  test(`launch-at-startup is a no-op on ${platform} (no login-item API)`, () => {
    const loginItem = callRecorder<(...args: [{ openAtLogin: boolean; openAsHidden: boolean }]) => void>();
    applyLaunchAtStartup({ platform: platform as NodeJS.Platform, setLoginItemSettings: loginItem.fn }, true);
    assert.equal(loginItem.calls.length, 0);
  });
}

const accelerator = "CommandOrControl+Shift+M";
const listener = () => undefined;

function shortcutApi(existing: boolean, registerResult = true) {
  const registered = callRecorder<(...args: [string]) => void>();
  const unregistered = callRecorder<(...args: [string]) => void>();
  const api = {
    isRegistered: (_accelerator: string) => existing,
    register: (_accelerator: string, _listener: () => void) => { registered.fn(_accelerator); return registerResult; },
    unregister: (_accelerator: string) => { unregistered.fn(_accelerator); },
  };
  return { api, registered, unregistered };
}

test("global shortcut registers the accelerator when enabled and free", () => {
  const { api, registered, unregistered } = shortcutApi(false);
  const result = applyGlobalShortcut(api, true, accelerator, listener);
  assert.equal(result, true);
  assert.deepEqual(registered.calls, [[accelerator]]);
  assert.equal(unregistered.calls.length, 0);
});

test("global shortcut does not re-register an active accelerator", () => {
  const { api, registered } = shortcutApi(true);
  const result = applyGlobalShortcut(api, true, accelerator, listener);
  assert.equal(result, true);
  assert.equal(registered.calls.length, 0);
});

test("global shortcut reports a failed registration without throwing", () => {
  const { api, registered } = shortcutApi(false, false);
  const result = applyGlobalShortcut(api, true, accelerator, listener);
  assert.equal(result, false);
  assert.equal(registered.calls.length, 1);
});

test("global shortcut unregisters the accelerator when disabled", () => {
  const { api, registered, unregistered } = shortcutApi(true);
  const result = applyGlobalShortcut(api, false, accelerator, listener);
  assert.equal(result, true);
  assert.deepEqual(unregistered.calls, [[accelerator]]);
  assert.equal(registered.calls.length, 0);
});

test("global shortcut leaves an already-unregistered accelerator alone when disabled", () => {
  const { api, unregistered } = shortcutApi(false);
  const result = applyGlobalShortcut(api, false, accelerator, listener);
  assert.equal(result, true);
  assert.equal(unregistered.calls.length, 0);
});

const trayLabels = {
  show: "Show Nami Mail",
  hide: "Hide to tray",
  newMail: "New mail",
  inbox: "Open inbox",
  quit: "Quit Nami Mail",
};

test("tray menu leads with the visibility toggle whose label follows the window state", () => {
  const visibleTemplate = buildTrayMenuTemplate(trayLabels, true);
  assert.equal(visibleTemplate[0].type, "item");
  assert.equal(visibleTemplate[0].type === "item" && visibleTemplate[0].label, trayLabels.hide);
  assert.deepEqual(visibleTemplate[0].type === "item" && visibleTemplate[0].action, { kind: "toggle-window" });

  const hiddenTemplate = buildTrayMenuTemplate(trayLabels, false);
  assert.equal(hiddenTemplate[0].type === "item" && hiddenTemplate[0].label, trayLabels.show);
});

test("tray menu offers compose and inbox between the toggle and quit separators", () => {
  const template = buildTrayMenuTemplate(trayLabels, false);
  assert.deepEqual(
    template.map((item) => (item.type === "item" ? item.action.kind : item.type)),
    ["toggle-window", "separator", "compose-new", "open-inbox", "separator", "quit"],
  );
  assert.equal(template[0].type === "item" && template[0].label, "Show Nami Mail");
  assert.equal(template[2].type === "item" && template[2].label, "New mail");
  assert.equal(template[3].type === "item" && template[3].label, "Open inbox");
  assert.equal(template[5].type === "item" && template[5].label, "Quit Nami Mail");
});

test("resolveTrayVisibilityAction hides a visible window and shows a hidden one", () => {
  assert.equal(resolveTrayVisibilityAction(true), "hide");
  assert.equal(resolveTrayVisibilityAction(false), "show");
});