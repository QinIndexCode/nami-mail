// Verify the app-region hypothesis: walk ancestors from elementFromPoint at
// the settings close button and report each ancestor's computed -webkit-app-region.
// In Electron, an element reached by the button that declares `drag` (with no
// intervening `no-drag`) makes the modal's point a drag region → real hover/click swallowed.
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173/?demo=1&desktop=1&desktopSmoke=1&platform=win32";
const bridgeStubSource = `(() => {
  const on = () => () => {};
  window.namiDesktop = { notify: async () => ({ shown: true }), copyVerificationCode: async () => ({ copied: true }),
    getUpdateStatus: async () => ({ schemaVersion: 2, phase: "unavailable", currentVersion: "0.3.0", targetVersion: null, percent: null, checkedAt: null, suppression: "disabled", remindAt: null, reason: "disabled", args: {} }),
    checkForUpdates: async () => undefined, downloadUpdate: async () => undefined, skipUpdate: async () => undefined,
    snoozeUpdate: async () => undefined, installUpdate: async () => ({ accepted: false }), setCustomNotificationSoundReady: () => {},
    onNewMail: on, onAutoReply: on, onOpenMessage: on, onComposeNew: on, onOpenInbox: on,
    onSettingsChanged: on, onUpdateStatus: on, onAgentConfirmationResult: on,
    minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
    isWindowMaximized: async () => false, onMaximizedChange: on }; })();`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 } }); // narrow → close btn overlaps drag header
  await page.addInitScript(bridgeStubSource);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".desktop-app", { timeout: 20000 });
  await page.waitForFunction(() => { const el = document.getElementById("nami-splash"); return !el || el.classList.contains("done"); }, { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector(".icon-rail")?.querySelector("button")?.click());
  await page.waitForTimeout(700);

  const report = await page.evaluate(() => {
    const btn = document.querySelector(".settings-heading .icon-button");
    const svg = btn.querySelector("svg");
    const r = svg.getBoundingClientRect();
    const px = r.x + r.width / 2, py = r.y + r.height / 2; // icon center
    const topEl = document.elementFromPoint(px, py);
    const chain = [];
    let el = topEl;
    while (el && chain.length < 14) {
      const ar = getComputedStyle(el)["-webkit-app-region"] || getComputedStyle(el).webkitAppRegion || "auto";
      const r2 = el.getBoundingClientRect();
      const cls = typeof el.className === "string" ? (el.className || "") : (el.className?.baseVal || "");
      chain.push({ tag: el.tagName, cls: cls.slice(0, 40), appRegion: ar, y: Math.round(r2.y), h: Math.round(r2.height) });
      el = el.parentElement;
    }
    // Also: does the modal/backdrop declare no-drag anywhere in the chain?
    return { px, py, topEl: topEl?.tagName, chain };
  });

  console.log(`icon center at (${report.px}, ${report.py}), topEl=${report.topEl}`);
  console.log("ancestor chain (button-ish => root): nearest app-region wins:");
  for (const c of report.chain) {
    const flag = c.appRegion !== "auto" && c.appRegion ? "  <== app-region:" + c.appRegion + (c.appRegion === "drag" ? "  (BLOCKS modal!)" : "") : "";
    console.log(`  ${c.tag}.${c.cls} ar=${c.appRegion} y=${c.y} h=${c.h}${flag}`);
  }
} finally {
  await browser.close();
}