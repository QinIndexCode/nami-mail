// Follow-up interaction regression for the agent multi-select bar fix:
// cancel collapses the bar (height 0), re-entering multi-select expands it
// fully, and selecting two conversations updates the count text.
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

  const enterMultiSelect = async () => {
    await page.locator(".agent-conversation-row").first().click({ button: "right" });
    await page.waitForTimeout(400);
    const menu = page.locator(".agent-context-menu");
    if ((await menu.count()) === 0) throw new Error("context menu did not open");
    const multi = menu.getByText("多选");
    if ((await multi.count()) === 1) await multi.click();
    else await menu.locator("button").nth(1).click();
    await page.waitForTimeout(500);
  };
  const wrapHeight = async () =>
    page.locator(".agent-selection-bar-wrap").evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const countText = async () =>
    page.locator(".agent-selection-count").evaluate((el) => el.textContent ?? "");

  const results = {};

  // 1) Fresh entry: bar expanded, count visible.
  await enterMultiSelect();
  results.entryHeight = await wrapHeight();
  results.entryCount = await countText();

  // 2) Cancel collapses the bar back to zero height.
  await page.locator(".agent-selection-cancel").click();
  await page.waitForTimeout(500);
  results.cancelledHeight = await wrapHeight();
  results.cancelledWrapCls = await page.locator(".agent-selection-bar-wrap").getAttribute("class");
  results.rowCheckHidden = await page.locator(".agent-row-check").count();

  // 3) Re-enter and select two rows: count updates, bar stays expanded.
  await enterMultiSelect();
  await page.locator(".agent-conversation-row").nth(1).locator(".agent-conversation-open").click();
  await page.waitForTimeout(300);
  results.afterSecondSelectCount = await countText();
  results.finalHeight = await wrapHeight();

  console.log(JSON.stringify(results, null, 2));
  await page.screenshot({ path: "output/selection-bar-multiselect.png" });

  const ok =
    results.entryHeight >= 40 &&
    results.entryCount.trim() === "已选 1" &&
    results.cancelledHeight === 0 &&
    results.rowCheckHidden === 0 &&
    results.afterSecondSelectCount.trim() === "已选 2" &&
    results.finalHeight >= 40;
  if (!ok) {
    console.error("FAIL: interaction regression");
    process.exitCode = 1;
  } else {
    console.log("OK: expand/cancel/re-enter/select all behave");
  }
} finally {
  await browser.close();
}