// Faithful reproduction: move the real mouse slowly from above the settings
// close button down through the icon column, sampling hover + tooltip rect.
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

  await page.mouse.move(10, 10); // park far away
  await page.waitForTimeout(200);

  const rows = [];
  for (let y = 40; y <= 120; y += 2) {
    await page.mouse.move(1005.76, y);
    await page.waitForTimeout(24);
    const s = await page.evaluate((py) => {
      const btn = document.querySelector(".settings-heading .icon-button");
      const tip = document.querySelector(".nami-tooltip");
      const te = tip && tip.classList.contains("visible") ? tip.getBoundingClientRect() : null;
      const topEl = document.elementFromPoint(1005.76, py);
      const hit = (topEl === btn || btn.contains(topEl));
      return {
        hover: btn.matches(":hover"),
        hit,
        top: topEl === btn ? "BTN" : btn.contains(topEl) ? "BTNchild" : `${topEl?.tagName}.${topEl?.className}`.slice(0, 30),
        tipVisible: Boolean(te),
        tipRect: te ? { x: +te.x.toFixed(0), y: +te.y.toFixed(0), w: +te.width.toFixed(0), h: +te.height.toFixed(0) } : null,
      };
    }, y);
    rows.push({ y, ...s });
  }
  // Compact: only print rows where hover toggles or tip is visible or hit is false inside expected range.
  const btnY0 = 68.3, btnY1 = 99.0;
  const interesting = rows.filter((r) => {
    const inside = r.y > btnY0 - 4 && r.y < btnY1 + 4;
    return (inside && !r.hover) || r.tipVisible;
  });
  console.log("INTERESTING", JSON.stringify(interesting, null, 2));
  console.log("LAST_SAMPLE", JSON.stringify(rows[rows.length - 1]));
} finally { await browser.close(); }