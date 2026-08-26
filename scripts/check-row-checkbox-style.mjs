// Style parity probe: agent conversation multi-select checkbox vs the mail
// list checkbox — geometry, border, fill, pop, and row-level selected feedback.
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

  const css = (el, props) =>
    el.evaluate(
      (node, names) => Object.fromEntries(names.map((n) => [n, getComputedStyle(node)[n]])),
      props
    );

  const out = {};

  // --- Mail list checkbox (reference) ---
  const selToggle = page.locator(".selection-toggle");
  if ((await selToggle.count()) === 0) throw new Error("no mail selection toggle");
  await selToggle.click();
  await page.waitForTimeout(500);
  const mailBox = page.locator(".selection-checkbox").first();
  const mailCss = await css(mailBox, ["width", "height", "borderTopWidth", "borderTopColor", "borderRadius"]);
  out.mailCheckbox = { ...mailCss, count: await page.locator(".selection-checkbox").count() };
  // Check one mail row to capture the checked fill.
  await page.locator(".message-item").first().click();
  await page.waitForTimeout(500);
  out.mailCheckedBox = await css(page.locator(".selection-checkbox.checked").first(), ["backgroundColor", "borderTopColor", "color", "animationName"]);
  out.mailUncheckedBox = await css(page.locator(".selection-checkbox:not(.checked)").first(), ["backgroundColor", "borderTopColor", "color"]);

  // --- Agent conversation list checkbox ---
  await page.getByRole("button", { name: "打开邮件助理" }).click();
  await page.waitForTimeout(1200);
  await page.locator(".agent-conversation-row").first().click({ button: "right" });
  await page.waitForTimeout(400);
  const menu = page.locator(".agent-context-menu");
  const multi = menu.getByText("多选");
  if ((await multi.count()) === 1) await multi.click();
  else await menu.locator("button").nth(1).click();
  await page.waitForTimeout(500);

  const rows = page.locator(".agent-conversation-row");
  const rowA = rows.nth(0);
  const rowB = rows.nth(1);
  const box = (r) => r.locator(".agent-row-check-box");

  // A was right-clicked → pre-checked: checked box styles + row highlight.
  out.agentCheckedBox = await css(box(rowA), ["width", "height", "borderTopWidth", "borderRadius", "borderTopColor", "backgroundColor", "color", "animationName"]);
  out.agentCheckedRow = await css(rowA, ["backgroundColor", "borderTopColor"]);
  out.agentCheckedRowCls = await rowA.getAttribute("class");

  // B unchecked: box present, border only, check transparent, row unlit.
  out.agentUncheckedBox = await css(box(rowB), ["borderTopColor", "backgroundColor", "color"]);
  out.agentUncheckedRow = await css(rowB, ["backgroundColor"]);
  const focusRing = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim());

  // Select B → both checked, count updates.
  await rowB.locator(".agent-conversation-open").click();
  await page.waitForTimeout(400);
  out.agentCheckedB = { boxBg: (await css(box(rowB), ["backgroundColor"])).backgroundColor, rowCls: await rowB.getAttribute("class") };
  out.agentCount = await page.locator(".agent-selection-count").evaluate((el) => el.textContent ?? "");

  await page.screenshot({ path: "output/row-checkbox-style.png" });
  console.log(JSON.stringify(out, null, 2));
  console.log("focus-ring =", focusRing);

  const ok =
    out.mailCheckbox.width === "17px" &&
    out.mailCheckbox.height === "17px" &&
    out.agentCheckedBox.width === "17px" &&
    out.agentCheckedBox.height === "17px" &&
    out.mailCheckbox.borderTopWidth === out.agentCheckedBox.borderTopWidth &&
    out.mailCheckbox.borderRadius === out.agentCheckedBox.borderRadius &&
    out.agentCheckedBox.backgroundColor === out.mailCheckedBox.backgroundColor &&
    out.agentCheckedBox.borderTopColor === out.mailCheckedBox.backgroundColor &&
    out.agentCheckedBox.animationName === "checkbox-pop" &&
    out.mailCheckedBox.animationName === "checkbox-pop" &&
    out.agentUncheckedBox.backgroundColor === out.mailUncheckedBox.backgroundColor &&
    out.agentUncheckedBox.borderTopColor === out.mailUncheckedBox.borderTopColor &&
    out.agentUncheckedBox.color === "rgba(0, 0, 0, 0)" &&
    out.agentCheckedRowCls.includes("selected") &&
    out.agentCheckedRow.backgroundColor !== out.agentUncheckedRow.backgroundColor &&
    out.agentCheckedB.boxBg === out.mailCheckedBox.backgroundColor &&
    out.agentCheckedB.rowCls.includes("selected") &&
    /已选 2/.test(out.agentCount);
  if (!ok) {
    console.error("FAIL: style parity");
    process.exitCode = 1;
  } else {
    console.log("OK: agent checkbox matches mail checkbox language; row selection lit");
  }
} finally {
  await browser.close();
}