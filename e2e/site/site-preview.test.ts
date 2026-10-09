import { expect, test, type FrameLocator, type Page } from "@playwright/test";

const frameFor = (page: Page, view: "mail" | "agent"): FrameLocator =>
  page.frameLocator(`iframe[data-demo="${view}"]`);

async function loadSite(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
}

async function activateDemo(page: Page, view: "mail" | "agent"): Promise<FrameLocator> {
  const stage = page.locator(".demo-stage").filter({ has: page.locator(`iframe[data-demo="${view}"]`) });
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("data-state", "ready");
  await expect(stage.locator("iframe")).toHaveCSS("opacity", "1");
  const tourToggle = stage.locator("[data-demo-tour-toggle]");
  if (await tourToggle.isVisible()) {
    await expect(tourToggle).toHaveText("暂停演示");
    await tourToggle.click();
    await expect(stage).toHaveAttribute("data-tour-state", "paused");
  }
  // A fragment's initial smooth scroll may overlap the first scroll request.
  // Bring the whole parent viewport into view before exercising child controls.
  await stage.scrollIntoViewIfNeeded();
  return frameFor(page, view);
}

async function loadBothDemos(page: Page): Promise<{ mail: FrameLocator; agent: FrameLocator }> {
  await loadSite(page);
  const frames = page.locator("iframe[data-demo]");
  await expect(frames).toHaveCount(2);
  const mail = await activateDemo(page, "mail");
  const agent = await activateDemo(page, "agent");
  await expect(mail.locator(".message-item").first()).toBeVisible();
  await expect(agent.locator(".agent-workspace")).toBeVisible();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  return { mail, agent };
}

test("both demos load through their viewport gate without a first-run prompt", async ({ page }) => {
  const { mail, agent } = await loadBothDemos(page);

  await expect(mail.locator(".translation-terms-card")).toHaveCount(0);
  await expect(agent.locator(".translation-terms-card")).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(5);

  const brandImage = page.locator(".site-header .brand img.mark-light");
  await expect(brandImage).toHaveJSProperty("complete", true);
  expect(await brandImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
});

test("mail preview searches, clears, stars a sample message, and reset restores it", async ({ page }) => {
  await loadSite(page);
  const mail = await activateDemo(page, "mail");
  await expect(mail.locator(".message-item").first()).toBeVisible();
  const initialCount = await mail.locator(".message-item").count();

  await mail.locator(".search-toggle").click();
  await mail.locator("#mail-search").fill("林澈");
  await expect(mail.locator(".message-item")).toHaveCount(1);
  await mail.locator(".search-clear").click();
  await expect(mail.locator(".message-item")).toHaveCount(initialCount);

  const row = mail.locator(".message-list-row", { hasText: "周末，在安静的地方见" }).first();
  await row.hover();
  const star = row.locator(".row-quick-actions .row-quick-action").first();
  await expect(star).toHaveAttribute("aria-label", "添加星标");
  await star.focus();
  await star.press("Enter");
  await expect(row.locator(".row-quick-action.active-star")).toBeVisible();

  await page.locator('[data-demo-reset="mail"]').click();
  await expect(mail.locator("#mail-search")).toHaveValue("");
  await row.hover();
  await expect(row.locator(".row-quick-actions .row-quick-action").first()).toHaveAttribute("aria-label", "添加星标");
});

test("site theme and language controls update the client, title, description, and canvas token", async ({ page }) => {
  const { mail } = await loadBothDemos(page);

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => mail.locator("html").getAttribute("data-theme")).toBe("light");
  const canvas = await mail.locator(".workspace-canvas").evaluate((element) => ({
    token: getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),
    rendered: getComputedStyle(element).backgroundColor,
  }));
  expect(canvas).toEqual({ token: "#f4f5f8", rendered: "rgb(244, 245, 248)" });

  await page.locator("#lang-toggle").click();
  await expect(page).toHaveTitle("Nami Mail · A local-first mail app for Windows");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "A local-first Windows mail app. Bring your accounts into one inbox, search your mail locally, and optionally use an AI assistant to find messages and draft replies.",
  );
  await expect.poll(() => mail.locator("html").getAttribute("lang")).toBe("en-US");
  await expect.poll(() => mail.locator("html").getAttribute("data-theme")).toBe("light");
});

