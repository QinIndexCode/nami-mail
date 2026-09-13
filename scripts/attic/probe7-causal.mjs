// Causal test: does disabling the tooltip on the settings close button make
// the icon hoverable again? Run with data-tooltip removed vs present.
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

async function runSweep(page, disableTooltip) {
  await page.evaluate(() => document.querySelector(".icon-rail")?.querySelector("button")?.click());
  await page.waitForTimeout(500);
  if (disableTooltip) {
    await page.evaluate(() => {
      document.querySelectorAll("[data-tooltip]").forEach((el) => el.removeAttribute("data-tooltip"));
      const tip = document.querySelector(".nami-tooltip");
      if (tip) tip.style.display = "none";
    });
  }
  const geo = await page.evaluate(() => {
    const btn = document.querySelector(".settings-heading .icon-button");
    const r = btn.getBoundingClientRect();
    return { cx: r.x + r.width / 2, y0: r.y, y1: r.y + r.height };
  });
  await page.mouse.move(10, 10); await page.waitForTimeout(120);
  const rows = [];
  for (let y = geo.y0 - 6; y <= geo.y1 + 6; y += 1) {
    await page.mouse.move(geo.cx, y); await page.waitForTimeout(26);
    const s = await page.evaluate(({ px, py }) => {
      const btn = document.querySelector(".settings-heading .icon-button");
      const r = btn.getBoundingClientRect();
      return { hover: btn.matches(":hover"), btnY0: +r.y.toFixed(0), btnY1: +(r.y + r.height).toFixed(0) };
    }, { px: geo.cx, py: y });
    rows.push({ y, ...s });
  }
  // Summarize: the contiguous hover band.
  const hoverBand = [];
  let start = null;
  for (const r of rows) {
    if (r.hover && start === null) start = r.y;
    if (!r.hover && start !== null) { hoverBand.push([start, rows[rows.indexOf(r) - 1].y]); start = null; }
  }
  if (start !== null) hoverBand.push([start, rows[rows.length - 1].y]);
  return { geo, hoverBand };
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(bridgeStubSource);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".desktop-app", { timeout: 20000 });
  await page.waitForFunction(() => { const el = document.getElementById("nami-splash"); return !el || el.classList.contains("done"); });
  await page.waitForTimeout(900);

  const withTooltip = await runSweep(page, false);
  await page.reload(); await page.waitForFunction(() => { const el = document.getElementById("nami-splash"); return !el || el.classList.contains("done"); });
  await page.waitForTimeout(700);
  const noTooltip = await runSweep(page, true);

  console.log(JSON.stringify({ withTooltip, noTooltip }, null, 2));
} finally { await browser.close(); }