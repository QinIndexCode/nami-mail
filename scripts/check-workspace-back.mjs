// Verify the agent workspace close affordance is a bare ArrowLeft icon
// button (matching the other header icon-buttons, distinct from the window
// corner X convention) and that it closes the workspace.
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
  const actions = page.locator(".agent-header-actions > *");
  out.headerActionCount = await actions.count();
  const back = actions.last();
  out.backClass = await back.getAttribute("class").catch(() => null);
  out.backAria = await back.getAttribute("aria-label").catch(() => null);
  out.backText = (await back.textContent()).trim();
  out.hasArrowIcon = (await back.locator("svg").count()) > 0;
  out.arrowPathCount = await back.locator("svg").first().evaluate((svg) => svg.querySelectorAll("line,polyline,path").length).catch(() => 0);
  out.isBareIconButton = /(^|\s)icon-button(\s|$)/.test(out.backClass ?? "");

  await back.click();
  await page.waitForTimeout(600);
  out.workspaceGone = (await page.locator(".agent-workspace").count()) === 0;

  await page.screenshot({ path: "scripts/workspace-back-button.png" });
  console.log(JSON.stringify(out, null, 2));

  const ok =
    out.isBareIconButton &&
    out.backText === "" &&
    out.backAria === "关闭邮件助理" &&
    out.hasArrowIcon &&
    out.arrowPathCount >= 2 &&
    out.workspaceGone;
  if (!ok) {
    console.error("FAIL: workspace back button");
    process.exitCode = 1;
  } else {
    console.log("OK: workspace close is a bare ArrowLeft icon-button and closes the panel");
  }
} finally {
  await browser.close();
}