test("agent citations show sample mail without leaving the assistant and restore focus on close", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  await loadSite(page);
  const agent = await activateDemo(page, "agent");
  await expect(agent.locator(".agent-workspace")).toContainText("季度回顾会议准备");
  await expect(agent.locator(".agent-citation-card").first()).toBeAttached();
  await agent.locator(".agent-citations-toggle").click();
  const citation = agent.locator(".agent-citation-card").first();
  await expect(citation).toBeVisible();
  const citedSubject = (await citation.locator("strong").innerText()).split(" · ").pop() || "";
  await citation.click();

  const source = agent.locator(".demo-source-card");
  await expect(source).toBeVisible();
  await expect(source.locator("#demo-source-title")).toContainText(citedSubject);
  await expect(source.locator(".mail-content")).toBeVisible();
  await expect(agent.locator(".agent-workspace")).toBeVisible();
  await expect(agent.locator(".mail-shell")).toHaveClass(/has-agent-open/);
  await expect(agent.getByRole("button", { name: "关闭邮件助理", exact: true })).toHaveCount(0);
  await source.getByRole("button", { name: "关闭", exact: true }).press("Escape");
  await expect(source).toHaveCount(0);
  await expect(citation).toBeFocused();
  await expect(agent.locator(".agent-workspace")).toBeVisible();
  expect(apiRequests).toEqual([]);
});

test("offscreen demos make no requests and load only after the main surface enters the viewport", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 600 });
  const demoRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/demo/")) demoRequests.push(request.url());
  });
  await loadSite(page);
  const mailFrame = page.locator('iframe[data-demo="mail"]');
  const agentFrame = page.locator('iframe[data-demo="agent"]');
  const mailStage = page.locator(".hero-surface .demo-stage");
  await expect(mailStage).toBeVisible();
  await expect(mailStage.locator(".nami-splash-content")).toBeVisible();
  await expect(mailStage.locator(".nami-splash-loader")).toBeVisible();
  await expect(mailStage.locator("[data-demo-retry]")).toBeHidden();
  await expect(mailStage.getByRole("button")).toHaveCount(0);
  await expect(mailFrame).not.toHaveAttribute("src");
  await expect(agentFrame).not.toHaveAttribute("src");
  await page.locator("#lang-toggle").click();
  await page.locator("#theme-toggle").click();
  await expect(mailFrame).not.toHaveAttribute("src");
  expect(demoRequests).toEqual([]);
  const beforeHeight = (await mailStage.boundingBox())!.height;

  await mailStage.scrollIntoViewIfNeeded();
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await expect(mailStage).toHaveAttribute("data-state", "ready");
  await expect(mailFrame).toHaveAttribute("src", /theme=light&locale=en-US&view=mail$/);
  expect((await mailStage.boundingBox())!.height).toBe(beforeHeight);
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(beforeScroll, 0);
  await expect(agentFrame).not.toHaveAttribute("src");
  await expect(frameFor(page, "mail").locator(".agent-launch-button")).toHaveCount(0);

  const started = demoRequests.length;
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await activateDemo(page, "mail");
  expect(demoRequests.length).toBe(started);
});

test("mail preview stays in mail when opening a message", async ({ page }) => {
  await loadSite(page);
  const mail = await activateDemo(page, "mail");
  await expect(mail.locator(".agent-launch-button")).toHaveCount(0);
  await mail.locator(".message-item").filter({ hasText: "周末，在安静的地方见" }).click();
  await expect(mail.locator(".mail-title h2")).toContainText("周末，在安静的地方见");
  await expect(mail.locator(".agent-launch-button")).toHaveCount(0);
  await expect(mail.locator(".agent-workspace")).toHaveCount(0);
});

