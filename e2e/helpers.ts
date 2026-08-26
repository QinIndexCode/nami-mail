import { expect, type Page } from "@playwright/test";

export async function bootDemo(page: Page): Promise<void> {
  await page.goto("/?demo=1");
  await expect(page.locator("#nami-splash")).toHaveClass(/done/, { timeout: 15_000 });
  const terms = page.locator(".translation-terms-card");
  if (await terms.isVisible().catch(() => false)) {
    await terms.locator(".primary-button").click();
  }
  await expect(page.locator(".compose-button")).toBeVisible();
  await expect(page.locator(".message-item").first()).toBeVisible();
}
