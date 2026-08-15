import { chromium } from "playwright";

const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#nami-splash.done", { timeout: 20_000 }).catch(() => {});
  const terms = page.locator(".translation-terms-card");
  if (await terms.isVisible().catch(() => false)) await terms.locator(".primary-button").click();
  await page.waitForSelector(".message-item", { timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.locator(".message-item").first().click();
  await page.waitForTimeout(1000);

  await page.locator(".translation-action").first().click();
  let done = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    if (!(await page.locator(".translation-panel.is-loading").count())) { done = true; break; }
  }
  console.log("DONE", done);

  const note = await page.locator(".translation-inline-note").count();
  const noteText = note ? await page.locator(".translation-inline-note span").innerText() : "";
  const resultCount = await page.locator(".translation-result").count();
  const textAreaCount = await page.locator(".translation-text").count();
  const panelH = await page.locator(".translation-panel").evaluate((el) => Math.round(el.getBoundingClientRect().height));
  console.log(JSON.stringify({ note, noteText, resultCount, textAreaCount, panelH }));

  // Hide translation -> original restored, note gone.
  if (note) {
    await page.locator(".translation-inline-note button").click();
    await page.waitForTimeout(600);
    const afterHide = await page.evaluate(() => {
      const el = document.querySelector(".mail-html");
      return { cjk: (el.textContent.match(/[\u4e00-\u9fff]/g) || []).length };
    });
    console.log("AFTER_HIDE", JSON.stringify(afterHide));
  }
} finally {
  await browser.close();
}
