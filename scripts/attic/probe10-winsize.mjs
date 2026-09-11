// Test multiple window sizes: does the settings close button sit under the
// .window-bar overlay (pointer-events:auto, 144x66 top-right), and does that
// coincide with a hover dead zone? Real-mouse sweep per size.
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
  for (const size of [{ w: 1440, h: 920 }, { w: 1280, h: 800 }, { w: 1024, h: 700 }, { w: 900, h: 680 }, { w: 850, h: 560 }]) {
    const page = await browser.newPage({ viewport: { width: size.w, height: size.h } });
    await page.addInitScript(bridgeStubSource);
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForSelector(".desktop-app", { timeout: 20000 });
    await page.waitForFunction(() => { const el = document.getElementById("nami-splash"); return !el || el.classList.contains("done"); }, { timeout: 15000 });
    await page.waitForTimeout(800);
    await page.evaluate(() => document.querySelector(".icon-rail")?.querySelector("button")?.click());
    await page.waitForTimeout(700);

    const geo = await page.evaluate(() => {
      const btn = document.querySelector(".settings-heading .icon-button");
      const svg = btn.querySelector("svg");
      const wb = document.querySelector(".desktop-app .window-bar");
      const rb = btn.getBoundingClientRect(), rs = svg.getBoundingClientRect(), wr = wb.getBoundingClientRect();
      const overlap = !(rb.right <= wr.left || rb.left >= wr.right || rb.bottom <= wr.top || rb.top >= wr.bottom);
      return {
        btn: { x: rb.x, y: rb.y, w: rb.width, h: rb.height },
        icon: { x: rs.x, y: rs.y, w: rs.width, h: rs.height },
        wbar: { x: wr.x, y: wr.y, w: wr.width, h: wr.height },
        overlapBtn: overlap,
        overlapIcon: !(rs.right <= wr.left || rs.left >= wr.right || rs.bottom <= wr.top || rs.top >= wr.bottom),
      };
    });

    // Real-mouse sweep of icon center column & across button to find dead zone.
    await page.mouse.move(2, 2); await page.waitForTimeout(50);
    const cx = geo.btn.x + geo.btn.w / 2;
    const dead = [];
    for (let y = geo.btn.y - 8; y <= geo.btn.y + geo.btn.h + 8; y += 1) {
      await page.mouse.move(cx, y); await page.waitForTimeout(16);
      const on = await page.evaluate(() => document.querySelector(".settings-heading .icon-button").matches(":hover"));
      dead.push({ y: +y.toFixed(1), on });
    }
    const hoverBands = [];
    let start = null;
    for (const d of dead) {
      if (d.on && start === null) start = d.y;
      if (!d.on && start !== null) { hoverBands.push([start, dead[dead.indexOf(d) - 1].y]); start = null; }
    }
    if (start !== null) hoverBands.push([start, dead[dead.length - 1].y]);

    console.log(`=== viewport ${size.w}x${size.h} ===`);
    console.log(`  btn=${JSON.stringify(geo.btn)} icon=${JSON.stringify(geo.icon)}`);
    console.log(`  window-bar=${JSON.stringify(geo.wbar)} overlapsBtn=${geo.overlapBtn} overlapsIcon=${geo.overlapIcon}`);
    console.log(`  icon center hover bands (y): ${JSON.stringify(hoverBands)}`);
    await page.close();
  }
} finally {
  await browser.close();
}