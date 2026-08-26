import { expect, test } from "@playwright/test";
import { bootDemo } from "./helpers";

test.describe("Nami Mail message interactions", () => {
  test("hover reveals quick actions and starring toggles the row state", async ({ page }) => {
    await bootDemo(page);

    const row = page.locator(".message-list-row", { hasText: "周末，在安静的地方见" }).first();
    await row.hover();

    const actions = row.locator(".row-quick-actions");
    const star = actions.locator(".row-quick-action").first();
    // opacity lives on the actions container; the buttons themselves always
    // compute to opacity 1 and only hide via the parent.
    await expect(actions).toHaveCSS("opacity", "1");
    await expect(star).toHaveAttribute("aria-label", "添加星标");
    await star.click();
    await expect(row.locator(".row-quick-action.active-star")).toBeVisible();
    await expect(actions.locator(".row-quick-action").first()).toHaveAttribute("aria-label", "取消星标");

    // Leaving the row hides the actions again.
    await page.locator(".sidebar").hover();
    await expect(actions).toHaveCSS("opacity", "0");
  });

  test("right-click opens the context menu and archiving removes the row", async ({ page }) => {
    await bootDemo(page);

    const row = page.locator(".message-item", { hasText: "周末，在安静的地方见" }).first();
    const countBefore = await page.locator(".message-item").count();
    await row.click({ button: "right" });

    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await menu.locator(".context-menu-item", { hasText: "归档" }).click();
    await expect(menu).not.toBeVisible();
    await expect(page.locator(".message-item")).toHaveCount(countBefore - 1);
  });

  test("long conversation collapses to first and last message and can be expanded", async ({ page }) => {
    await bootDemo(page);

    await page.locator(".message-item", { hasText: "Re: launch checklist" }).first().click();
    await expect(page.locator(".thread-strip")).toBeVisible();

    const toggle = page.locator(".thread-strip-toggle");
    await expect(toggle).toBeVisible();

    // Reach the expanded state regardless of the persisted collapse pref.
    const items = page.locator(".thread-strip-item");
    for (let attempt = 0; attempt < 2 && (await items.count()) !== 6; attempt += 1) {
      await toggle.click();
    }
    await expect(items).toHaveCount(6);

    await toggle.click();
    await expect(items).toHaveCount(2);
    await expect(page.locator(".thread-strip-fold")).toBeVisible();
  });
});