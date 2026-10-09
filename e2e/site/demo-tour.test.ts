import { expect, test, type FrameLocator, type Page } from "@playwright/test";

const frameFor = (page: Page, view: "mail" | "agent"): FrameLocator =>
  page.frameLocator(`iframe[data-demo="${view}"]`);

async function loadSite(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
}

async function readyTour(page: Page, view: "mail" | "agent") {
  const stage = page.locator(".demo-stage").filter({ has: page.locator(`iframe[data-demo="${view}"]`) });
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("data-state", "ready");
  const frame = frameFor(page, view);
  await expect(frame.locator(view === "mail" ? ".message-item" : ".agent-workspace").first()).toBeVisible();
  return { stage, frame, toolbar: stage.locator("xpath=ancestor::figure") };
}

test("mail tour searches and reads the real sample message, uses close-up, finishes once, and makes no API requests", async ({ page }) => {
  await page.clock.install();
  const apiRequests: string[] = [];
  const mailScripts: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
    if (request.resourceType() === "script") {
      try {
        if (request.frame().url().includes("/demo/")) mailScripts.push(request.url());
      } catch {
        // Ignore a script request whose owning frame has already detached.
      }
    }
  });
  await loadSite(page);
  const { stage, frame, toolbar } = await readyTour(page, "mail");
  expect(mailScripts.length).toBeGreaterThan(0);
  expect(mailScripts.join("\n")).not.toMatch(/SettingsModal|AccountsDialog|AttachmentPreviewModal/i);

  await page.clock.runFor(1100);
  await expect(stage).toHaveAttribute("data-tour-state", "playing");
  await expect(stage).toHaveAttribute("data-tour-step", "overview");
  await page.clock.runFor(1800);
  await page.clock.runFor(650);
  await expect(stage).toHaveAttribute("data-tour-step", "search");
  await expect(frame.locator("#mail-search")).toHaveValue("lin@example.com");
  await page.clock.runFor(800);
  expect(Number(await stage.evaluate((element) => getComputedStyle(element).getPropertyValue("--demo-tour-scale")))).toBeGreaterThan(1);
  const pointer = stage.locator(".demo-tour-pointer");
  await expect(pointer).toHaveAttribute("data-visible", "true");
  await expect(stage.locator(".demo-tour-focus")).toHaveCount(0);
  expect(await pointer.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
  await expect.poll(() => stage.evaluate((element) => {
    const frame = getComputedStyle(element.querySelector(".demo-frame")!).transform;
    const pointer = getComputedStyle(element.querySelector(".demo-tour-pointer")!).transform;
    const a = new DOMMatrixReadOnly(frame).toFloat64Array();
    const b = new DOMMatrixReadOnly(pointer).toFloat64Array();
    return Math.max(...a.map((value, index) => Math.abs(value - b[index])));
  })).toBeLessThan(0.01);
  const closeup = toolbar.locator("[data-demo-closeup]");
  await closeup.click();
  await expect(closeup).toHaveAttribute("aria-pressed", "false");
  expect(await stage.evaluate((element) => getComputedStyle(element).getPropertyValue("--demo-tour-scale").trim())).toBe("1");
  await closeup.click();
  await expect(closeup).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => stage.evaluate((element) => Number(getComputedStyle(element).getPropertyValue("--demo-tour-scale")))).toBeGreaterThan(1);

  await page.clock.runFor(1600);
  await page.clock.runFor(650);
  await expect(stage).toHaveAttribute("data-tour-step", "read");
  await expect(frame.locator(".mail-title h2")).toContainText("周末，在安静的地方见");
  await page.clock.runFor(3400);
  await expect(stage).toHaveAttribute("data-tour-state", "complete");
  await expect(toolbar.locator("[data-demo-tour-toggle]")).toHaveText("重播演示");
  await expect(frame.locator(".mail-title h2")).toContainText("周末，在安静的地方见");
  await page.clock.runFor(15_000);
  await expect(stage).toHaveAttribute("data-tour-state", "complete");
  await expect(frame.locator(".mail-title h2")).toContainText("周末，在安静的地方见");
  expect(apiRequests).toEqual([]);
});

