import { expect, test, type FrameLocator, type Page } from "@playwright/test";

const frameFor = (page: Page, view: "mail" | "agent"): FrameLocator =>
  page.frameLocator(`iframe[data-demo="${view}"]`);

async function loadSite(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
}

const STEP_ANCHORS = {
  mail: [
    { step: "overview", target: "mail-list" },
    { step: "search", target: "mail-row", interactive: true },
    { step: "read", target: "reader-title" },
  ],
  agent: [
    { step: "answer", target: "agent-answer" },
    { step: "citations", target: "citation-card", interactive: true },
    { step: "source", target: "source-card" },
  ],
} as const;

async function readyTour(page: Page, view: "mail" | "agent") {
  const stage = page.locator(".demo-stage").filter({ has: page.locator(`iframe[data-demo="${view}"]`) });
  // Land on the section like the nav link does, so the sticky header does not
  // cover the tour toolbar (a real click there would otherwise be obstructed).
  await page.evaluate((id) => document.getElementById(id)!.scrollIntoView({ block: "start", behavior: "instant" }), view === "mail" ? "demo" : "agent");
  await expect(stage).toHaveAttribute("data-state", "ready");
  const frame = frameFor(page, view);
  await expect(frame.locator(view === "mail" ? '[data-tour-target="mail-row"]' : '[data-tour-target="agent-answer"]').first()).toBeVisible();
  return { stage, frame, toolbar: stage.locator("xpath=ancestor::figure") };
}

/** Walk one demo and require every step's contract anchor to be present. */
async function walkStepAnchors(page: Page, view: "mail" | "agent") {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("[demo-tour]")) errors.push(message.text());
  });
  const { stage, frame } = await readyTour(page, view);
  // The tour needs its fake clock ticked forward, and the step only advances
  // after in-frame clicks/typing have settled, so poll in 100ms slices rather
  // than guessing fixed hold durations.
  const advanceUntil = async (check: () => Promise<boolean>) => {
    for (let elapsed = 0; elapsed < 20_000; elapsed += 100) {
      if (await check()) return;
      await page.clock.runFor(100);
    }
    throw new Error(`${view} tour did not reach the expected step (${await stage.getAttribute("data-tour-step")}, ${await stage.getAttribute("data-tour-error")})`);
  };
  await advanceUntil(async () => (await stage.getAttribute("data-tour-step")) === STEP_ANCHORS[view][0].step);
  for (const step of STEP_ANCHORS[view]) {
    await expect(stage).toHaveAttribute("data-tour-step", step.step);
    await expect(stage).not.toHaveAttribute("data-tour-error", /.+/);
    const anchor = frame.locator(`[data-tour-target="${step.target}"]`).first();
    await expect(anchor).toBeVisible();
    const box = await anchor.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);
    if ("interactive" in step && step.interactive) await expect(anchor).toBeEnabled();
    await expect(stage.locator(".demo-tour-focus")).toHaveAttribute("data-visible", "true");
    const next = STEP_ANCHORS[view][STEP_ANCHORS[view].indexOf(step) + 1];
    await advanceUntil(async () => (await stage.getAttribute("data-tour-state")) === "error"
      || (next ? (await stage.getAttribute("data-tour-step")) === next.step : (await stage.getAttribute("data-tour-state")) === "complete"));
    await expect(stage).not.toHaveAttribute("data-tour-error", /.+/);
  }
  await expect(stage).toHaveAttribute("data-tour-state", "complete");
  expect(errors).toEqual([]);
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
  expect(Number(await stage.evaluate((element) => getComputedStyle(element).getPropertyValue("--demo-tour-scale")))).toBeGreaterThanOrEqual(1.18);
  const pointer = stage.locator(".demo-tour-pointer");
  await expect(pointer).toHaveAttribute("data-visible", "true");
  await expect(stage.locator(".demo-tour-focus")).toHaveCount(1);
  await expect(stage.locator(".demo-tour-focus")).toHaveAttribute("data-visible", "true");
  await expect(stage.locator(".demo-tour-focus")).toHaveAttribute("data-dim", "true");
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
  await expect.poll(() => stage.evaluate((element) => Number(getComputedStyle(element).getPropertyValue("--demo-tour-scale")))).toBeGreaterThanOrEqual(1.18);

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

test("every mail step resolves its data-tour-target anchor", async ({ page }) => {
  await page.clock.install();
  await loadSite(page);
  await walkStepAnchors(page, "mail");
});

test("every agent step resolves its data-tour-target anchor", async ({ page }) => {
  await page.clock.install();
  await loadSite(page);
  await walkStepAnchors(page, "agent");
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

test("entering the demo keeps toolbar, stage, and figcaption in one desktop viewport", async ({ page }) => {
  await page.clock.install();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await loadSite(page);
    const { stage } = await readyTour(page, "mail");
    await page.evaluate(() => document.getElementById("demo")!.scrollIntoView({ block: "start", behavior: "instant" }));
    await page.clock.runFor(1100);
    await expect(stage).toHaveAttribute("data-tour-state", "playing");
    // The overview frames the whole list without dimming it.
    await expect(stage.locator(".demo-tour-focus")).toHaveAttribute("data-dim", "false");
    // The narration caption is gone; the stage starts right under the toolbar.
    await expect(page.locator(".demo-tour-caption")).toHaveCount(0);
    const box = await stage.evaluate((element) => {
      const figure = element.closest("figure")!;
      const rect = (selector: string) => figure.querySelector(selector)!.getBoundingClientRect();
      const bar = rect(".demo-toolbar");
      const stageRect = rect(".demo-stage");
      const figcaption = rect("figcaption");
      return {
        innerHeight,
        barTop: bar.top,
        barBottom: bar.bottom,
        stageTop: stageRect.top,
        stageHeight: stageRect.height,
        stageBottom: stageRect.bottom,
        figcaptionBottom: figcaption.bottom,
      };
    });
    expect(box.barTop).toBeGreaterThanOrEqual(0);
    expect(box.stageTop).toBeGreaterThanOrEqual(box.barBottom - 1);
    expect(box.stageHeight).toBeGreaterThan(300);
    expect(box.stageBottom).toBeLessThanOrEqual(box.innerHeight);
    expect(box.figcaptionBottom).toBeLessThanOrEqual(box.innerHeight - 8);
  }
});

test("wheel input scrolls the page naturally instead of snapping a section height", async ({ page }) => {
  await loadSite(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.move(720, 450);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.scrollY);
  expect(after - before).toBeGreaterThan(0);
  expect(after - before).toBeLessThan(400);
});

test("scrolling inside the demo keeps the tour playing", async ({ page }) => {
  await loadSite(page);
  const { stage, frame } = await readyTour(page, "mail");
  await expect(stage).toHaveAttribute("data-tour-state", "playing");
  await expect(stage).toHaveAttribute("data-tour-step", "overview");
  // The old site forwarded this gesture to the outer page, which snapped the
  // scroll position down a section and paused the tour as an interaction.
  await frame.locator(".message-list").evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 240, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(400);
  await expect(stage).toHaveAttribute("data-tour-state", "playing");
  expect(await stage.evaluate((element) => element.dataset.tourPause ?? null)).toBeNull();
});

