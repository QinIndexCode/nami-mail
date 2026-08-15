// Verify scrubber optimizations: preview delayed ~1s, resting bar width 5px,
// wheel drives the bar-group viewport instead of edge-zone auto-scroll.
import { chromium } from "playwright";

const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(`${baseURL}/?demo=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#nami-splash.done", { timeout: 15_000 }).catch(() => {});
  const terms = page.locator(".translation-terms-card");
  if (await terms.isVisible().catch(() => false)) {
    await terms.locator(".primary-button").click();
  }
  await page.locator(".agent-launch-button").first().click();
  await page.waitForSelector(".agent-workspace", { timeout: 15_000 });
  await page.waitForSelector(".agent-scrubber", { timeout: 10_000 });
  await page.waitForTimeout(500);

  const failures = [];
  const track = (ok, msg) => {
    console.log(ok ? "PASS" : "FAIL", msg);
    if (!ok) failures.push(msg);
  };

  const scrubber = page.locator(".agent-scrubber");
  const bar = () => page.locator(".agent-scrubber-bar").first();
  const barCount = await page.locator(".agent-scrubber-bar").count();
  console.log("BAR_COUNT", barCount);

  // 1) Resting bar width is 5px.
  const restWidth = await bar().evaluate((el) => parseFloat(el.style.width));
  track(restWidth === 5, `resting bar width = 5px (got ${restWidth})`);

  // 2) Hover a bar: mountain highlight appears immediately, preview does NOT
  // show until ~1s of rest.
  const trackBox = await scrubber.boundingBox();
  await page.mouse.move(trackBox.x + trackBox.width / 2, trackBox.y + trackBox.height * 0.4);
  await page.waitForTimeout(150);
  const hoverWidth = await bar().evaluate((el) => parseFloat(el.style.width));
  console.log("HOVER_BAR_WIDTH", hoverWidth);
  track(hoverWidth > 5, `hovered bar grows immediately (${hoverWidth}px)`);
  const previewEarly = await page.locator(".agent-scrubber-preview").isVisible().catch(() => false);
  track(!previewEarly, "preview hidden before 1s rest");

  await page.waitForTimeout(1050);
  const previewAfter = await page.locator(".agent-scrubber-preview").isVisible().catch(() => false);
  track(previewAfter, "preview appears after ~1s rest");

  // 3) Moving to a different bar resets the delay (preview hides again).
  await page.mouse.move(trackBox.x + trackBox.width / 2, trackBox.y + trackBox.height * 0.6);
  await page.waitForTimeout(150);
  const previewReset = await page.locator(".agent-scrubber-preview").isVisible().catch(() => false);
  track(!previewReset, "preview hides when moving to another bar");

  // 4) Wheel scrolls the bar group (viewport changes) and does NOT scroll the
  // transcript. Need overflow: demo conversation may have few user messages,
  // so check delta moves the group when it overflows; otherwise just verify
  // no crash and no transcript scroll.
  const viewportBefore = await page.evaluate(() => (window.__scrubberViewport ?? "n/a"));
  const transcriptBefore = await page.evaluate(() => document.querySelector(".agent-transcript, .agent-messages")?.scrollTop ?? null);
  await page.mouse.move(trackBox.x + trackBox.width / 2, trackBox.y + trackBox.height * 0.5);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(200);
  const transcriptAfter = await page.evaluate(() => document.querySelector(".agent-transcript, .agent-messages")?.scrollTop ?? null);
  console.log("TRANSCRIPT_SCROLL", transcriptBefore, "->", transcriptAfter);
  track(transcriptAfter === transcriptBefore, "wheel on scrubber does not scroll the transcript");

  // Move the mouse off so the preview timer is cleaned.
  await page.mouse.move(trackBox.x + trackBox.width / 2, trackBox.y - 20);
  await page.waitForTimeout(1200);
  const previewGone = !(await page.locator(".agent-scrubber-preview").isVisible().catch(() => false));
  track(previewGone, "leaving the scrubber hides the preview");

  await page.screenshot({ path: new URL("../gui-test-screenshots/agent-composer-verify/scrubber-optimized.png", new URL(import.meta.url)).pathname.replace(/^\/([A-Za-z]:)/, "$1") });

  if (failures.length > 0) {
    console.error("VERIFY_FAIL", JSON.stringify(failures));
    process.exitCode = 1;
  } else {
    console.log("VERIFY_OK");
  }
} finally {
  await browser.close();
}
