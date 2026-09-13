// Real-mouse grid sweep of the settings close button: move the actual pointer
// across a fine grid and record whether :hover is ON, then dump the exact
// dead-zone shape. Correlates with the user's "icon x-strip dead" report.
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
  await page.waitForFunction(() => { const el = document.getElementById("nami-splash"); return !el || el.classList.contains("done"); }, { timeout: 15000 });
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector(".icon-rail")?.querySelector("button")?.click());
  await page.waitForTimeout(700);

  const geo = await page.evaluate(() => {
    const btn = document.querySelector(".settings-heading .icon-button");
    const svg = btn.querySelector("svg");
    const rb = btn.getBoundingClientRect();
    const rs = svg.getBoundingClientRect();
    return { bx0: rb.x, by0: rb.y, bw: rb.width, bh: rb.height, ix0: rs.x, iy0: rs.y, iw: rs.width, ih: rs.height };
  });

  // Sweep with the real pointer over the button and a generous margin.
  const grid = [];
  const xStart = Math.round(geo.bx0 - 14), xEnd = Math.round(geo.bx0 + geo.bw + 14);
  const yStart = Math.round(geo.by0 - 30), yEnd = Math.round(geo.by0 + geo.bh + 30);
  // Ensure no stale hover.
  await page.mouse.move(2, 2); await page.waitForTimeout(60);
  for (let y = yStart; y <= yEnd; y += 2) {
    for (let x = xStart; x <= xEnd; x += 2) {
      await page.mouse.move(x, y);
      await page.waitForTimeout(14);
      const on = await page.evaluate(() => {
        const btn = document.querySelector(".settings-heading .icon-button");
        const tip = document.querySelector(".nami-tooltip");
        return { hover: btn.matches(":hover"), tipOn: tip ? tip.classList.contains("visible") : false };
      });
      grid.push({ x, y, on: on.hover, tipOn: on.tipOn });
    }
  }

  // Render a y-banded ascii map: columns = x, rows = y, '.' = off, '#' = hover, 'I' = icon band.
  const iconXMin = Math.round(geo.ix0), iconXMax = Math.round(geo.ix0 + geo.iw);
  const iconYMin = Math.round(geo.iy0), iconYMax = Math.round(geo.iy0 + geo.ih);
  const yVals = [...new Set(grid.map((g) => g.y))].sort((a, b) => a - b);
  const xVals = [...new Set(grid.map((g) => g.x))].sort((a, b) => a - b);
  const xIdx = new Map(xVals.map((v, i) => [v, i]));
  console.log(`btn rect: x${geo.bx0}..${geo.bx0 + geo.bw} y${geo.by0}..${geo.by0 + geo.bh}`);
  console.log(`icon rect: x${geo.ix0}..${geo.ix0 + geo.iw} y${geo.iy0}..${geo.iy0 + geo.ih}`);
  console.log(`x cells: ${xVals.length} (${xStart}..${xEnd}), y rows: ${yVals.length} (${yStart}..${yEnd})`);
  const mark = {};
  for (const g of grid) {
    const xi = xIdx.get(g.x);
    if (!mark[g.y]) mark[g.y] = new Array(xVals.length).fill(".");
    mark[g.y][xi] = g.on ? "#" : ".";
  }
  for (const y of yVals) {
    const rowIconY = y >= iconYMin && y <= iconYMax;
    let line = "";
    for (let xi = 0; xi < xVals.length; xi++) {
      const xv = xVals[xi];
      line += mark[y][xi];
    }
    const flag = rowIconY ? (y === Math.round((iconYMin + iconYMax) / 2) ? " <== icon center row" : "   (icon y-band)") : "";
    console.log(`${String(y).padStart(3)}|${line}|${flag}`);
  }
} finally {
  await browser.close();
}