import { expect, test, type Page } from "@playwright/test";
import { bootDemo } from "./helpers";

/**
 * The preview pane against the demo byte provider (plan §12).
 *
 * These cases are the ones jsdom cannot answer: a real canvas painted by
 * pdf.js, a real blob: image, and the network counter that proves a
 * download-only kind never fetches. The 300 DPI scanned-invoice check stays a
 * human step — see `done_when` #17 in the plan.
 */

async function openMessage(page: Page, subject: string): Promise<void> {
  await page.locator(".message-item", { hasText: subject }).first().click();
  await expect(page.locator(".reader-column")).toBeVisible();
}

/**
 * Demo mail carries a pending auto-reply confirmation that sits on top of the
 * whole shell (deliberately: it is the highest overlay), so it would swallow
 * clicks aimed at the attachment actions. It has nothing to do with the
 * preview, so the spec dismisses it the way a user would.
 */
async function dismissNotices(page: Page): Promise<void> {
  const toast = page.locator(".auto-reply-toast");
  const dismiss = page.locator(".auto-reply-toast-dismiss");
  for (let attempt = 0; attempt < 3 && (await toast.count()) > 0; attempt += 1) {
    await dismiss.first().click();
    await expect(toast).toHaveCount(0);
  }
}

async function openPreview(page: Page, subject: string, filename: string): Promise<void> {
  await openMessage(page, subject);
  await dismissNotices(page);
  await previewButton(page, filename).click();
}

function previewButton(page: Page, filename: string) {
  return page.locator(".reader-column").getByRole("button", { name: `预览 ${filename}` });
}

/** Counts pixels that are not near-white, i.e. proof the canvas has content. */
async function paintedPixels(page: Page): Promise<number> {
  return page.locator("canvas.attachment-preview-page").evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d");
    if (!context || canvas.width === 0 || canvas.height === 0) return 0;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 0; index < data.length; index += 4) {
      if ((data[index] ?? 255) < 240 || (data[index + 1] ?? 255) < 240 || (data[index + 2] ?? 255) < 240) {
        painted += 1;
      }
    }
    return painted;
  });
}

test.describe("attachment preview", () => {
  test("paints the demo PDF and turns its two pages", async ({ page }) => {
    await bootDemo(page);
    await openPreview(page, "Design review", "july-review-notes.pdf");

    const drawer = page.locator(".attachment-preview-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".attachment-preview-pdf-page-label")).toHaveText("第 1 / 2 页");

    // A blank page and an unrendered canvas look identical in the DOM, so the
    // assertion is on pixels: the fixture draws text and a filled rectangle.
    await expect.poll(() => paintedPixels(page), { timeout: 20_000 }).toBeGreaterThan(1_000);

    await drawer.getByRole("button", { name: "下一页" }).click();
    await expect(drawer.locator(".attachment-preview-pdf-page-label")).toHaveText("第 2 / 2 页");
    await expect(drawer.getByRole("button", { name: "下一页" })).toBeDisabled();
    await expect.poll(() => paintedPixels(page), { timeout: 20_000 }).toBeGreaterThan(1_000);
  });

  test("reports the 201-entry archive as too many entries, without a blank pane", async ({ page }) => {
    await bootDemo(page);
    await openPreview(page, "照片整理好了", "weekend-photos.zip");

    const alert = page.locator(".attachment-preview-drawer [role='alert']");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("200");
    await expect(alert.getByRole("button", { name: "重试" })).toBeVisible();
  });

  test("renders the hostile SVG sanitized and opens no dialog", async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await bootDemo(page);
    await openPreview(page, "Design review", "moodboard.svg");

    const image = page.locator(".attachment-preview-drawer .attachment-preview-image-wrap[data-surface='vector'] img");
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("src", /^blob:/);
    // The fixture carries <script>alert(1)</script> and onload="alert(…)";
    // neither may survive into the pane.
    await expect(page.locator(".attachment-preview-drawer script")).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });

  test("shows the download card for a PSD without requesting any bytes", async ({ page }) => {
    await bootDemo(page);
    await openMessage(page, "Design review");
    await dismissNotices(page);

    const apiRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) apiRequests.push(request.url());
    });

    await previewButton(page, "workspace.psd").click();
    const card = page.locator(".attachment-preview-drawer .attachment-preview-download-only");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("role", "status");
    expect(apiRequests).toEqual([]);
  });

  test("Escape closes the pane and hands focus back to the preview button", async ({ page }) => {
    await bootDemo(page);
    await openMessage(page, "Design review");
    await dismissNotices(page);
    const trigger = previewButton(page, "july-review-notes.pdf");
    await trigger.click();
    await expect(page.locator(".attachment-preview-drawer")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".attachment-preview-drawer")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
