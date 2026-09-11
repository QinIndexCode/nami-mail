import { expect, test } from "@playwright/test";
import { bootDemoShell } from "./helpers";

/**
 * Geometry baseline for the reading pane and the shell.
 *
 * The design system's convergence backlog (one-off shadows, off-scale radii and
 * font sizes, spacing that drifted off the 4px grid) changes pixels. Without a
 * measurement to compare against there is no way to tell whether a convergence
 * pass improved things or quietly broke a layout, so this spec freezes the
 * numbers that matter:
 *
 * - the shell columns at each breakpoint (238 → 220 → drawer → phone),
 * - the reading measure (the whole point of the reading-pane column),
 * - the list row height that the density setting produces,
 * - and the global invariant that nothing ever overflows horizontally.
 *
 * Assertions are deliberately tight (±2px). If a legitimate change moves one of
 * these numbers, update the constant *and* say why in the PR — that is the
 * review step this file exists to force.
 */

/** The prose column must never exceed this; it comes from `--measure`. */
const MEASURE = 672;
/** Reader side padding is `clamp(20px, 6vw, 48px)`. */
const MIN_READER_PADDING = 20;
const WIDE_SIDEBAR = 238;
const NARROW_DESKTOP_SIDEBAR = 220;
/** Measured row height for the default "comfortable" density. */
const COMFORTABLE_ROW_HEIGHT = 105;
/** Tight on purpose: a density or padding change must be a deliberate edit here. */
const ROW_HEIGHT_TOLERANCE = 2;

const DEMO_SUBJECT = "周末，在安静的地方见";

const layouts = [
  { name: "wide", viewport: { width: 1440, height: 900 }, sidebar: WIDE_SIDEBAR, readerFillsColumn: false },
  { name: "narrow-desktop", viewport: { width: 1000, height: 800 }, sidebar: NARROW_DESKTOP_SIDEBAR, readerFillsColumn: false },
  { name: "drawer", viewport: { width: 800, height: 700 }, sidebar: null, readerFillsColumn: false },
  { name: "phone", viewport: { width: 600, height: 800 }, sidebar: null, readerFillsColumn: true },
] as const;

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
  });
  expect(overflow.scrollWidth, `the page overflows horizontally (${overflow.scrollWidth} > ${overflow.clientWidth})`).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

for (const layout of layouts) {
  test.describe(`geometry at ${layout.name} (${layout.viewport.width}px)`, () => {
    test.use({ viewport: layout.viewport });

    test("keeps the shell columns, the reading measure and the row height stable", async ({ page }) => {
      await bootDemoShell(page);

      // 1. The shell never overflows, and the sidebar is where the breakpoint says.
      await expectNoHorizontalOverflow(page);
      const sidebar = await page.locator(".sidebar").boundingBox();
      expect(sidebar, "the sidebar must be measurable").not.toBeNull();
      if (layout.sidebar === null) {
        // ≤820px: the sidebar is an off-canvas drawer, so it must sit outside
        // the viewport rather than squeezing the columns.
        expect((sidebar?.x ?? 0) + (sidebar?.width ?? 0), "the drawer sidebar must be off-canvas").toBeLessThanOrEqual(1);
      } else {
        expect(sidebar?.width, `sidebar width at ${layout.viewport.width}px`).toBeCloseTo(layout.sidebar, 0);
      }

      // 2. The list row height is what the density setting promises.
      const row = await page.locator(".message-item").first().boundingBox();
      expect(Math.abs((row?.height ?? 0) - COMFORTABLE_ROW_HEIGHT), `comfortable density row height was ${row?.height}`).toBeLessThanOrEqual(ROW_HEIGHT_TOLERANCE);

      // 3. The reader keeps its column width, and the prose stays inside the measure.
      await page.locator(".message-item", { hasText: DEMO_SUBJECT }).first().click();
      await expect(page.locator(".reader-column")).toBeVisible();

      const content = await page.locator(".mail-content").boundingBox();
      const prose = await page.locator(".mail-text, .mail-html").first().boundingBox();
      const reader = await page.locator(".reader-column").boundingBox();
      expect(content?.width ?? 0, "the reading column must not exceed the measure").toBeLessThanOrEqual(MEASURE + 1);
      expect(prose?.width ?? 0, "the prose must fit inside the measure minus padding").toBeLessThanOrEqual(MEASURE - MIN_READER_PADDING * 2 + 1);
      expect(prose?.width ?? 0, "the prose must be present").toBeGreaterThan(200);

      if (layout.readerFillsColumn) {
        // ≤620px: the reader takes the screen and the list steps aside instead
        // of being squeezed.
        expect(reader?.width ?? 0, "the phone reader is fullscreen").toBeGreaterThanOrEqual(layout.viewport.width - 2);
        await expect(page.locator(".message-column")).not.toBeVisible();
        // At phone width the column is the viewport (minus padding), so the
        // measure cap is what keeps lines readable rather than the column width.
        expect(content?.width ?? 0, "the phone reader column still respects the measure").toBeLessThanOrEqual(MEASURE + 1);
      } else {
        expect(content?.width ?? 0, "the reader column is wider than the measure on desktop").toBeGreaterThan(MEASURE - 1);
      }

      await expectNoHorizontalOverflow(page);
    });
  });
}

test.describe("geometry across themes", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("switching theme does not move the reading measure", async ({ page }) => {
    await bootDemoShell(page);
    await page.locator(".message-item", { hasText: DEMO_SUBJECT }).first().click();
    await expect(page.locator(".reader-column")).toBeVisible();

    const light = await page.locator(".mail-content").boundingBox();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    const dark = await page.locator(".mail-content").boundingBox();
    expect(dark?.width).toBeCloseTo(light?.width ?? 0, 0);
    expect(dark?.width ?? 0).toBeLessThanOrEqual(MEASURE + 1);

    // The theme must actually be applied to the prose (a token regression would
    // otherwise leave dark text on a dark panel unnoticed).
    const color = await page.locator(".mail-text, .mail-html").first().evaluate((el) => getComputedStyle(el).color);
    const [r, g, b] = (color.match(/\d+/g) ?? ["0", "0", "0"]).map(Number);
    expect((r ?? 0) + (g ?? 0) + (b ?? 0), `dark prose colour should be light, got ${color}`).toBeGreaterThan(380);
  });
});