test("demos start automatically on visibility without IntersectionObserver", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.addInitScript(() => { Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }); });
  await loadSite(page);
  const stage = page.locator(".hero-surface .demo-stage");
  await expect(stage.getByRole("button")).toHaveCount(0);
  await expect(page.locator('iframe[data-demo="mail"]')).not.toHaveAttribute("src");
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("data-state", "ready");
  await expect(frameFor(page, "mail").locator(".message-item").first()).toBeVisible();
  await expect(page.locator('iframe[data-demo="agent"]')).not.toHaveAttribute("src");
});

test("a failed demo preserves its height and can be retried", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.clock.install();
  let failRequest = true;
  await page.route("**/demo/?**", (route) => failRequest ? route.abort() : route.continue());
  await loadSite(page);
  const stage = page.locator(".hero-surface .demo-stage");
  const height = (await stage.boundingBox())!.height;
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("data-state", "loading");
  await page.clock.fastForward(26_000);
  await expect(stage).toHaveAttribute("data-state", "error");
  expect((await stage.boundingBox())!.height).toBe(height);

  failRequest = false;
  await stage.getByRole("button", { name: "重试", exact: true }).click();
  await expect(stage).toHaveAttribute("data-state", "ready");
  await expect(frameFor(page, "mail").locator(".message-item").first()).toBeVisible();
});

