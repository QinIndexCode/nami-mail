// Sweep the real pointer vertically through the settings close button and map,
// per y row, the topmost hit-test element and whether the button is :hovered.
// Reproduces the reported "icon y-band swallows hover/click" symptom if present.
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173/?demo=1&desktop=1&desktopSmoke=1&platform=win32";
const bridgeStubSource = `(() => {
  const on = () => () => {};
  const stub = {
    notify: async () => ({ shown: true }), copyVerificationCode: async () => ({ copied: true }),
    getUpdateStatus: async () => ({ schemaVersion: 2, phase: "unavailable", currentVersion: "0.3.0", targetVersion: null, percent: null, checkedAt: null, suppression: "disabled", remindAt: null, reason: "disabled", args: {} }),
    checkForUpdates: async () => undefined, downloadUpdate: async () => undefined, skipUpdate: async () => undefined,
    snoozeUpdate: async () => undefined, installUpdate: async () => ({ accepted: false }), setCustomNotificationSoundReady: () => {},
    onNewMail: on, onAutoReply: on, onOpenMessage: on, onComposeNew: on, onOpenInbox: on,
    onSettingsChanged: on, onUpdateStatus: on, onAgentConfirmationResult: on,
    minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
    isWindowMaximized: async () => false, onMaximizedChange: on,
  };
  Object.defineProperty(window, "namiDesktop", { value: stub, configurable: true });
})();`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(bridgeStubSource);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".desktop-app", { timeout: 20000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("nami-splash");
    return !el || el.classList.contains("done");
  }, { timeout: 15000 });
  await page.waitForTimeout(800);

  // Open settings.
  await page.evaluate(() => {
    document.querySelector(".icon-rail")?.querySelector("button")?.click();
  });
  await page.waitForTimeout(350);

  // Hook counters on the close button, then sweep.
  const result = await page.evaluate(async () => {
    const btn = document.querySelector(".settings-heading .icon-button");
    if (!btn) return { error: "no close button" };
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;

    // Enumerate all overlay candidates transparently covering the button and
    // log which element is topmost at each sampled row.
    const rows = [];
    const step = 2;
    const buttonOutline = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    for (let y = r.top - 30; y <= r.bottom + 30; y += step) {
      const topEl = document.elementFromPoint(cx, y);
      let cls = "";
      let tag = "";
      let n = topEl;
      // Identify nearest decorated element for the topmost hit.
      cls = typeof topEl?.className === "string" ? topEl.className : (topEl?.className?.baseVal ?? "");
      tag = topEl?.tagName ?? "none";
      const isBtn = topEl === btn;
      rows.push({ y: +y.toFixed(1), tag, cls, isBtn });
    }
    // Also compute precise bounds of the sub-region: sample whether btn is hover
    // target by checking :hover at each row (moved externally).
    return { buttonOutline, rows };
  });

  const outline = result.buttonOutline;
  const scan = [];
  const top = outline.top - 30;
  const bottom = outline.bottom + 30;
  for (let y = top; y <= bottom; y += 2) {
    const hoverInfo = await page.evaluate((yy) => {
      const btn = document.querySelector(".settings-heading .icon-button");
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const topEl = document.elementFromPoint(cx, yy);
      let cls = typeof topEl?.className === "string" ? topEl.className : (topEl?.className?.baseVal ?? "");
      return {
        topTag: topEl?.tagName,
        topCls: cls,
        topIsBtnOrChild: topEl === btn || btn.contains(topEl),
        btnHover: btn.matches(":hover"),
        y: yy,
      };
    }, y);
    scan.push(hoverInfo);
  }

  console.log(JSON.stringify({ outline: result.buttonOutline, rows: result.rows.length, scan }, null, 2));
} finally {
  await browser.close();
}