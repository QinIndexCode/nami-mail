// Test A: does the tooltip, when visible, actually intercept the icon?
// Compare hit-testing over the icon with tooltip visible vs hidden.
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

  // Measure fresh geometry.
  const geo = await page.evaluate(() => {
    const btn = document.querySelector(".settings-heading .icon-button");
    const svg = btn.querySelector("svg");
    const rb = btn.getBoundingClientRect(), rs = svg.getBoundingClientRect();
    return { bx: rb.x + rb.width / 2, by0: rb.y, by1: rb.y + rb.height, icx: rs.x + rs.width / 2, icy: rs.y + rs.height / 2 };
  });
  const cx = geo.icx;

  // Function: sample hover/hit at the icon y, given a chosen pointer path.
  const hitAtIcon = async (approachTop) => {
    await page.mouse.move(10, 10); await page.waitForTimeout(120);
    if (approachTop) { await page.mouse.move(cx, geo.by0 + 1); await page.waitForTimeout(130); }
    await page.mouse.move(cx, geo.icy); await page.waitForTimeout(60);
    const info = await page.evaluate(({ px, py }) => {
      const btn = document.querySelector(".settings-heading .icon-button");
      const tip = document.querySelector(".nami-tooltip");
      const visible = tip && tip.classList.contains("visible");
      const tipPe = visible ? getComputedStyle(tip).pointerEvents : null;
      const tr = visible ? tip.getBoundingClientRect() : null;
      const topEl = document.elementFromPoint(px, py);
      const iconHit = btn.contains(topEl);
      return { hover: btn.matches(":hover"), hit: iconHit, tipVisible: visible, tipPe, tipRect: tr ? `x${tr.x.toFixed(0)}y${tr.y.toFixed(0)}w${tr.width.toFixed(0)}h${tr.height.toFixed(0)}` : null };
    }, { px: cx, py: geo.icy });
    return info;
  };

  const directNoTop = await hitAtIcon(false);
  const viaTopTooltip = await hitAtIcon(true);

  // Also: hover the top, THEN hide tooltip via JS, then check icon.
  await page.mouse.move(cx, geo.by0 + 1); await page.waitForTimeout(130);
  const afterHide = await page.evaluate(({ px, py }) => {
    const tip = document.querySelector(".nami-tooltip");
    tip.classList.remove("visible");
    const btn = document.querySelector(".settings-heading .icon-button");
    const topEl = document.elementFromPoint(px, py);
    return { hover: btn.matches(":hover"), hit: btn.contains(topEl) };
  }, { px: cx, py: geo.icy });

  console.log(JSON.stringify({ geo, directNoTop, viaTopTooltip, afterHide }, null, 2));
} finally { await browser.close(); }