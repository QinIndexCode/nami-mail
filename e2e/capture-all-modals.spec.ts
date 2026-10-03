import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

test.use({ colorScheme: "dark", viewport: { width: 1440, height: 900 } });

test("captures screenshots of all non-settings modal dialogs", async ({ page }) => {
  const outDir = path.resolve(process.cwd(), "dialog-shots");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  await page.addInitScript(() => {
    window.localStorage.setItem("nami-mail.locale-preference", "zh-CN");
  });

  await page.goto("/?demo=1");
  await expect(page.locator("#nami-splash")).toHaveClass(/done/, { timeout: 30_000 });

  const terms = page.locator(".translation-terms-card");
  if (await terms.isVisible().catch(() => false)) {
    await terms.locator(".primary-button").click();
  }

  await expect(page.locator(".message-item").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1_000);

  // 1. Compose Modal (.compose-card)
  const composeBtn = page.locator(".compose-button");
  if (await composeBtn.isVisible()) {
    await composeBtn.click();
    await expect(page.locator(".compose-card")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, "01-compose-modal.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  // 2. Accounts Dialog (.management-dialog)
  const accountsBtn = page.locator('.icon-rail button:has(svg.lucide-at-sign)');
  if (await accountsBtn.isVisible()) {
    await accountsBtn.click();
    await expect(page.locator(".management-dialog")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, "02-accounts-dialog.png") });

    // 3. Add Account Modal (.account-modal) from Accounts Dialog
    const addAccountBtn = page.locator(".management-header-add-button, .accounts-modal .primary-button, .management-dialog .primary-button");
    if (await addAccountBtn.first().isVisible()) {
      await addAccountBtn.first().click();
      await expect(page.locator(".account-modal")).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(outDir, "03-add-account-modal.png") });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
    // Close accounts dialog if still visible
    if (await page.locator(".management-dialog").isVisible()) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  }

  // 4. Contacts Dialog & Contact Editor Modal
  const contactsBtn = page.locator('.icon-rail button:has(svg.lucide-users)');
  if (await contactsBtn.isVisible()) {
    await contactsBtn.click();
    await expect(page.locator(".management-dialog")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, "04-contacts-dialog.png") });

    // Open Contact Editor (.contact-editor-modal)
    const newContactBtn = page.locator('.management-dialog .primary-button');
    if (await newContactBtn.first().isVisible()) {
      await newContactBtn.first().click();
      await expect(page.locator(".contact-editor-modal")).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(outDir, "05-contact-editor-modal.png") });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
    if (await page.locator(".management-dialog").isVisible()) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  }

  // 5. Templates Dialog & Template Editor Modal
  const templatesBtn = page.locator('.icon-rail button:has(svg.lucide-layout-template)');
  if (await templatesBtn.isVisible()) {
    await templatesBtn.click();
    await expect(page.locator(".management-dialog")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, "06-templates-dialog.png") });

    const newTemplateBtn = page.locator('.management-dialog .primary-button');
    if (await newTemplateBtn.first().isVisible()) {
      await newTemplateBtn.first().click();
      await expect(page.locator(".template-editor-card, .contact-editor-modal")).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(outDir, "07-template-editor-modal.png") });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
    if (await page.locator(".management-dialog").isVisible()) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  }

  // 6. Calendar Dialog & Calendar Event Editor
  const calendarBtn = page.locator('.icon-rail button:has(svg.lucide-calendar)');
  if (await calendarBtn.isVisible()) {
    await calendarBtn.click();
    await expect(page.locator(".calendar-management-dialog, .management-dialog")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, "08-calendar-dialog.png") });

    // Click a day in calendar to open new event editor
    const dayCell = page.locator('.calendar-day:not(.outside)').first();
    if (await dayCell.isVisible()) {
      await dayCell.click();
      await expect(page.locator(".calendar-editor-modal")).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(outDir, "09-calendar-editor-modal.png") });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
    if (await page.locator(".calendar-management-dialog, .management-dialog").isVisible()) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  }

  // 7. Sending Status Modal
  const sendingBtn = page.locator('.icon-rail button:has(svg.lucide-list-checks)');
  if (await sendingBtn.isVisible()) {
    await sendingBtn.click();
    await expect(page.locator(".sending-status-modal")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, "10-sending-status-modal.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
});
