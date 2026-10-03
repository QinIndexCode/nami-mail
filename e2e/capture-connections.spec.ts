import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

test.use({ colorScheme: "dark", viewport: { width: 1440, height: 900 } });

test("captures screenshots of settings connections, mcp and agent panels", async ({ page }) => {
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

  // Open Settings Modal
  const settingsBtn = page.locator('.icon-rail button:has(svg.lucide-settings), .icon-rail button[aria-label="设置"]');
  await settingsBtn.first().click();
  await expect(page.locator(".settings-modal")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);

  // 1. External Connections (外部连接) -> Tab 1: MCP
  const connectionsNav = page.locator('#settings-nav-connections');
  await connectionsNav.click();
  await page.waitForTimeout(500);

  // Measure bounding boxes of titles and icons
  const metrics = await page.evaluate(() => {
    const results: Array<{ title: string; textY: number; textHeight: number; textCenter: number; iconY: number; iconHeight: number; iconCenter: number; diff: number }> = [];
    const elements = document.querySelectorAll('.connections-subheading, .connections-collapsible-title, .connections-perm-label, .connections-service-card-head, .connections-step-pill');
    elements.forEach((el) => {
      const helpIcon = el.querySelector('.field-help-icon svg');
      if (!helpIcon) return;
      // Get text node range
      const range = document.createRange();
      let textNode: ChildNode | null = null;
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
          textNode = node;
          break;
        } else if (node.nodeType === Node.ELEMENT_NODE && !((node as HTMLElement).classList?.contains('field-help-icon'))) {
          for (const subNode of node.childNodes) {
            if (subNode.nodeType === Node.TEXT_NODE && subNode.textContent?.trim()) {
              textNode = subNode;
              break;
            }
          }
        }
      }
      if (!textNode) return;
      range.selectNodeContents(textNode);
      const textRect = range.getBoundingClientRect();
      const iconRect = helpIcon.getBoundingClientRect();
      const textCenter = textRect.top + textRect.height / 2;
      const iconCenter = iconRect.top + iconRect.height / 2;
      results.push({
        title: textNode.textContent?.trim() || '',
        textY: textRect.top,
        textHeight: textRect.height,
        textCenter,
        iconY: iconRect.top,
        iconHeight: iconRect.height,
        iconCenter,
        diff: iconCenter - textCenter,
      });
    });
    return results;
  });
  console.log("ALIGNMENT METRICS:", JSON.stringify(metrics, null, 2));

  const connStyles = await page.evaluate(() => {
    const connSelect = document.querySelector('.connections-compact-select');
    const connButton = document.querySelector('.connections-compact-select .themed-select');
    const connIcon = document.querySelector('.connections-compact-select .select-control-icon');
    function getStyles(el: Element | null) {
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      return {
        tag: el.tagName,
        className: el.className,
        display: cs.display,
        border: cs.border,
        background: cs.backgroundColor,
        borderRadius: cs.borderRadius,
        padding: cs.padding,
        height: cs.height,
        color: cs.color,
        fontSize: cs.fontSize,
        cursor: cs.cursor,
      };
    }
    return {
      connSelect: getStyles(connSelect),
      connButton: getStyles(connButton),
      connIcon: getStyles(connIcon),
    };
  });
  const tab1Heights = await page.evaluate(() => {
    const body = document.querySelector('.settings-body') as HTMLElement;
    const panel = document.querySelector('.connections-tab-panel') as HTMLElement;
    const banner = document.querySelector('.connections-guide-banner') as HTMLElement;
    const subheading = document.querySelector('.connections-subheading') as HTMLElement;
    const ideTabs = document.querySelector('.connections-ide-tabs') as HTMLElement;
    const codeCard = document.querySelector('.connections-code-card') as HTMLElement;
    const collapsible = document.querySelector('.connections-collapsible') as HTMLElement;
    return {
      bodyClientHeight: body?.clientHeight,
      bodyScrollHeight: body?.scrollHeight,
      bodyDiff: (body?.scrollHeight || 0) - (body?.clientHeight || 0),
      panelHeight: panel?.offsetHeight,
      bannerHeight: banner?.offsetHeight,
      subheadingHeight: subheading?.offsetHeight,
      ideTabsHeight: ideTabs?.offsetHeight,
      codeCardHeight: codeCard?.offsetHeight,
      collapsibleHeight: collapsible?.offsetHeight,
    };
  });
  console.log("TAB 1 (MCP) HEIGHTS:", JSON.stringify(tab1Heights, null, 2));

  await page.screenshot({ path: path.join(outDir, "conn-01-mcp.png") });

  // Test opening the compact dropdown menu
  const mcpSelect = page.locator('#agent-mcp-access-level-conn');
  await mcpSelect.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, "conn-01-mcp-dropdown-open.png") });
  // Close menu by clicking again
  await mcpSelect.click();
  await page.waitForTimeout(200);

  // Scroll down in body to show code block & permissions
  const body = page.locator('.settings-body');
  await body.evaluate((el) => { el.scrollTop = 220; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, "conn-01-mcp-scrolled.png") });

  // Expand the 16 tools details
  const toolsSummary = page.locator('.connections-collapsible summary').first();
  if (await toolsSummary.isVisible()) {
    await toolsSummary.click();
    await page.waitForTimeout(300);
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, "conn-01-mcp-tools-expanded.png") });
  }

  // 2. External Connections -> Tab 2: CLI
  await body.evaluate((el) => { el.scrollTop = 0; });
  const cliTab = page.locator('.connections-tab-btn:has(svg.lucide-terminal)');
  await cliTab.click();
  await page.waitForTimeout(500);

  const tab2Heights = await page.evaluate(() => {
    const bodyEl = document.querySelector('.settings-body') as HTMLElement;
    return {
      bodyClientHeight: bodyEl?.clientHeight,
      bodyScrollHeight: bodyEl?.scrollHeight,
      bodyDiff: (bodyEl?.scrollHeight || 0) - (bodyEl?.clientHeight || 0),
    };
  });
  console.log("TAB 2 (CLI) HEIGHTS:", JSON.stringify(tab2Heights, null, 2));

  await page.screenshot({ path: path.join(outDir, "conn-02-cli.png") });

  // Expand commands collapsible and scroll down in CLI panel
  const cliSummary = page.locator('.connections-collapsible summary').first();
  if (await cliSummary.isVisible()) {
    await cliSummary.click();
    await page.waitForTimeout(300);
  }
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, "conn-02-cli-scrolled.png") });

  // 3. External Connections -> Tab 3: Pairings
  await body.evaluate((el) => { el.scrollTop = 0; });
  const pairingsTab = page.locator('.connections-tab-btn:has(svg.lucide-shield)');
  await pairingsTab.click();
  await page.waitForTimeout(500);

  const tab3Heights = await page.evaluate(() => {
    const bodyEl = document.querySelector('.settings-body') as HTMLElement;
    return {
      bodyClientHeight: bodyEl?.clientHeight,
      bodyScrollHeight: bodyEl?.scrollHeight,
      bodyDiff: (bodyEl?.scrollHeight || 0) - (bodyEl?.clientHeight || 0),
    };
  });
  console.log("TAB 3 (PAIRINGS) HEIGHTS:", JSON.stringify(tab3Heights, null, 2));

  await page.screenshot({ path: path.join(outDir, "conn-03-pairings.png") });

  // 4. Built-in MCP Tools (智能体工具)
  const mcpNav = page.locator('#settings-nav-mcp');
  await mcpNav.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "conn-04-builtin-mcp.png") });

  // 5. Agent Settings (AI 邮件助理)
  const agentNav = page.locator('#settings-nav-agent');
  await agentNav.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "conn-05-agent.png") });

});
