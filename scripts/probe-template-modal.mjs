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

  // Open settings and navigate to templates section.
  await page.locator(".icon-rail button[aria-label='设置'], .icon-rail button[aria-label*='Settings']").first().click();
  await page.waitForTimeout(800);
  // Find the templates section / tab.
  const templatesTab = page.locator(".settings-nav button").filter({ hasText: /模板|Template/i }).first();
  if (await templatesTab.count()) {
    await templatesTab.click();
    await page.waitForTimeout(500);
  }
  console.log("TEMPLATES_VISIBLE", await page.locator(".templates-list, .template-row").count());

  // Click "add template".
  const addBtn = page.locator("button").filter({ hasText: /新增模板|Add template|新建模板/i }).first();
  console.log("ADD_BTN", await addBtn.count());
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(600);
    console.log("MODAL_VISIBLE", await page.locator(".template-editor-card").count());

    // Try closing via cancel button.
    const cancelBtn = page.locator(".template-editor-card button").filter({ hasText: /取消|Cancel/i }).first();
    console.log("CANCEL_BTN", await cancelBtn.count());
    if (await cancelBtn.count()) {
      await cancelBtn.click();
      await page.waitForTimeout(500);
      console.log("MODAL_AFTER_CANCEL", await page.locator(".template-editor-card").count());
    }

    // Try adding again, then close via backdrop.
    if (await addBtn.count()) {
      await addBtn.click();
      await page.waitForTimeout(600);
      console.log("MODAL_2", await page.locator(".template-editor-card").count());
      const backdrop = page.locator(".settings-modal-backdrop");
      if (await backdrop.count()) {
        await backdrop.click({ position: { x: 10, y: 10 } });
        await page.waitForTimeout(500);
        console.log("MODAL_AFTER_BACKDROP", await page.locator(".template-editor-card").count());
      }
    }
  } else {
    console.log("NO_ADD_BTN; listing nav buttons:", await page.locator(".settings-nav button").allInnerTexts().catch(() => []));
  }
} finally {
  await browser.close();
}
