// Deterministic reproduction of the "protruding block" behind the desktop
// window-control buttons. In background-active (wallpaper) mode the
// .desktop-app .window-bar overlay paints its own translucent
// panel-solid@15% layer over an already-panel-tinted region. If that
// additional layer changes the composite enough to read as a block, the
// sampled pixels inside the 144x66 overlay must differ from the region
// immediately to its left (same vertical band, same chrome behind it).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = await fs.readFile(path.join(projectRoot, "apps", "web", "src", "styles.css"), "utf8");

// Strong magenta wallpaper so alpha offsets are measurable; the real app uses
// arbitrary photos, so a saturated anchor is the honest test.
const mode = process.env.MODE === "background" ? " background-active" : "";
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>
  html,body{width:100%;height:100%;margin:0}
</style></head><body>
  <div class="workspace-canvas${mode}" id="canvas">
    <div class="workspace-background" style="background:#ff00ff"></div>
    <div class="app-frame desktop-app" id="frame" style="width:100%;height:100%;border-radius:0;border:0">
      <div class="window-bar" id="bar"></div>
      <div class="mail-workspace" id="ws" style="width:100%;height:100%"></div>
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.waitForTimeout(120);
  const shot = await page.locator("#canvas").screenshot();
  const { width, height } = await page.locator("#canvas").evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }));
  const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;

  const samples = await page.evaluate(async ({ dataUrl, width, height }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const yBand = 33; // inside the 66px-tall window-bar overlay band
    const px = (x) => {
      const d = ctx.getImageData(Math.max(0, Math.min(width - 1, x)), yBand, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    };
    return { inside: px(width - 20), outside: px(width - 170) };
  }, { dataUrl, width, height });

  const diff = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
  console.log(JSON.stringify({ viewport: { width, height }, ...samples, diff: diff(samples.inside, samples.outside) }, null, 2));
  const d = diff(samples.inside, samples.outside);
  console.log(`RESULT (${process.env.MODE ?? "default"}): inside vs outside channel-abs-diff = ${d} (0 => blends in, >0 => protruding block)`);
  process.exitCode = d > 8 ? 1 : 0;
} finally {
  await browser.close();
}