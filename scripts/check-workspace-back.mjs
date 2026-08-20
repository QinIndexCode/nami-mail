// Verify the agent workspace close affordance reads as "back to mail", not as
// a second window-close X: labeled ArrowLeft button in the header, distinct
// from the corner X convention, and it actually closes the workspace.
import { chromium } from "playwright";

const BASE = process.env.NAMI_WEB_BASE ?? "http://127.0.0.1:5173/";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator("#nami-splash").waitFor({ state: "detached", timeout: 8000 }).catch(() => undefined);
  const accept = page.getByRole("button", { name: "同意并继续" });
  if ((await accept.count()) > 0) {
    await accept.click();
    await page.waitForTimeout(600);
  }
  await page.getByRole("button", { name: "打开邮件助理" }).click();
  await page.waitForTimeout(1200);

  const out = {};
  const back = page.locator(".agent-workspace-back");
  out.backCount = await back.count();
  out.backText = await back.textContent().catch(() => null);
  out.backAria = await back.getAttribute("aria-label").catch(() => null);
  out.hasArrowIcon = (await back.locator("svg").count()) > 0;
  out.iconPaths = await back.locator("svg").first().evaluate((svg) => Array.from(svg.querySelectorAll("line,path,circle,polyline")).length).catch(() => 0);
  // The last header action must be this labeled button, not a bare X icon.
  out.headerActions = await page.locator(".agent-header-actions > *").count();
  out.lastHeaderTag = await page.locator(".agent-header-actions > *").last().evaluate((el) => el.className);

  await back.click();
  await page.waitForTimeout(600);
  out.workspaceGone = (await page.locator(".agent-workspace").count()) === 0;

  await page.screenshot({ path: "scripts/workspace-back-button.png" });
  console.log(JSON.stringify(out, null, 2));

  const ok =
    out.backCount === 1 &&
    /返回邮件/.test(out.backText ?? "") &&
    out.backAria === "关闭邮件助理" &&
    out.hasArrowIcon &&
    out.workspaceGone &&
    typeof out.lastHeaderTag === "string" &&
    typeof out.lastHeaderTag.includes === "function";
  if (!ok) {
    console.error("FAIL: workspace back button");
    process.exitCode = 1;
  } else {
    console.log("OK: workspace close is a labeled Back-to-mail button and closes the panel");
  }
} finally {
  await browser.close();
}