// Collect the DOM layer stack and final rendered colours around the desktop
// window-control overlay so we can pin down what reads as a "protruding
// block" behind the top-right buttons.
// - Loads the real dev app in desktop mode + injected namiDesktop bridge.
// - Samples the element stack at points inside / beside the overlay.
// - Scans horizontal pixel rows across the top-right region and reports
//   segment-average colours so we can see whether the overlay area reveals
//   unfogged wallpaper (=> a visible block) vs blends with the header/rail.
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173/?demo=1&desktop=1&desktopSmoke=1&platform=win32";

const bridgeStubSource = `(() => {
  const on = () => () => {};
  const stub = {
    notify: async () => ({ shown: true }),
    copyVerificationCode: async () => ({ copied: true }),
    getUpdateStatus: async () => ({ schemaVersion: 2, phase: "unavailable", currentVersion: "0.3.0", targetVersion: null, percent: null, checkedAt: null, suppression: "disabled", remindAt: null, reason: "disabled", args: {} }),
    checkForUpdates: async () => undefined,
    downloadUpdate: async () => undefined,
    skipUpdate: async () => undefined,
    snoozeUpdate: async () => undefined,
    installUpdate: async () => ({ accepted: false }),
    setCustomNotificationSoundReady: () => {},
    onNewMail: on, onAutoReply: on, onOpenMessage: on, onComposeNew: on, onOpenInbox: on,
    onSettingsChanged: on, onUpdateStatus: on, onAgentConfirmationResult: on,
    minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
    isWindowMaximized: async () => false, onMaximizedChange: on,
  };
  Object.defineProperty(window, "namiDesktop", { value: stub, configurable: true });
})();`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const logs = [];
  page.on("console", (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.stack ?? err.message}`));
  page.on("requestfailed", (req) => logs.push(`[reqfail] ${req.url()} ${req.failure()?.errorText ?? ""}`));
  await page.addInitScript(bridgeStubSource);
  await page.goto(BASE, { waitUntil: "load" });
  try {
    await page.waitForSelector(".desktop-app[data-platform=win32] .window-bar .window-controls .window-control-close", { timeout: 20000 });
  } catch {
    const probe = await page.evaluate((logs) => {
      const root = document.querySelector("#root");
      return {
        href: location.href,
        search: location.search,
        rootChildren: root?.children.length ?? -1,
        rootHtml: root ? root.innerHTML.replace(/\s+/g, " ").slice(0, 300) : null,
        desktopApp: !!document.querySelector(".desktop-app"),
        appFrame: !!document.querySelector(".app-frame"),
        canvas: !!document.querySelector(".workspace-canvas"),
        bar: !!document.querySelector(".window-bar"),
        controls: document.querySelectorAll(".window-bar .window-controls").length,
        platform: document.querySelector(".desktop-app")?.getAttribute("data-platform"),
        hasBridge: !!window.namiDesktop,
        errors: logs,
      };
    }, logs);
    console.log("PROBE (desktop not active):", JSON.stringify(probe, null, 2));
    throw new Error("Desktop mode did not render window controls.");
  }
  await page.waitForTimeout(900);

  const data = await page.evaluate(() => {
    const rectObj = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    };
    const bar = document.querySelector(".desktop-app .window-bar");
    const header = document.querySelector(".desktop-app .column-header");
    const rail = document.querySelector(".desktop-app .icon-rail");
    const sidebar = document.querySelector(".desktop-app .sidebar");
    const can = document.querySelector(".workspace-canvas");
    const bg = document.querySelector(".workspace-background");
    const mailWs = document.querySelector(".desktop-app .mail-workspace");

    const cbg = (el) => (el ? getComputedStyle(el).backgroundColor : null);
    const cbgImg = (el) => (el ? getComputedStyle(el).backgroundImage : null);

    const stackAt = (x, y) =>
      document.elementsFromPoint(x, y).map((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          cls: el.className && typeof el.className === "string" ? el.className : "",
          elem: r.width || r.height ? { w: +r.width.toFixed(0), h: +r.height.toFixed(0) } : "none",
          position: s.position,
          z: s.zIndex,
          bg: s.backgroundColor,
          bgImg: s.backgroundImage.slice(0, 60),
          opacity: s.opacity,
        };
      });

    const floor = { r: 0, g: 0, b: 0, a: 1 };

    // Locate top full-screen fixed overlays polluting the screenshot (e.g.
    // a demo/onboarding veil) and hide them so we scan the true chrome.
    const veil = [];
    for (const el of document.querySelectorAll("div,section,main,aside,header,footer")) {
      const s = getComputedStyle(el);
      if (s.position !== "fixed") continue;
      const r = el.getBoundingClientRect();
      if (r.width < window.innerWidth - 4 || r.height < window.innerHeight - 4) continue;
      const z = s.zIndex;
      if (Number.isNaN(Number(z)) ? false : Number(z) >= 400) veil.push({ el, z: Number(z), cls: el.className || "", tag: el.tagName.toLowerCase(), txt: el.innerText?.slice(0, 40) });
    }
    veil.sort((a, b) => b.z - a.z);
    const hiddenVeils = [];
    for (const v of veil.slice(0, 3)) {
      v.el.remove();
      hiddenVeils.push({ z: v.z, cls: v.cls, tag: v.tag, txt: v.txt });
    }

    const layout = {
      windowWidth: +window.innerWidth.toFixed(1),
      bar: rectObj(bar),
      controls: rectObj(document.querySelector(".desktop-app .window-controls")),
      header: rectObj(header),
      rail: rectObj(rail),
      sidebar: rectObj(sidebar),
      mailWs: rectObj(mailWs),
      canvas: rectObj(can),
      canvasBg: cbg(can),
      wallpaperImg: cbgImg(bg),
      bgCssBg: bg ? getComputedStyle(bg).background : null,
      headerMarginRight: header ? getComputedStyle(header).marginRight : null,
      stackInsideBar: bar ? stackAt(bar.getBoundingClientRect().x + 20, bar.getBoundingClientRect().y + bar.getBoundingClientRect().height / 2) : [],
      stackBesideBar: header && bar
        ? stackAt(bar.getBoundingClientRect().x - 6, bar.getBoundingClientRect().y + bar.getBoundingClientRect().height / 2)
        : [],
      stackAboveRail: rail ? stackAt(rail.getBoundingClientRect().x + rail.getBoundingClientRect().width / 2, rail.getBoundingClientRect().y + 6) : [],
    };

    // Pixel row scans.
    return { layout: { ...layout, hiddenVeils }, floor, scans: [] };
  });

  // Screenshot via the chromium buffer, decode in the page, build row scans.
  await page.waitForTimeout(50);
  const shot = await page.locator(".workspace-canvas").screenshot({ type: "png" });
  const scansData = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.readAsDataURL(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" }));
    });
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const barEl = document.querySelector(".desktop-app .window-bar");
    const r = barEl.getBoundingClientRect();
    const rows = [
      { name: "header-mid", y: Math.min(img.height - 1, Math.max(0, Math.round(r.y + r.height * 0.5))) },
      { name: "rail-band", y: Math.min(img.height - 1, Math.max(0, Math.round(r.y + r.height + 12))) },
    ];
    const out = {};
    for (const row of rows) {
      const samples = [];
      for (let x = Math.max(0, img.width - 260); x < img.width; x += 1) {
        const d = ctx.getImageData(x, row.y, 1, 1).data;
        samples.push([x, [d[0], d[1], d[2], d[3]]]);
      }
      out[row.name] = { y: row.y, samples };
    }
    return out;
  }, shot.toString("base64"));

  // ---- Analysis ----
  const L = data.layout;
  console.log("==== window-bar region: DOM geometry ====");
  console.log("hiddenVeils (top fixed full-screen, now hidden):", JSON.stringify(L.hiddenVeils));
  for (const [name, obj] of Object.entries(L)) {
    if (name === "stackInsideBar" || name === "stackBesideBar" || name === "stackAboveRail") continue;
    console.log(`  ${name}: ${JSON.stringify(obj)}`);
  }
  console.log("headerMarginRight:", L.headerMarginRight);
  console.log("\n==== element stack INSIDE the window-bar (top->down) ====");
  for (const e of L.stackInsideBar) console.log("   ", JSON.stringify(e));
  console.log("\n==== element stack BESIDE the window-bar (top->down) ====");
  for (const e of L.stackBesideBar) console.log("   ", JSON.stringify(e));
  console.log("\n==== element stack at the rail top edge (top->down) ====");
  for (const e of L.stackAboveRail) console.log("   ", JSON.stringify(e));

  const avg = (samples) => {
    const n = samples.length;
    let r = 0, g = 0, b = 0;
    for (const [, c] of samples) { r += c[0]; g += c[1]; b += c[2]; }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), n };
  };

  const barRect = L.bar;
  const width = L.windowWidth;
  for (const [rowName, row] of Object.entries(scansData)) {
    const samples = row.samples;
    const barLeft = barRect ? Math.max(0, width - barRect.w) : width - 144;
    const overlay = samples.filter(([x]) => x >= barLeft);
    const beside = samples.filter(([x]) => x < barLeft);
    const farLeft = samples.filter(([x]) => x < barLeft - 60);
    const rightmost = samples.filter(([x]) => x >= width - 60);
    console.log(`\n==== row "${rowName}" y=${row.y} (overlay-left=${barLeft}) ====`);
    console.log("  overlay-area avg :", JSON.stringify(avg(overlay)));
    console.log("  beside-overlay avg:", JSON.stringify(avg(beside)));
    console.log("  far-right avg     (controls zone):", JSON.stringify(avg(rightmost)));
    if (farLeft.length) console.log("  left-of-overlay   avg:", JSON.stringify(avg(farLeft)));
    // drop big per-pixel dump; print a coarse ramp so we can eyeball edges.
    const step = Math.max(1, Math.floor(samples.length / 40));
    const ramp = [];
    for (let i = 0; i < samples.length; i += step) ramp.push([samples[i][0], samples[i][1][0], samples[i][1][1], samples[i][1][2]]);
    console.log("  color ramp (x, r, g, b):", JSON.stringify(ramp));
  }
} finally {
  await browser.close();
}