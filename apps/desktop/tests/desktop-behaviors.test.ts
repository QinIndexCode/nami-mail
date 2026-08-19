import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGlobalShortcut,
  applyLaunchAtStartup,
  applyTrayBadge,
  buildTrayMenuTemplate,
  extractMailtoUrl,
  nextTrayBadge,
  resolveTrayVisibilityAction,
} from "../src/desktop-behaviors.mts";

function callRecorder<T extends (...args: never[]) => unknown>(): { calls: Parameters<T>[]; fn: (...args: Parameters<T>) => void } {
  const calls: Parameters<T>[] = [];
  return {
    calls,
    fn: (...args: Parameters<T>) => void calls.push(args),
  };
}

test("tray badge lights up on new mail only while the window is not focused", () => {
  assert.equal(nextTrayBadge({ type: "new-mail", windowFocused: false }), true);
  assert.equal(nextTrayBadge({ type: "new-mail", windowFocused: true }), false);
});

test("tray badge clears when the window is focused", () => {
  assert.equal(nextTrayBadge({ type: "window-focused" }), false);
});

test("applyTrayBadge swaps to the badge icon when visible and back when not", () => {
  const setBadgeIcon = callRecorder<(...args: []) => void>();
  const setPlainIcon = callRecorder<(...args: []) => void>();
  const api = { setBadgeIcon: setBadgeIcon.fn, setPlainIcon: setPlainIcon.fn };

  applyTrayBadge(api, true);
  assert.equal(setBadgeIcon.calls.length, 1);
  assert.equal(setPlainIcon.calls.length, 0);

  applyTrayBadge(api, false);
  assert.equal(setBadgeIcon.calls.length, 1);
  assert.equal(setPlainIcon.calls.length, 1);
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

test("extractMailtoUrl returns the first mailto argument", () => {
  assert.equal(
    extractMailtoUrl(["nami.exe", "mailto:user@example.com?subject=Hi"]),
    "mailto:user@example.com?subject=Hi",
  );
  assert.equal(
    extractMailtoUrl(["nami.exe", "--flag", "mailto:?to=a@x.com", "plain"]),
    "mailto:?to=a@x.com",
  );
});

test("extractMailtoUrl accepts a quoted token and a scheme in any case", () => {
  assert.equal(extractMailtoUrl([`"MAILTO:user@example.com"`]), "MAILTO:user@example.com");
});

test("extractMailtoUrl rejects non-mailto tokens and undecodable URLs", () => {
  assert.equal(extractMailtoUrl(["nami.exe", "https://example.com", "mailto:"]), undefined);
  assert.equal(extractMailtoUrl(["nami.exe", "mailto:not a url with spaces and percent %zz"]), undefined);
  assert.equal(extractMailtoUrl([]), undefined);
});