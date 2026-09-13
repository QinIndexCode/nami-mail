import { expect, type Page } from "@playwright/test";

/**
 * Boots the demo shell and clears the first-run translation-terms gate, then
 * waits for the message list.
 *
 * Kept separate from `bootDemo` because `.compose-button` lives inside the
 * sidebar, which is an off-canvas drawer below 820px — a spec that resizes the
 * viewport has to pick its own landmark instead of asserting a desktop one.
 */
export async function bootDemoShell(page: Page): Promise<void> {
  await page.goto("/?demo=1");
  await expect(page.locator("#nami-splash")).toHaveClass(/done/, { timeout: 15_000 });
  const terms = page.locator(".translation-terms-card");
  if (await terms.isVisible().catch(() => false)) {
    await terms.locator(".primary-button").click();
  }
  await expect(page.locator(".message-item").first()).toBeVisible();
}

/** Boots at a desktop width, where the sidebar (and its compose button) is on screen. */
export async function bootDemo(page: Page): Promise<void> {
  await bootDemoShell(page);
  await expect(page.locator(".compose-button")).toBeVisible();
}
