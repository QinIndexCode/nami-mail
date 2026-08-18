/**
 * UI stress spec — measures the mail list at scale against a seeded local
 * server (see scripts/ui-stress/seed-data.mjs + run-stress.mjs).
 *
 * One long serial test so the 20k-item list is loaded exactly once and shared
 * across phases:
 *   1. Initial inbox render at 20k          — first paint, API timings, DOM cost
 *   2. Infinite-scroll pagination to the end — 200 sequential page fetches
 *   3. Batch mark-read of all 20k           — server-side predicate job
 *   4. Batch move (archive) of all 20k      — predicate job, exits selection
 *   5. Small selection move                 — in-viewport rows archive
 *
 * The message list is virtualized (@tanstack/react-virtual), so DOM row count
 * is the viewport window (rows + overscan), never the loaded total; progress
 * signals used below are the header total, the selection counter, and the
 * fetch sampler in window.__pf.
 *
 * Results are merged into data/ui-stress/results-spec.json by the runner.
 */

import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

test.setTimeout(100 * 60_000);

const persist = () => {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, "results-spec.json"), JSON.stringify(results, null, 2));
};

const resultsDir = path.join(process.cwd(), "data", "ui-stress");
const manifestPath = path.join(resultsDir, "seed-manifest.json");
if (!fs.existsSync(manifestPath)) {
  throw new Error(`Seed manifest missing at ${manifestPath}. Run: node scripts/ui-stress/run-stress.mjs`);
}
const { messages: TOTAL, unread: UNREAD } = JSON.parse(
  fs.readFileSync(manifestPath, "utf8"),
) as { messages: number; unread: number };

const results: Record<string, unknown> = {};
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

interface PfState {
  frames: number[];
  longTasks: Array<{ s: number; d: number }>;
  requests: Array<{ url: string; dur: number; status: number }>;
  lastFetchEnd: number;
  marks: Array<{ n: string; t: number }>;
  toasts: Array<{ text: string; kind: string; t: number }>;
}

declare global {
  interface Window {
    __pf: PfState;
  }
}

function installSampler(page: Page): void {
  page.addInitScript(() => {
    const pf = { frames: [], longTasks: [], requests: [], lastFetchEnd: 0, marks: [], toasts: [] };
    window.__pf = pf;
    let lastToastSeen = false;
    function sampleToast() {
      const el = document.querySelector(".toast");
      if (el) {
        // Record each time the toast slot fills, even if the text repeats
        // (consecutive failures can share the same message).
        if (!lastToastSeen) {
          pf.toasts.push({ text: el.textContent?.trim() ?? "", kind: el.className ?? "", t: performance.now() });
          lastToastSeen = true;
        }
      } else {
        lastToastSeen = false;
      }
    }
    requestAnimationFrame(function loop(timestamp) {
      pf.frames.push(timestamp);
      sampleToast();
      requestAnimationFrame(loop);
    });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          pf.longTasks.push({ s: entry.startTime, d: entry.duration });
        }
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      // longtask observer not available in this browser; frames still cover jank
    }
const originalFetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? "";
      const start = performance.now();
      return originalFetch(...args).then((response) => {
        if (url.startsWith("/api/")) pf.requests.push({ url, dur: performance.now() - start, status: response.status });
        pf.lastFetchEnd = performance.now();
        return response;
      });
    };
    // Consent watchdog: the translation-terms dialog can appear well after
    // boot; accept it whenever it shows so it never intercepts interaction.
    setTimeout(function termsWatchdog() {
      const card = document.querySelector(".translation-terms-card");
      if (card && !card.classList.contains("closing")) {
        const button = card.querySelector(".primary-button");
        if (button) button.click();
      }
      setTimeout(termsWatchdog, 250);
    }, 500);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
}

async function waitForIdle(page: Page, settleMs = 2_000, timeoutMs = 300_000): Promise<void> {
  await page.waitForFunction(
    (settle) => {
      const pf = window.__pf;
      const now = performance.now();
      const frames = pf.frames;
      const lastGap = frames.length >= 2 ? frames[frames.length - 1] - frames[frames.length - 2] : 0;
      const lastTask = pf.longTasks.length ? pf.longTasks[pf.longTasks.length - 1] : null;
      const lastTaskEnd = lastTask ? lastTask.s + lastTask.d : 0;
      const fetchQuiet = now - pf.lastFetchEnd > settle;
      const taskQuiet = now - lastTaskEnd > settle;
      const frameHealthy = lastGap < 60;
      return frameHealthy && fetchQuiet && taskQuiet;
    },
    settleMs,
    { timeout: timeoutMs, polling: 200 },
  );
}

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

