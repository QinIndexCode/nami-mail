// Dump the FULL element stack + the tooltip rect at a BLOCKED point, after
// hovering the button top (which shows the tooltip).
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

  const CX = 1005.76;
  // Trigger hover + tooltip at the button's TOP.
  await page.mouse.move(10, 10); await page.waitForTimeout(150);
  await page.mouse.move(CX, 70); await page.waitForTimeout(150);
  // Now park at the icon center (blocked region).
  await page.mouse.move(CX, 80); await page.waitForTimeout(150);

  const dump = await page.evaluate((cx) => {
    const desc = (e) => {
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        tag: e.tagName, cls: (e.className?.baseVal ?? e.className ?? "").toString().slice(0, 40),
        pe: cs.pointerEvents, z: cs.zIndex, pos: cs.position, display: cs.display,
        rect: { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0) },
      };
    };
    const btn = document.querySelector(".settings-heading .icon-button");
    const tip = document.querySelector(".nami-tooltip");
    const atBtnTop = document.elementFromPoint(cx, 70);
    const tipRect = tip && tip.classList.contains("visible") ? tip.getBoundingClientRect() : null;
    const stack = document.elementsFromPoint(cx, 80).map(desc);
    const pointIn = (el) => el.y <= 80 && 80 <= el.y + el.h;
    return {
      btnHoverAtTop: btn.matches(":hover"),
      topHit: atBtnTop === btn ? "BTN" : `${atBtnTop?.tagName}.${atBtnTop?.className}`.slice(0, 30),
      tipVisible: Boolean(tipRect),
      tipDesc: tipRect ? desc(tip) : null,
      stackAtIcon: stack,
    };
  }, CX);
  console.log(JSON.stringify(dump, null, 2));
} finally { await browser.close(); }