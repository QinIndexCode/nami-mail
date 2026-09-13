// Focused geometry + hit-test at the settings close button and its icon.
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

  const report = await page.evaluate(() => {
    const out = {};
    const btn = document.querySelector(".settings-heading .icon-button");
    const header = document.querySelector(".settings-heading");
    if (!btn) return { error: "no btn" };
    const rb = btn.getBoundingClientRect();
    const svg = btn.querySelector("svg");
    const rs = svg?.getBoundingClientRect();
    const bcs = getComputedStyle(btn);
    const hcs = getComputedStyle(header);
    out.btnRect = { x0: rb.x, y0: rb.y, x1: rb.x + rb.width, y1: rb.y + rb.height };
    out.iconRect = rs ? { x0: rs.x, y0: rs.y, x1: rs.x + rs.width, y1: rs.y + rs.height } : null;
    out.btnStyle = { display: bcs.display, position: bcs.position, boxSizing: bcs.boxSizing, overflow: bcs.overflow, pe: bcs.pointerEvents, flex: bcs.flex, margin: bcs.margin, transform: bcs.transform };
    out.headerStyle = { display: hcs.display, justify: hcs.justifyContent, align: hcs.alignItems, position: hcs.position, zIndex: hcs.zIndex, overflow: hcs.overflow };
    // Does the button visually sit where its rect claims? Compare against header child boxes.
    const headerKids = [...header.children].map((c) => {
      const r = c.getBoundingClientRect();
      return { tag: c.tagName, cls: c.className, x0: +r.x.toFixed(1), y0: +r.y.toFixed(1), x1: +(r.x + r.width).toFixed(1), y1: +(r.y + r.height).toFixed(1) };
    });
    out.headerKids = headerKids;
    // Probe a set of (x,y): elementFromPoint vs button/icon containment.
    const px = rb.x + rb.width / 2;
    out.probes = [];
    for (const py of [rb.y - 6, rb.y + rb.height / 3, rb.y + rb.height / 2, rb.y + rb.height * 0.75, rb.y + rb.height + 4]) {
      const topEl = document.elementFromPoint(px, py);
      const stack = document.elementsFromPoint(px, py).slice(0, 4).map((e) => e === btn ? "BTN" : e === svg ? "SVG" : e === header ? "HEADER" : `${e.tagName}.${e.className}`.slice(0, 40));
      out.probes.push({ py: +py.toFixed(1), top: topEl === btn ? "BTN" : topEl === svg ? "SVG" : topEl === header ? "HEADER" : `${topEl?.tagName}.${topEl?.className}`.slice(0, 40), stack });
    }
    return out;
  });
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }