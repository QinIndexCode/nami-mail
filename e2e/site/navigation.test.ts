import { expect, test, type Page } from "@playwright/test";

const labels = {
  zh: ["首页", "功能", "邮件助理", "本地与隐私", "文档", "GitHub ↗"],
  en: ["Home", "Features", "Assistant", "Privacy", "Docs", "GitHub ↗"],
};

async function expectNavigation(page: Page, language: "zh" | "en", current: string): Promise<void> {
  const navigation = page.locator(".site-nav");
  await expect(navigation).toBeVisible();
  expect(await navigation.locator("a").evaluateAll((links) => links.map((link) => (link as HTMLElement).innerText.trim()))).toEqual(labels[language]);
  await expect(navigation.locator("[aria-current]")).toHaveCount(1);
  await expect(navigation.locator(`[data-nav="${current}"]`)).toHaveAttribute("aria-current", current === "home" || current === "docs" ? "page" : "location");
}

async function headerLayout(page: Page) {
  return page.locator(".site-header").evaluate((header) => {
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    };
    return {
      header: rect(header),
      brand: rect(header.querySelector(".brand")!),
      navigation: rect(header.querySelector(".site-nav")!),
      actions: rect(header.querySelector(".header-actions")!),
      destinations: Array.from(header.querySelectorAll<HTMLAnchorElement>(".site-nav a"), (link) => link.href),
    };
  });
}

function expectSameHeader(actual: Awaited<ReturnType<typeof headerLayout>>, reference: Awaited<ReturnType<typeof headerLayout>>): void {
  expect(actual.destinations).toEqual(reference.destinations);
  for (const region of ["header", "brand", "navigation", "actions"] as const) {
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(actual[region][dimension], `${region} ${dimension}`).toBeCloseTo(reference[region][dimension], 0);
    }
  }
}

test("homepage, docs overview, and nested articles retain the same global header", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNavigation(page, "zh", "home");
  const initial = await headerLayout(page);

  await page.locator('.site-nav [data-nav="docs"]').click();
  await expect(page).toHaveURL(/\/docs\/$/);
  await expectNavigation(page, "zh", "docs");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expectSameHeader(await headerLayout(page), initial);

  await page.locator('.quick-links[data-lang="zh"] a[href="INSTALLING.zh-CN.html"]').click();
  await expectNavigation(page, "zh", "docs");
  expectSameHeader(await headerLayout(page), initial);

  await page.goto("/docs/agent/usage.zh-CN.html");
  await expectNavigation(page, "zh", "docs");
  expectSameHeader(await headerLayout(page), initial);
  await page.locator('.site-nav [data-nav="privacy"]').click();
  await expect(page).toHaveURL(/\/#privacy$/);
  await expectNavigation(page, "zh", "privacy");
  await expect(page.locator("#privacy")).toBeInViewport();

  await page.locator('.site-nav [data-nav="home"]').click();
  await expect(page).toHaveURL(/\/$/);
  await expectNavigation(page, "zh", "home");
  expectSameHeader(await headerLayout(page), initial);
});

test("language and theme persist through docs, counterpart links, and return to the homepage", async ({ page }) => {
  await page.goto("/");
  await page.locator("#lang-toggle").click();
  await page.locator("#theme-toggle").click();
  await expectNavigation(page, "en", "home");
  const english = await headerLayout(page);

  await page.locator('.site-nav [data-nav="docs"]').click();
  await expect(page).toHaveTitle("Documentation · Nami Mail");
  await expectNavigation(page, "en", "docs");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expectSameHeader(await headerLayout(page), english);
  await page.locator('.quick-links[data-lang="en"] a[href="INSTALLING.en.html"]').click();
  await expectNavigation(page, "en", "docs");

  await page.locator("#lang-toggle").click();
  await expect(page).toHaveURL(/INSTALLING\.zh-CN\.html$/);
  await expectNavigation(page, "zh", "docs");
  await page.locator('.site-nav [data-nav="home"]').click();
  await expectNavigation(page, "zh", "home");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

for (const width of [390, 850]) {
  test(`${width}px navigation keeps the same menu across the homepage and docs`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const menu = page.locator(".mobile-navigation");
    await expect(page.locator(".site-nav")).toBeHidden();
    await menu.locator("summary").click();
    const initialLinks = await menu.locator("nav a").allInnerTexts();
    await menu.locator('[data-nav="docs"]').click();
    await expect(page).toHaveURL(/\/docs\/$/);
    await expect(menu).not.toHaveAttribute("open", "");
    await expect(page.locator(".site-nav")).toBeHidden();

    await menu.locator("summary").click();
    expect(await menu.locator("nav a").allInnerTexts()).toEqual(initialLinks);
    await expect(menu.locator('[data-nav="docs"]')).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await expect(menu).not.toHaveAttribute("open", "");
    await expect(menu.locator("summary")).toBeFocused();

    await page.goto("/docs/agent/usage.zh-CN.html");
    await menu.locator("summary").click();
    const header = await page.locator(".site-header").boundingBox();
    expect(header!.height).toBe(65);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await menu.locator('[data-nav="features"]').click();
    await expect(page).toHaveURL(/\/#features$/);
    await expect(menu).not.toHaveAttribute("open", "");
    await menu.locator("summary").click();
    await expect(menu.locator('[data-nav="features"]')).toHaveAttribute("aria-current", "location");
  });
}

test.describe("navigation without JavaScript", () => {
  test.use({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });

  test("native menus link nested documents back to the homepage", async ({ page }) => {
    await page.goto("/docs/agent/usage.zh-CN.html");
    const menu = page.locator(".mobile-navigation");
    await menu.locator("summary").click();
    await expect(menu).toHaveAttribute("open", "");
    await expect(menu.locator('[data-nav="docs"]')).toHaveAttribute("aria-current", "page");
    await menu.locator('[data-nav="home"]').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".hero-surface .demo-stage")).toBeHidden();
    await expect(page.locator('.hero-surface noscript img[data-lang="zh"]')).toBeVisible();
    await menu.locator("summary").click();
    await expect(menu.locator('[data-nav="home"]')).toHaveAttribute("aria-current", "page");
  });
});
