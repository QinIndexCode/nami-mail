// Optical-weight check: compare the drawn ink of the header back arrow vs
// the provider wrench icon. Chromium's getBBox({stroke:true}) is silently
// ignored here (a pure horizontal line reports height 0), so the ink
// envelope is computed as the union of the flat geometry boxes expanded by
// half the rendered stroke width on each side.
// Buttons are located by aria-label so the check is robust to header layout
// changes (scope picker, mobile-toggle, provider CTA, ...) reordering.
import { chromium } from "playwright";

const BASE = process.env.NAMI_WEB_BASE ?? "http://127.0.0.1:5173/";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator("#nami-splash").waitFor({ state: "detached", timeout: 8000 }).catch(() => undefined);
  const accept = page.getByRole("button", { name: "同意并继续" });
  if ((await accept.count()) > 0) {
    await accept.click();
    await page.waitForTimeout(600);
  }
  await page.getByRole("button", { name: "打开邮件助理" }).click();
  await page.waitForTimeout(1200);

  const measure = (svg) =>
    svg.evaluate((el) => {
      const els = Array.from(el.querySelectorAll("line,polyline,path,polygon,circle,rect"));
      const cs = getComputedStyle(el);
      let union = null;
      for (const g of els) {
        let b = null;
        try {
          b = g.getBBox({ stroke: true });
        } catch {
          b = g.getBBox();
        }
        if (!b) continue;
        union = union
          ? {
              x: Math.min(union.x, b.x),
              y: Math.min(union.y, b.y),
              w: Math.max(union.x + union.w, b.x + b.width) - Math.min(union.x, b.x),
              h: Math.max(union.y + union.h, b.y + b.height) - Math.min(union.y, b.y),
            }
          : { x: b.x, y: b.y, w: b.width, h: b.height };
      }
      const w = parseFloat(cs.width), h = parseFloat(cs.height);
      const sw = parseFloat(cs.strokeWidth) || 0;
      const su = (sw * 24) / w; // rendered stroke width in viewBox user units
      const toPx = (u) => (u * w) / 24; // viewBox 24 units → rendered px
      const ink = union
        ? { w: toPx(union.w + su), h: toPx(union.h + su), area: +(toPx(union.w + su) * toPx(union.h + su)).toFixed(1) }
        : null;
      return {
        svgPx: { w, h },
        strokeWidth: cs.strokeWidth,
        glyphCount: els.length,
        inkPx: ink ? { w: +ink.w.toFixed(2), h: +ink.h.toFixed(2), area: +ink.area.toFixed(1) } : null,
      };
    });

  const labels = {
    wrench: "模型设置",
    back: "关闭邮件助理",
  };
  const out = {};
  for (const [key, label] of Object.entries(labels)) {
    const btn = page.locator(`.agent-header-actions button[aria-label="${label}"]`);
    out[key] = { count: await btn.count(), ...(await measure(btn.locator("svg").first())) };
  }
  console.log(JSON.stringify(out, null, 2));

  const wrench = out.wrench.inkPx;
  const back = out.back.inkPx;
  const pct = (a, b) => Math.abs(a - b) / b;
  // The 20px/2.4 sizing was accepted by eye; the probe locks it in and keeps
  // the arrow's ink envelope from regressing below 20px sizing.
  const ok =
    out.back.count === 1 &&
    out.wrench.count === 1 &&
    out.back.svgPx.w === 20 &&
    out.back.strokeWidth.startsWith("2.4") &&
    !!wrench &&
    !!back &&
    back.w >= 13.5 &&
    back.h >= 13.5;
  console.log(
    `note: ink delta vs wrench: extent ${(pct(back?.w, wrench?.w) * 100).toFixed(1)}% / ${(pct(back?.h, wrench?.h) * 100).toFixed(1)}%, area ${(pct(back?.area, wrench?.area) * 100).toFixed(1)}%`
  );
  if (!ok) {
    console.error("FAIL: back arrow drifted from the accepted 20px/2.4 optical sizing");
    process.exitCode = 1;
  } else {
    console.log(`OK: back arrow ink envelope ${back.w}x${back.h}px at ${out.back.svgPx.w}px/${out.back.strokeWidth}; wrench ink ${wrench.w}x${wrench.h}px`);
  }
} finally {
  await browser.close();
}