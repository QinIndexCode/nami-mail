// Decisive probe for the settings close button icon hover/click bug.
// Moves the REAL mouse pointer across a 2D grid around the button and, for each
// point, dumps the full elementsFromPoint stack (pointer-events + rect) and the
// button :hover state. The goal is to find the element that swallows pointer
// events over the icon but not over the surrounding padding.
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173/?demo=1&desktop=1&desktopSmoke=1&platform=win32";
const bridgeStubSource = `(() => {
  const on = () => () => {};
  window.namiDesktop = {
    notify: async () => ({ shown: true }), copyVerificationCode: async () => ({ copied: true }),
    getUpdateStatus: async () => ({ schemaVersion: 2, phase: "unavailable", currentVersion: "0.3.0", targetVersion: null, percent: null, checkedAt: null, suppression: "disabled", remindAt: null, reason: "disabled", args: {} }),
    checkForUpdates: async () => undefined, downloadUpdate: async () => undefined, skipUpdate: async () => undefined,
    snoozeUpdate: async () => undefined, installUpdate: async () => ({ accepted: false }), setCustomNotificationSoundReady: () => {},
    onNewMail: on, onAutoReply: on, onOpenMessage: on, onComposeNew: on, onOpenInbox: on,
    onSettingsChanged: on, onUpdateStatus: on, onAgentConfirmationResult: on,
    minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
    isWindowMaximized: async () => false, onMaximizedChange: on,
  };
})();`;

function describe(el) {
  if (!el) return null;
  const cls = typeof el.className === "string" ? el.className : (el.className?.baseVal ?? "");
  return { tag: el.tagName, cls: (cls || "").slice(0, 60), pe: getComputedStyle(el).pointerEvents };
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(bridgeStubSource);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".desktop-app", { timeout: 20000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("nami-splash");
    return !el || el.classList.contains("done");
  });
  await page.waitForTimeout(900);

  await page.evaluate(() => {
    document.querySelector(".icon-rail")?.querySelector("button")?.click();
  });
  await page.waitForTimeout(400);

  const geo = await page.evaluate(() => {
    const btn = document.querySelector(".settings-heading .icon-button");
    if (!btn) return null;
    const rb = btn.getBoundingClientRect();
    const svg = btn.querySelector("svg");
    const rs = svg?.getBoundingClientRect();
    return {
      x0: rb.x, y0: rb.y, x1: rb.x + rb.width, y1: rb.y + rb.height,
      iw: rs ? rs.width : 0, ih: rs ? rs.height : 0,
      icx: rs ? rs.x + rs.width / 2 : null, icy: rs ? rs.y + rs.height / 2 : null,
      btnPe: getComputedStyle(btn).pointerEvents,
      btnZ: getComputedStyle(btn).zIndex,
      btnPos: getComputedStyle(btn).position,
    };
  });
  console.log("GEO", JSON.stringify(geo));
  if (!geo) { console.log("no close button"); process.exit(0); }

  const failures = [];
  const step = 4;
  for (let y = geo.y0 - 24; y <= geo.y1 + 24; y += step) {
    for (let x = geo.x0 - 12; x <= geo.x1 + 12; x += step) {
      await page.mouse.move(x, y);
      await page.waitForTimeout(30);
      const info = await page.evaluate(({ px, py }) => {
        const describe = (el) => {
          if (!el) return null;
          const cls = typeof el.className === "string" ? el.className : (el.className?.baseVal ?? "");
          return { tag: el.tagName, cls: (cls || "").slice(0, 60), pe: getComputedStyle(el).pointerEvents };
        };
        const btn = document.querySelector(".settings-heading .icon-button");
        if (!btn) return { px, py, missingBtn: true };
        const topEl = document.elementFromPoint(px, py);
        const hover = btn.matches(":hover");
        const stack = document.elementsFromPoint(px, py).slice(0, 6).map(describe);
        const inBtn = btn.contains(topEl);
        return { px, py, hover, inBtn, top: describe(topEl), stack };
      }, { px: x, py: y });
      const insideRect = x >= geo.x0 && x <= geo.x1 && y >= geo.y0 && y <= geo.y1;
      if (insideRect && !info.hover) {
        failures.push(info);
      }
    }
  }

  console.log("FAILURES", JSON.stringify(failures, null, 2));
} finally {
  await browser.close();
}