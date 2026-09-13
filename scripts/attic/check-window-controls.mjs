#!/usr/bin/env node
/**
 * 检查 Electron 界面中窗口控制按钮在不同视图的一致性
 * 运行方式: node scripts/check-window-controls.mjs
 */

import { chromium } from "playwright";

const VIEWPORT = { width: 1280, height: 800 };

async function checkWindowControls() {
  console.log("🔍 检查窗口控制按钮一致性...\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  // 等待页面加载
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  // 检查三个 header 中的窗口控制按钮
  const headers = [
    { name: ".column-header", selector: ".column-header" },
    { name: ".reader-toolbar", selector: ".reader-toolbar" },
    { name: ".agent-workspace-header", selector: ".agent-workspace-header" },
  ];

  const results = [];

  for (const header of headers) {
    const element = await page.$(header.selector);
    if (!element) {
      console.log(`⚠️  ${header.name}: 元素不存在`);
      continue;
    }

    const isVisible = await element.isVisible();
    if (!isVisible) {
      console.log(`⚠️  ${header.name}: 元素不可见`);
      continue;
    }

    // 检查是否有窗口控制按钮
    const controls = await element.$$(".window-controls .window-control");
    const controlCount = controls.length;

    // 获取 padding-right
    const padding = await element.evaluate((el) => {
      return window.getComputedStyle(el).paddingRight;
    });

    // 获取按钮尺寸
    let buttonSizes = [];
    for (const control of controls) {
      const box = await control.boundingBox();
      if (box) {
        buttonSizes.push({ width: box.width, height: box.height });
      }
    }

    results.push({
      name: header.name,
      visible: isVisible,
      controlCount,
      padding,
      buttonSizes,
    });

    console.log(`✅ ${header.name}:`);
    console.log(`   - 可见: ${isVisible}`);
    console.log(`   - 窗口控制按钮数: ${controlCount}`);
    console.log(`   - padding-right: ${padding}`);
    if (buttonSizes.length > 0) {
      console.log(`   - 按钮尺寸: ${JSON.stringify(buttonSizes)}`);
    }
    console.log("");
  }

  // 检查 portal 机制
  console.log("--- Portal 机制检查 ---\n");

  const windowBar = await page.$(".window-bar");
  if (windowBar) {
    const windowBarVisible = await windowBar.isVisible();
    console.log(`window-bar 可见: ${windowBarVisible}`);

    // 检查 window-bar 内部是否有 controls
    const windowBarControls = await windowBar.$$(".window-controls");
    console.log(`window-bar 内 controls 数: ${windowBarControls.length}`);
  }

  // 检查当前 portal 目标
  const portalTarget = await page.evaluate(() => {
    const headers = [
      document.querySelector(".agent-workspace-header"),
      document.querySelector(".reader-toolbar"),
      document.querySelector(".column-header"),
    ].filter(
      (el) => !!el && getComputedStyle(el).display !== "none",
    );
    return headers[0]?.className || "无";
  });
  console.log(`当前 portal 目标: ${portalTarget}`);

  // 截图保存
  await page.screenshot({ path: "scripts/window-controls-check.png", fullPage: false });
  console.log("\n📸 截图已保存到 scripts/window-controls-check.png");

  await browser.close();
}

checkWindowControls().catch(console.error);