interface JankSummary {
  frameGapP50Ms: number;
  frameGapP95Ms: number;
  frameGapMaxMs: number;
  jankyGapsOver50Ms: number;
  longTaskCount: number;
  longTaskTotalMs: number;
}

function jankSummary(pf: PfState, fromMs = 0, toMs = Number.POSITIVE_INFINITY): JankSummary {
  const gaps: number[] = [];
  for (let i = 1; i < pf.frames.length; i += 1) {
    const gap = pf.frames[i] - pf.frames[i - 1];
    if (gap >= fromMs && gap <= toMs) gaps.push(gap);
  }
  return {
    frameGapP50Ms: pct(gaps, 0.5),
    frameGapP95Ms: pct(gaps, 0.95),
    frameGapMaxMs: gaps.length ? Math.max(...gaps) : 0,
    jankyGapsOver50Ms: gaps.filter((gap) => gap > 50).length,
    longTaskCount: pf.longTasks.length,
    longTaskTotalMs: pf.longTasks.reduce((sum, task) => sum + task.d, 0),
  };
}

interface RequestSummary {
  count: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  statuses: Record<number, number>;
}

function requestSummary(requests: Array<{ url: string; dur: number; status: number }>, urlIncludes: string): RequestSummary {
  const matched = requests.filter((request) => request.url.includes(urlIncludes));
  const durations = matched.map((request) => request.dur);
  const statuses: Record<number, number> = {};
  for (const request of matched) statuses[request.status] = (statuses[request.status] ?? 0) + 1;
  return {
    count: matched.length,
    totalMs: Math.round(durations.reduce((sum, dur) => sum + dur, 0)),
    p50Ms: Math.round(pct(durations, 0.5) * 10) / 10,
    p95Ms: Math.round(pct(durations, 0.95) * 10) / 10,
    maxMs: Math.round(pct(durations, 1) * 10) / 10,
    statuses,
  };
}

async function collectPf(page: Page): Promise<PfState> {
  return page.evaluate(() => window.__pf);
}

async function bootInbox(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".compose-button")).toBeVisible({ timeout: 120_000 });
  // The header total reflects the server count once the initial page lands;
  // the DOM holds only the virtualized viewport window of rows.
  await expect(page.locator(".message-item").first()).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".message-count")).toHaveText(String(TOTAL), { timeout: 60_000 });
}

/** Scroll to the bottom until every server page has been fetched. Boot loads
 *  page 1 (sometimes 2 via preload), so targetPages-1 scrolls fill the rest;
 *  an iteration that times out at the physical bottom of the virtual list is
 *  already done (nothing left to fetch), not a stall — break instead of
 *  burning a 60s retry. Each near-bottom scroll fires the app's load-more
 *  listener, which appends one page; the fetch sampler in window.__pf is the
 *  completion signal because the virtualized DOM row count never changes. */
async function loadAllPages(page: Page): Promise<{ elapsedMs: number; pages: number; resets: number }> {
  const list = page.locator(".message-list");
  const start = Date.now();
  let pages = 0;
  let resets = 0;
  const targetPages = Math.ceil(TOTAL / 100);
  while (pages < targetPages - 1) {
    const requestsBefore = await page.evaluate(
      () => window.__pf.requests.filter((r) => r.url.startsWith("/api/messages")).length,
    );
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    try {
      await page.waitForFunction(
        (prev) => window.__pf.requests.filter((r) => r.url.startsWith("/api/messages")).length > prev,
        requestsBefore,
        { timeout: 60_000 },
      );
    } catch {
      const atBottom = await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 5);
      if (atBottom) break;
      resets += 1;
      console.warn(`[stress] page ${pages + 1}: no load-more request after scrolling to bottom`);
    }
    pages += 1;
    if (pages % 25 === 0) console.log(`[stress] pages ${pages}/${targetPages - 1}`);
  }
  return { elapsedMs: Date.now() - start, pages, resets };
}

/** Wait for the shared toast slot to show a fresh message (batch job done).
 *  `toastsBefore` must be captured *before* the triggering click: the server
 *  can answer fast enough (PATCH failure ~20ms) that the toast appears and
 *  the sampler records it before this function is even called, so comparing
 *  against a snapshot taken after the click would wait forever. */
