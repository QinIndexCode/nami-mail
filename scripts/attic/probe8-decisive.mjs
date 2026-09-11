// Decisive probe: at the failing icon point vs a working point, dump the full
// elementsFromPoint stack (tag/class/computed pe-z-position-opacity/rect) to
// identify exactly which element is painted above the close-button icon and
// blocks hover/click. Also report window-bar & modal rects for overlap check.
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
  await page.waitForTimeout(600);

  const data = await page.evaluate(() => {
    const describe = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const cls = typeof el.className === "string" ? (el.className || "") : ((el.className?.baseVal) || "");
      return {
        tag: el.tagName, cls: cls.slice(0, 46),
        pe: cs.pointerEvents, z: cs.zIndex, pos: cs.position, op: cs.opacity,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    };
    const btn = document.querySelector(".settings-heading .icon-button");
    const svg = btn.querySelector("svg");
    const rb = btn.getBoundingClientRect();
    const rs = svg.getBoundingClientRect();
    const icon = { cx: rs.x + rs.width / 2, cy: rs.y + rs.height / 2 };
    const belowCenter = { cx: rs.x + rs.width / 2, cy: rb.y + rb.height - 4 }; // button padding below icon
    const pick = (px, py) => ({
      at: { px, py },
      top: describe(document.elementFromPoint(px, py)),
      stack: document.elementsFromPoint(px, py).slice(0, 9).map(describe),
      btnHover: btn.matches(":hover"),
      inBtn: btn.contains(document.elementFromPoint(px, py)),
    });
    const windowBar = document.querySelector(".desktop-app .window-bar");
    const wbr = windowBar.getBoundingClientRect();
    const modal = document.querySelector(".settings-modal");
    const mr = modal.getBoundingClientRect();
    return {
      btnRect: { x: Math.round(rb.x), y: Math.round(rb.y), w: Math.round(rb.width), h: Math.round(rb.height) },
      iconRect: { x: Math.round(rs.x), y: Math.round(rs.y), w: Math.round(rs.width), h: Math.round(rs.height) },
      svgPe: getComputedStyle(svg).pointerEvents,
      windowBarRect: { x: Math.round(wbr.x), y: Math.round(wbr.y), w: Math.round(wbr.width), h: Math.round(wbr.height) },
      modalRect: { x: Math.round(mr.x), y: Math.round(mr.y), w: Math.round(mr.width), h: Math.round(mr.height) },
      atIcon: pick(icon.cx, icon.cy),        // failing region
      atBelow: pick(belowCenter.cx, belowCenter.cy), // working padding
    };
  });

  console.log(JSON.stringify(data, null, 2));
} finally {
  await browser.close();
}