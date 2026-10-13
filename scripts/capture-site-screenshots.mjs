import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const targetDir = "C:\\Users\\Admin\\.gemini\\antigravity\\brain\\f03fc857-880d-4264-ab70-580c3db09020";

async function capture() {
  const server = spawn("node", ["scripts/preview-site.mjs"], { stdio: "inherit" });
  await new Promise((r) => setTimeout(r, 1200));

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    });
    const page = await context.newPage();

  // 1. Dark mode desktop
  await page.goto("http://127.0.0.1:5176/");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: resolve(targetDir, "site-baseline-dark-desktop.png"), fullPage: true });

  // Hero section viewport
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(targetDir, "site-baseline-dark-hero.png") });

  // 2. Light mode desktop
  await page.locator("#theme-toggle").click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(targetDir, "site-baseline-light-desktop.png"), fullPage: true });

  // 3. Mobile viewport
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto("http://127.0.0.1:5176/");
  await mobilePage.waitForTimeout(1000);
  await mobilePage.screenshot({ path: resolve(targetDir, "site-baseline-dark-mobile.png"), fullPage: true });

  } finally {
    await browser.close();
    server.kill();
  }
  console.log("Screenshots captured successfully.");
}

capture().catch((err) => {
  console.error(err);
  process.exit(1);
});