async function waitForToast(page: Page, toastsBefore: number, timeoutMs = 600_000): Promise<void> {
  await page.waitForFunction(
    (prev) => window.__pf.toasts.length > prev,
    toastsBefore,
    { timeout: timeoutMs, polling: 250 },
  );
}

async function dismissToastIfPresent(page: Page): Promise<void> {
  const dismiss = page.locator(".toast-dismiss");
  if ((await dismiss.count()) > 0) {
    await dismiss.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForFunction(() => !document.querySelector(".toast"), undefined, { timeout: 15_000 }).catch(() => undefined);
  }
}

test.describe.configure({ mode: "serial" });

test("20k stress: initial render, scroll pagination, batch mark-read, batch move", async ({ page }) => {
  installSampler(page);

  // ---- Phase 1: initial inbox render at 20k -------------------------------
  await test.step("initial inbox render at 20k", async () => {
    await bootInbox(page);
    await expect(page.locator(".sidebar-count").nth(1)).toHaveText(String(UNREAD), { timeout: 60_000 });
    await waitForIdle(page, 2_500, 120_000);

    const pf = await collectPf(page);
    results.initialRender = {
      jank: jankSummary(pf),
      messagesRequests: requestSummary(pf.requests, "/api/messages"),
      statsRequests: requestSummary(pf.requests, "/api/stats"),
      accountsRequests: requestSummary(pf.requests, "/api/accounts"),
      domMessageItems: await page.evaluate(() => document.querySelectorAll(".message-item").length),
      domTotalNodes: await page.evaluate(() => document.getElementsByTagName("*").length),
    };
console.log("[stress] initial render", JSON.stringify(results.initialRender, null, 1));
    persist();
  });

  // ---- Phase 2: infinite scroll to the last page --------------------------
  let batchJankWindow: { from: number; to: number } = { from: 0, to: 0 };
  await test.step("infinite scroll loads all 20k", async () => {
const start = Date.now();
    const pfBefore = await collectPf(page);
    const pagination = await loadAllPages(page);
    const pfAfter = await collectPf(page);
    batchJankWindow = { from: pfBefore.frames[pfBefore.frames.length - 1] ?? 0, to: pfAfter.frames[pfAfter.frames.length - 1] ?? Number.POSITIVE_INFINITY };

    const pf = await collectPf(page);
    results.scrollPagination = {
      elapsedMs: Date.now() - start,
      pages: pagination.pages,
      resets: pagination.resets,
      virtualViewportHeight: await page.evaluate(
        () => document.querySelector<HTMLElement>(".message-list-viewport")?.style.height ?? null,
      ),
      requests: requestSummary(pf.requests, "/api/messages"),
      jank: jankSummary(pf, batchJankWindow.from, batchJankWindow.to),
      domMessageItems: await page.evaluate(() => document.querySelectorAll(".message-item").length),
      domTotalNodes: await page.evaluate(() => document.getElementsByTagName("*").length),
    };
console.log("[stress] scroll pagination", JSON.stringify(results.scrollPagination, null, 1));
    persist();
  });

  // ---- Phase 3: batch mark-read of everything ------------------------------
await test.step("batch mark-read of 20k", async () => {
    await dismissToastIfPresent(page);
    await page.locator(".selection-toggle").click();
    await expect(page.locator(".list-toolbar-frame")).toHaveClass(/selection-on/, { timeout: 30_000 });
    await page.locator(".selection-select-all").click();
    // Two-step select-all upgrades to the whole matching view (predicate job);
    // the counter then shows the server total.
    await expect(page.locator(".selection-count")).toContainText(String(TOTAL), { timeout: 60_000 });

    const t0 = Date.now();
    const toastsBefore = await page.evaluate(() => window.__pf.toasts.length);
    await page.locator(".selection-action").first().click();
    await waitForToast(page, toastsBefore, 600_000);
    const elapsedMs = Date.now() - t0;
    await waitForIdle(page, 3_000, 300_000);

    const pf = await collectPf(page);
    const lastToast = pf.toasts[pf.toasts.length - 1];
    results.batchMarkRead = {
      elapsedMs,
      flagsRequests: requestSummary(pf.requests, "/api/messages/batch/flags"),
      jobRequests: requestSummary(pf.requests, "/api/batch-jobs"),
      apiRequestsTotalMs: requestSummary(pf.requests, "/api/messages").totalMs,
      toastText: lastToast?.text ?? null,
      toastKind: lastToast?.kind ?? null,
      unreadBadgeAfter: await page.locator(".sidebar-count").nth(1).textContent(),
      jank: jankSummary(pf),
    };
    console.log("[stress] batch mark-read", JSON.stringify(results.batchMarkRead, null, 1));
    persist();

    // The job updates the server DB directly; the badge after the silent
    // reload reflects server truth (recorded above, not asserted — a dead
    // IMAP in the seed means no external sync happens).
    if (!results.batchMarkRead.toastKind) {
      console.warn("[stress] phase 3: no toast captured for batch mark-read");
    }
  });

// ---- Phase 4: batch move (archive) of everything --------------------------
  await test.step("batch archive of 20k (server job)", async () => {
    await dismissToastIfPresent(page);
    // Flags job never exits selection mode; the move job does (or rolls back
    // into it when the seed account rejects).
    await expect(page.locator(".list-toolbar-frame")).toHaveClass(/selection-on/, { timeout: 30_000 });
    const t0 = Date.now();
    const toastsBefore = await page.evaluate(() => window.__pf.toasts.length);
    await page.locator(".selection-action").nth(4).click();
    await waitForToast(page, toastsBefore, 600_000);
    const elapsedMs = Date.now() - t0;
    await waitForIdle(page, 3_000, 300_000);

    const pf = await collectPf(page);
    const lastToast = pf.toasts[pf.toasts.length - 1];
    results.batchMove20k = {
      elapsedMs,
      jobRequests: requestSummary(pf.requests, "/api/batch-jobs"),
      toastText: lastToast?.text ?? null,
      toastKind: lastToast?.kind ?? null,
      jank: jankSummary(pf),
    };
console.log("[stress] batch archive 20k", JSON.stringify(results.batchMove20k, null, 1));
    persist();
  });

// ---- Phase 5: small (in-viewport) selection archive -----------------------
  await test.step("in-viewport selection archive", async () => {
    await dismissToastIfPresent(page);
    // Phase 4's move exits selection mode when it succeeds, but rolls back
    // into it (failed ids re-selected) when the server rejects — the seed
    // account always rejects. Normalize by exiting explicitly so the
    // hand-picked rows below start from a clean slate.
    const frame = page.locator(".list-toolbar-frame");
    if (await frame.evaluate((el) => el.classList.contains("selection-on"))) {
      await page.locator(".selection-done").click({ timeout: 30_000 });
    }
    await expect(frame).not.toHaveClass(/selection-on/, { timeout: 30_000 });
    console.log("[stress] phase 5: re-enter selection mode");
    await page.locator(".selection-toggle").click({ timeout: 60_000 });
    await expect(frame).toHaveClass(/selection-on/, { timeout: 30_000 });
    const items = page.locator(".message-item");
    const visible = await items.count();
    const clickStart = Date.now();
    for (let i = 0; i < visible; i += 1) {
      await items.nth(i).click({ timeout: 30_000 });
      if (i % 10 === 9) console.log(`[stress] phase 5: ${i + 1}/${visible} items selected`);
    }
    const selectionMs = Date.now() - clickStart;
    await expect(page.locator(".selection-count")).toContainText(String(visible), { timeout: 60_000 });

    const t0 = Date.now();
    const toastsBefore = await page.evaluate(() => window.__pf.toasts.length);
    await page.locator(".selection-action").nth(4).click();
    await waitForToast(page, toastsBefore, 300_000);
    const elapsedMs = Date.now() - t0;

    const pf = await collectPf(page);
    const lastToast = pf.toasts[pf.toasts.length - 1];
    results.smallMove = {
      selectedRows: visible,
      selectionMs,
      elapsedMs,
      moveRequests: requestSummary(pf.requests, "/api/messages/batch/move"),
      toastText: lastToast?.text ?? null,
      toastKind: lastToast?.kind ?? null,
      jank: jankSummary(pf),
    };
console.log("[stress] small move", JSON.stringify(results.smallMove, null, 1));
    persist();
  });

  results.consoleErrors = consoleErrors.slice(0, 20);
  results.pageErrors = pageErrors.slice(0, 20);
  results.consoleErrorTotal = consoleErrors.length;
  results.pageErrorTotal = pageErrors.length;

  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, "results-spec.json"), JSON.stringify(results, null, 2));
});
