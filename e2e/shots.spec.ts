import { expect, test } from "@playwright/test";

/**
 * Regenerates the screenshots the READMEs embed.
 *
 * Everything is captured from the running app in demo mode (`?demo=1`), so the
 * frames show the current UI with the mock dataset: no real mailbox, no real
 * account names, no addresses outside `example.com`. The theme follows the
 * system preference, and the captures below force the dark scheme — that is the
 * product's showcase theme. Run it on demand after a UI change that makes the
 * README images stale:
 *
 *   $env:NAMI_MAIL_CAPTURE_SHOTS="1"; npx playwright test e2e/shots.spec.ts
 *
 * It is skipped unless NAMI_MAIL_CAPTURE_SHOTS is set, because it writes into
 * `docs/` rather than asserting anything - a normal test run must not rewrite
 * committed images.
 */
const targets = [
  { lang: "zh-CN", inbox: "docs/nami-mail-inbox-zh.png", agent: "docs/nami-mail-agent-zh.png" },
  { lang: "en-US", inbox: "docs/nami-mail-inbox-en.png", agent: "docs/nami-mail-agent-en.png" },
] as const;

test.skip(!process.env.NAMI_MAIL_CAPTURE_SHOTS, "Set NAMI_MAIL_CAPTURE_SHOTS=1 to regenerate the README screenshots.");
test.use({ colorScheme: "dark" });

for (const target of targets) {
  test(`captures the ${target.lang} screenshots`, async ({ page }) => {
    // The interface language comes from the stored preference; demo mode does not
    // persist it, so seeding it before the app boots is the whole switch.
    await page.addInitScript((lang) => {
      window.localStorage.setItem("nami-mail.locale-preference", lang);
    }, target.lang);

    await page.goto("/?demo=1");
    await expect(page.locator("#nami-splash")).toHaveClass(/done/, { timeout: 20_000 });
    const terms = page.locator(".translation-terms-card");
    if (await terms.isVisible().catch(() => false)) {
      await terms.locator(".primary-button").click();
    }
    await expect(page.locator(".message-item").first()).toBeVisible();
    // Let the list settle: avatars, counts and the scroll-reveal band animate in.
    await page.waitForTimeout(2_500);
    await page.screenshot({ path: target.inbox });

    await page.locator(".agent-launch-button").first().click();
    await expect(page.locator(".agent-workspace")).toBeVisible();
    await expect(page.locator(".agent-workspace .agent-conversation-title, .agent-workspace .agent-message").first()).toBeVisible();
    await page.waitForTimeout(1_200);
    await page.screenshot({ path: target.agent });
  });
}
