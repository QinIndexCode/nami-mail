import { expect, test, type Page } from "@playwright/test";

type StubSnapshot = {
  schemaVersion: 2;
  phase: string;
  currentVersion: string;
  targetVersion: string | null;
  percent: number | null;
  checkedAt: string | null;
  suppression: string;
  remindAt: string | null;
  reason: string;
  args: Record<string, unknown>;
};

type StubWindow = {
  namiDesktop?: unknown;
  __updateCalls: string[];
  __statusListener?: (snapshot: unknown) => void;
};

function snapshot(overrides: Partial<StubSnapshot>): StubSnapshot {
  return {
    schemaVersion: 2,
    phase: "unavailable",
    currentVersion: "0.1.0",
    targetVersion: null,
    percent: null,
    checkedAt: null,
    suppression: "none",
    remindAt: null,
    reason: "initializing",
    args: {},
    ...overrides,
  };
}

/**
 * Installs a desktop-bridge stub inside the page. The stub must be built on
 * the page side: functions do not survive addInitScript argument serialization.
 * DesktopBridge spreads the raw bridge, so every method the app calls without
 * an optional-chaining guard must exist on the stub.
 */
async function installStub(page: Page, initialStatus: StubSnapshot): Promise<void> {
  await page.addInitScript((start) => {
    const w = window as unknown as StubWindow;
    w.__updateCalls = [];
    let status = start;
    w.namiDesktop = {
      setCustomNotificationSoundReady: () => undefined,
      setUnreadBadge: () => undefined,
      copyVerificationCode: async () => ({ copied: true }),
      notify: async () => ({ shown: true }),
      onSettingsChanged: () => () => undefined,
      onNewMail: () => () => undefined,
      onOpenMessage: () => () => undefined,
      getUpdateStatus: async () => status,
      checkForUpdates: async () => {
        w.__updateCalls.push("checkForUpdates");
        status = { ...status, phase: "up-to-date", currentVersion: "0.1.0", targetVersion: null, percent: null, reason: "upToDate" };
        return status;
      },
      downloadUpdate: async () => {
        w.__updateCalls.push("downloadUpdate");
        status = { ...status, phase: "downloading", percent: 45, reason: "downloading" };
        return status;
      },
      installUpdate: async () => {
        w.__updateCalls.push("installUpdate");
        status = { ...status, phase: "up-to-date", currentVersion: "0.2.0", targetVersion: null, percent: null, reason: "upToDate" };
        return { accepted: true, snapshot: status };
      },
      onUpdateStatus: (listener: (snapshot: unknown) => void) => {
        w.__statusListener = listener;
        return () => undefined;
      },
    };
  }, initialStatus);
}

/** Boots the demo and resolves whichever modal appears on top first. */
async function bootDemo(page: Page): Promise<void> {
  await page.goto("/?demo=1");
  await expect(page.locator("#nami-splash")).toHaveClass(/done/, { timeout: 15_000 });
  const updateCard = page.locator(".update-prompt-card");
  if (await updateCard.isVisible().catch(() => false)) {
    await updateCard.getByRole("button", { name: "下载更新" }).click();
  }
  const terms = page.locator(".translation-terms-card");
  if (await terms.isVisible().catch(() => false)) {
    await terms.locator(".primary-button").click();
  }
  await expect(page.locator(".compose-button")).toBeVisible();
  await expect(page.locator(".message-item").first()).toBeVisible();
}

test.describe("sidebar update footer button", () => {
  test("available → download progress → ready → in-app restart", async ({ page }) => {
    const initial = snapshot({ phase: "available", targetVersion: "0.2.0", reason: "releaseAvailable" });
    await installStub(page, initial);
    await bootDemo(page);

    // The startup prompt handled the available release; the download collapsed
    // the prompt into a non-modal progress bar and the footer button now shows
    // the same in-flight progress.
    const button = page.locator(".update-footer-button");
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(button).toContainText("下载中 45%");

    // The updater broadcasts ready: the footer button flips to an enabled
    // restart affordance (the startup prompt reopens above it, which is fine —
    // both offer the same install action).
    await page.evaluate((next) => {
      (window as unknown as StubWindow).__statusListener?.(next);
    }, snapshot({ phase: "ready", targetVersion: "0.2.0", reason: "downloadReady" }));
    await expect(button).toBeEnabled();
    await expect(button).toContainText("更新就绪 · 重启");

    // Install via the reopened startup prompt and watch everything settle.
    await page.locator(".update-prompt-card").getByRole("button", { name: "重启并更新" }).click();
    await expect(page.locator(".update-prompt-card")).toHaveCount(0);
    await expect(page.locator(".update-footer-button")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as StubWindow).__updateCalls)).toEqual(["downloadUpdate", "installUpdate"]);
  });

  test("a dismissed failed check leaves a footer retry that runs a fresh check", async ({ page }) => {
    const initial = snapshot({ phase: "error", targetVersion: "0.2.0", reason: "network" });
    await installStub(page, initial);
    await page.goto("/?demo=1");
    await expect(page.locator("#nami-splash")).toHaveClass(/done/, { timeout: 15_000 });

    // The error prompt appears; dismiss it — the footer retry is the durable
    // entry point once the terminal prompt has been acknowledged.
    await page.locator(".update-prompt-card").getByRole("button", { name: "稍后" }).click();
    const terms = page.locator(".translation-terms-card");
    if (await terms.isVisible().catch(() => false)) {
      await terms.locator(".primary-button").click();
    }
    await expect(page.locator(".compose-button")).toBeVisible();

    const button = page.locator(".update-footer-button");
    await expect(button).toBeVisible();
    await expect(button).toContainText("更新失败 · 重试");

    await button.click();
    await expect(page.locator(".update-footer-button")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as StubWindow).__updateCalls)).toEqual(["checkForUpdates"]);
  });

  test("skip/snooze suppression hides the button", async ({ page }) => {
    const initial = snapshot({ phase: "available", targetVersion: "0.2.0", suppression: "skipped", reason: "releaseAvailable" });
    await installStub(page, initial);
    await page.goto("/?demo=1");
    await expect(page.locator("#nami-splash")).toHaveClass(/done/, { timeout: 15_000 });

    await expect(page.locator(".update-footer-button")).toHaveCount(0);
  });
});