test("a direct assistant link leaves the inbox unloaded and keeps source reading inside the mobile demo", async ({ page }) => {
  // This test checks focus and source reading, independently of anchor motion.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#agent");
  const agent = await activateDemo(page, "agent");
  await expect(page.locator('iframe[data-demo="mail"]')).not.toHaveAttribute("src");
  await agent.locator(".agent-citations-toggle").click();
  const beforeSourceScroll = await page.evaluate(() => window.scrollY);
  await agent.locator(".agent-citation-card").first().click();
  const source = agent.locator(".demo-source-card");
  await expect(source).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(beforeSourceScroll, 0);
  const size = await source.evaluate((element) => ({ width: element.getBoundingClientRect().width, viewport: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  expect(size.width).toBeLessThanOrEqual(size.viewport);
  expect(size.overflow).toBeLessThanOrEqual(1);
  await source.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(source).toHaveCount(0);
  await expect(agent.locator(".mail-shell")).toHaveClass(/has-agent-open/);
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(beforeSourceScroll, 0);
});

test("390px layout opens and closes its menu and keeps both demos within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { mail, agent } = await loadBothDemos(page);
  const menu = page.locator(".mobile-navigation");
  await expect(menu.locator("summary")).toBeVisible();
  await menu.locator("summary").click();
  await expect(menu).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open", "");

  for (const frame of [mail, agent]) {
    const dimensions = await frame.locator("body").evaluate((body) => ({
      client: document.documentElement.clientWidth,
      scroll: Math.max(body.scrollWidth, document.documentElement.scrollWidth),
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
  }

  // Bring the whole embedded viewport into view before reaching its lower rows.
  await page.locator(".hero-surface .demo-stage").scrollIntoViewIfNeeded();
  await mail.getByRole("button", { name: "打开菜单", exact: true }).click();
  await expect(mail.locator(".sidebar.open")).toBeVisible();
  const footer = mail.locator(".sidebar-footer");
  // Measure inside the iframe: reaching a row may scroll the homepage itself.
  const footerTop = await footer.evaluate((element) => element.getBoundingClientRect().top);
  const studio = mail.getByRole("button", { name: "studio@gmail.com", exact: true });
  await studio.scrollIntoViewIfNeeded();
  const row = await studio.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { height: rect.height, bottom: rect.bottom };
  });
  expect(row.height).toBeGreaterThanOrEqual(48);
  expect(row.bottom).toBeLessThanOrEqual(footerTop + 1);
  expect(await footer.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(footerTop, 1);
  await studio.click();
  await expect(mail.locator(".sidebar.open")).toHaveCount(0);
});

test("standalone demo adds safe defaults before loading the client and makes no API requests", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  await page.goto("/demo/");
  await expect(page).toHaveURL(/\/demo\/\?demo=1&preview=site&theme=dark&locale=zh-CN&view=mail$/);
  await expect(page.locator("#nami-splash")).toBeHidden();
  await expect(page.locator(".message-item").first()).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    "content",
    /connect-src 'none'/,
  );
  const appLogo = page.locator(".brand-row img.brand-mark-image:visible");
  await expect(appLogo).toBeVisible();
  await expect.poll(() => appLogo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(apiRequests).toEqual([]);
});

for (const width of [1440, 1000]) {
  test(`${width}px homepage keeps complete account rows above the demo footer`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { mail } = await loadBothDemos(page);
    if (width === 1000) {
      await page.locator("#lang-toggle").click();
      await page.locator("#theme-toggle").click();
      await expect(mail.locator("html")).toHaveAttribute("lang", "en-US");
      await expect(mail.locator("html")).toHaveAttribute("data-theme", "light");
    }
    const accounts = mail.locator(".account-list");
    await expect(accounts.locator(".account-tree-main")).toHaveCount(2);

    const layout = await mail.locator(".sidebar").evaluate((sidebar) => {
      const content = sidebar.querySelector(".sidebar-content")!.getBoundingClientRect();
      const footer = sidebar.querySelector(".sidebar-footer")!.getBoundingClientRect();
      const rows = Array.from(sidebar.querySelectorAll(".account-list > button, .account-tree-main"))
        .map((row) => { const rect = row.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; });
      return { width: sidebar.getBoundingClientRect().width, content, footer, rows };
    });
    expect(layout.width).toBe(width === 1440 ? 238 : 220);
    expect(layout.rows).toHaveLength(3);
    for (const row of layout.rows) {
      expect(row.height).toBeGreaterThanOrEqual(48);
      expect(row.top).toBeGreaterThanOrEqual(layout.content.top);
      expect(row.bottom).toBeLessThanOrEqual(layout.content.bottom + 1);
    }
    expect(layout.content.bottom).toBeLessThanOrEqual(layout.footer.top + 1);
  });
}

test("short client windows scroll accounts and folder trees without moving the footer", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 480 });
  await page.goto("/demo/");
  await expect(page.locator(".account-tree-main")).toHaveCount(2);
  const content = page.locator(".sidebar-content");
  const footer = page.locator(".sidebar-footer");
  const initialFooter = await footer.boundingBox();
  expect(await content.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);

  // Account rows retain their size; scrolling, rather than flex compression,
  // makes the last account and its folder controls reachable.
  const studio = page.getByRole("button", { name: "studio@gmail.com", exact: true });
  await studio.scrollIntoViewIfNeeded();
  const rowBox = await studio.boundingBox();
  const contentBox = await content.boundingBox();
  expect(rowBox!.height).toBeGreaterThanOrEqual(48);
  expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(contentBox!.y + contentBox!.height + 1);
  expect(await footer.boundingBox()).toEqual(initialFooter);

  await studio.click();
  await expect(page.locator(".folder-list.show")).toBeVisible();
  await page.getByRole("button", { name: "切换到多账户文件夹树" }).click();
  await expect(page.locator('.account-list[data-folder-mode="tree"]')).toBeVisible();
  const studioTree = page.locator(".account-tree-item").filter({ has: studio });
  await studioTree.locator(".account-tree-toggle").click();
  const folder = studioTree.getByRole("button", { name: "所有邮件", exact: true });
  await folder.scrollIntoViewIfNeeded();
  await expect(folder).toBeVisible();
  const folderBox = await folder.boundingBox();
  expect(folderBox!.y + folderBox!.height).toBeLessThanOrEqual(initialFooter!.y + 1);
  expect(await footer.boundingBox()).toEqual(initialFooter);
  await folder.click();
  await expect(folder).toHaveAttribute("aria-pressed", "true");
});
