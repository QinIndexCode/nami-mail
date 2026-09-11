// At the exact moment the icon becomes non-hoverable during a downward sweep,
// capture the tooltip's computed pointer-events + rect and the button's rect.
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(bridgeStubSource);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".desktop-app", { timeout: 20000 });
  await page.waitForFunction(() => { const el = document.getElementById("nami-splash"); return !el || el.classList.contains("done"); });
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector(".icon-rail")?.querySelector("button")?.click());
  await page.waitForTimeout(400);

  const cx = 1005.76;
  await page.mouse.move(10, 10); await page.waitForTimeout(120);
  // Sweep slowly downward.
  const log = [];
  for (let y = 66; y <= 90; y += 1) {
    await page.mouse.move(cx, y); await page.waitForTimeout(28);
    const s = await page.evaluate((py) => {
      const btn = document.querySelector(".settings-heading .icon-button");
      const tip = document.querySelector(".nami-tooltip");
      const btnRect = btn.getBoundingClientRect();
      const tipVisible = tip.classList.contains("visible");
      const tipRect = tipVisible ? tip.getBoundingClientRect() : null;
      const tipClsVis = tipVisible ? getComputedStyle(tip).pointerEvents : null;
      const topEl = document.elementFromPoint(1005.76, py);
      const hit = btn.contains(topEl);
      return { hover: btn.matches(":hover"), hit,
        btnY: +btnRect.y.toFixed(0), btnY1: +(btnRect.y + btnRect.height).toFixed(0),
        tipVis: tipVisible, tipRect: tipRect ? `x${tipRect.x.toFixed(0)}y${tipRect.y.toFixed(0)}w${tipRect.width.toFixed(0)}h${tipRect.height.toFixed(0)}` : "-",
        tipPe: tipClsVis };
    }, y);
    log.push({ y, ...s });
  }
  console.log(JSON.stringify(log, null, 1));
} finally { await browser.close(); }