import { expect, test, type Locator } from "@playwright/test";
import { bootDemo } from "./helpers";

async function fillReact(locator: Locator, value: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.dispatchEvent("focus");
  await locator.evaluate((el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
    const prototype =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await expect(locator).toHaveValue(value);
}

test.describe("Nami Mail demo smoke", () => {
  test("app boots and renders the mail shell", async ({ page }) => {
    await page.goto("/?demo=1");

    await expect(page.locator("#nami-splash")).toHaveClass(/done/, { timeout: 15_000 });
    const terms = page.locator(".translation-terms-card");
    if (await terms.isVisible().catch(() => false)) {
      await terms.locator(".primary-button").click();
    }
    await expect(page.locator(".compose-button")).toBeVisible();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator("#mail-search")).toBeVisible();
    await expect(page.locator(".message-item").first()).toBeVisible();
    expect(await page.locator(".message-item").count()).toBeGreaterThanOrEqual(3);
  });

  test("opening a message shows the reader", async ({ page }) => {
    await bootDemo(page);

    await page.locator(".message-item", { hasText: "周末，在安静的地方见" }).first().click();
    await expect(page.locator(".reader-column")).toBeVisible();
    await expect(page.locator(".mail-title h2")).toContainText("周末，在安静的地方见");
    await expect(page.locator(".mail-content")).toBeVisible();
  });

  test("search filters the message list and can be cleared", async ({ page }) => {
    await bootDemo(page);
    const total = await page.locator(".message-item").count();

    await page.locator("#mail-search").fill("林澈");
    await expect(page.locator(".message-item")).toHaveCount(1);

    await page.locator(".search-clear").click();
    await expect(page.locator(".message-item")).toHaveCount(total);
  });

  test("settings opens, theme switches, and closes via Escape", async ({ page }) => {
    await bootDemo(page);

    await page.locator(".icon-rail button[aria-label='设置']").click();
    await expect(page.locator(".settings-modal")).toBeVisible();

    const darkOption = page.getByRole("button", { name: "深色 适合低光环境" });
    await darkOption.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.keyboard.press("Escape");
    await expect(page.locator(".settings-modal")).not.toBeVisible({ timeout: 5_000 });
  });

  test("compose sends a demo message and shows a toast", async ({ page }) => {
    await bootDemo(page);

    await page.locator(".compose-button").click();
    await expect(page.locator(".compose-card")).toBeVisible();

    await fillReact(page.locator("#compose-to"), "friend@example.com");
    await fillReact(page.locator("#compose-subject"), "E2E smoke");
    await fillReact(page.locator(".compose-body"), "Hello from the smoke test.");

    await page.locator(".compose-card button[type='submit']").click();
    await expect(page.locator(".compose-card")).not.toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".toast")).toBeVisible();
  });

  test("agent workspace opens from the launch button", async ({ page }) => {
    await bootDemo(page);

    await page.locator(".agent-launch-button").first().click();
    await expect(page.locator(".agent-workspace")).toBeVisible();
    await expect(page.locator(".agent-empty-state, .agent-configure-provider-button").first()).toBeVisible();
  });
});