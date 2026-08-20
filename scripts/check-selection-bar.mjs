// One-off geometry probe for the agent conversation multi-select bar.
// Opens the web dev server, enters the agent panel, right-clicks the first
// conversation row, picks "multi-select", then measures the selection bar
// wrap/bar/count rectangles and the first row overlap. Exits non-zero when
// the count text is clipped by the wrap (the bug being verified).
import { chromium } from "playwright";

const BASE = process.env.NAMI_WEB_BASE ?? "http://127.0.0.1:5173/";

const rect = (r) => (r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom ?? 0) } : null);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // First visit may show the startup splash and the terms dialog; dismiss both.
  await page.locator("#nami-splash").waitFor({ state: "detached", timeout: 8000 }).catch(() => undefined);
  const accept = page.getByRole("button", { name: "同意并继续" });
  if ((await accept.count()) > 0) {
    await accept.click();
    await page.waitForTimeout(600);
  }

  const openAgent = page.getByRole("button", { name: "打开邮件助理" });
  await openAgent.click();
  await page.waitForTimeout(1200);

  // Right-click the first conversation row: its row div hosts onContextMenu.
  await page.locator(".agent-conversation-row").first().click({ button: "right" });
  await page.waitForTimeout(400);

  const menu = page.locator(".agent-context-menu");
  if ((await menu.count()) === 0) throw new Error("context menu did not open");
  const multiSelectItem = menu.getByText("多选");
  if ((await multiSelectItem.count()) !== 1) {
    // Fall back to the menu button list order (delete / multi-select / ...).
    await menu.locator("button").nth(1).click();
  } else {
    await multiSelectItem.click();
  }
  await page.waitForTimeout(500);

  const wrap = await page.locator(".agent-selection-bar-wrap").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), cls: el.className, overflow: cs.overflow, maxHeight: cs.maxHeight, flexShrink: cs.flexShrink, flex: cs.flex };
  });
  const bar = await page.locator(".agent-selection-bar").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
  });
  const count = await page.locator(".agent-selection-count").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), text: el.textContent };
  });
  const firstRow = await page.locator(".agent-conversation-row").first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
  });
  const list = await page.locator(".agent-conversation-list").evaluate((el) => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));

  const countFullyInsideWrap = count && wrap ? count.y >= wrap.y && count.y + count.h <= wrap.y + wrap.h : false;
  const barFullyInsideWrap = bar && wrap ? bar.y >= wrap.y && bar.bottom <= wrap.y + wrap.h : false;
  const rowOverlapsBar = firstRow && bar ? firstRow.y < bar.bottom && firstRow.bottom > bar.y : false;

  const result = { wrap, bar, count, firstRow, list, countFullyInsideWrap, barFullyInsideWrap, rowOverlapsBar };
  console.log(JSON.stringify(result, null, 2));

  await page.screenshot({ path: "scripts/selection-bar-check.png" });
  if (!countFullyInsideWrap || !barFullyInsideWrap) {
    console.error("FAIL: selection bar content is clipped by its wrap");
    process.exitCode = 1;
  } else {
    console.log("OK: selection bar fully visible");
  }
} finally {
  await browser.close();
}