test("typing in mail pauses the tour, preserves the visitor query, and resets close-up", async ({ page }) => {
  await page.clock.install();
  await loadSite(page);
  const { stage, frame } = await readyTour(page, "mail");
  await page.clock.runFor(1100);
  await expect(stage).toHaveAttribute("data-tour-step", "overview");
  await page.clock.runFor(1800);
  await page.clock.runFor(650);
  await expect(stage).toHaveAttribute("data-tour-step", "search");
  const search = frame.locator("#mail-search");
  await search.fill("my own search");
  await expect(stage).toHaveAttribute("data-tour-state", "paused");
  await expect(search).toHaveValue("my own search");
  await expect(stage).toHaveAttribute("data-tour-pause", "interaction");
  expect(await stage.evaluate((element) => getComputedStyle(element).getPropertyValue("--demo-tour-scale").trim())).toBe("1");
  await expect(stage.locator(".demo-tour-pointer")).toHaveAttribute("data-visible", "false");
  await page.clock.runFor(15_000);
  await expect(stage).toHaveAttribute("data-tour-state", "paused");
  await expect(search).toHaveValue("my own search");
});

test("agent tour opens citations and the original source while staying in the assistant", async ({ page }) => {
  await page.clock.install();
  await loadSite(page);
  const { stage, frame } = await readyTour(page, "agent");
  await page.clock.runFor(1100);
  await expect(stage).toHaveAttribute("data-tour-step", "answer");
  await page.clock.runFor(2800);
  await page.clock.runFor(650);
  await expect(stage).toHaveAttribute("data-tour-step", "citations");
  await expect(frame.locator(".agent-citations-sidebar")).toHaveClass(/expanded/);
  await page.clock.runFor(2200);
  await page.clock.runFor(650);
  await expect(stage).toHaveAttribute("data-tour-step", "source");
  await expect(frame.locator(".demo-source-card")).toBeVisible();
  await expect(frame.locator(".agent-workspace")).toBeVisible();
  await expect(frame.locator(".mail-shell")).toHaveClass(/has-agent-open/);
  await page.clock.runFor(3600);
  await expect(stage).toHaveAttribute("data-tour-state", "complete");
  await expect(frame.locator(".demo-source-card")).toHaveCount(0);
});

test("leaving the visible stage pauses the tour and returning resumes it", async ({ page }) => {
  await page.clock.install();
  await loadSite(page);
  const { stage } = await readyTour(page, "mail");
  await page.clock.runFor(1100);
  await expect(stage).toHaveAttribute("data-tour-step", "overview");
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await expect(stage).toHaveAttribute("data-tour-state", "paused");
  await expect(stage).toHaveAttribute("data-tour-pause", "visibility");
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("data-tour-state", "playing");
  await expect(stage).toHaveAttribute("data-tour-step", "overview");
});

test("reduced motion disables automatic playback and close-up while allowing manual playback", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loadSite(page);
  const { stage, toolbar } = await readyTour(page, "mail");
  const toggle = toolbar.locator("[data-demo-tour-toggle]");
  const closeup = toolbar.locator("[data-demo-closeup]");
  await expect(stage).toHaveAttribute("data-tour-state", "paused");
  await expect(toggle).toHaveText("播放演示");
  await expect(closeup).toBeDisabled();
  await toggle.click();
  await page.clock.runFor(1100);
  await expect(stage).toHaveAttribute("data-tour-state", "playing");
  await expect(stage).toHaveAttribute("data-tour-step", "overview");
  expect(await stage.evaluate((element) => getComputedStyle(element).getPropertyValue("--demo-tour-scale").trim())).toBe("1");
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await expect(stage).toHaveAttribute("data-tour-state", "paused");
  await expect(stage).toHaveAttribute("data-tour-pause", "visibility");
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("data-tour-state", "playing");
  await expect(stage).toHaveAttribute("data-tour-step", "overview");
  expect(await stage.evaluate((element) => getComputedStyle(element).getPropertyValue("--demo-tour-scale").trim())).toBe("1");
  await expect(stage.locator(".demo-tour-pointer")).toHaveAttribute("data-visible", "false");
});

test("a narrow viewport disables close-up and keeps tour controls within the page", async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 390, height: 844 });
  await loadSite(page);
  const { stage, toolbar } = await readyTour(page, "mail");
  const closeup = toolbar.locator("[data-demo-closeup]");
  await expect(closeup).toBeDisabled();
  const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
  const controlBounds = await toolbar.evaluate((figure) => {
    const rect = figure.querySelector("[data-demo-tour-toggle]")!.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: innerWidth };
  });
  expect(controlBounds.left).toBeGreaterThanOrEqual(0);
  expect(controlBounds.right).toBeLessThanOrEqual(controlBounds.width + 1);
  await page.clock.runFor(1100);
  await expect(stage).toHaveAttribute("data-tour-step", "overview");
  await expect(stage.locator(".demo-tour-pointer")).toHaveAttribute("data-visible", "false");
});
