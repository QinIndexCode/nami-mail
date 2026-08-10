/**
 * UI stress spec �?measures the mail list at scale against a seeded local
 * server (see scripts/ui-stress/seed-data.mjs + run-stress.mjs).
 *
 * One long serial test so the 20k-item list is loaded exactly once and shared
 * across phases:
 *   1. Initial inbox render at 20k          �?first paint, API timings, DOM cost
 *   2. Scroll pagination to the last page   �?200 sequential page fetches
 *   3. Batch mark-read of all 20k           �?chunked PATCHes against a dead IMAP
 *   4. Batch move (archive) of all 20k      �?capped server schema vs selection
 *   5. Small selection move                 �?100-item archive fast-fail
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
    let lastToastText = "";
    function sampleToast() {
      const el = document.querySelector(".toast");
      const text = el?.textContent?.trim() ?? "";
      if (text && text !== lastToastText) {
        pf.toasts.push({ text, kind: el?.className ?? "", t: performance.now() });
        lastToastText = text;
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
  await expect(page.locator(".message-item")).toHaveCount(100, { timeout: 120_000 });
}

async function loadAllPages(page: Page): Promise<{ elapsedMs: number; pages: number; resets: number }> {
  const footer = page.locator(".list-footer .secondary-button");
  const start = Date.now();
  let pages = 0;
  let resets = 0;
  const maxPages = Number.parseInt(process.env.STRESS_MAX_PAGES ?? "0", 10) || 0;
  const pageCap = maxPages > 0 ? maxPages : TOTAL;
  while ((await footer.count()) > 0 && pages < pageCap) {
    const t0 = Date.now();
    await expect(footer).toBeVisible({ timeout: 60_000 });
    await footer.scrollIntoViewIfNeeded();
    const previous = await page.locator(".message-item").count();
    const t1 = Date.now();
    await footer.click();
    pages += 1;
    const t2 = Date.now();
    await page.waitForFunction(
      (previousCount) => {
        const count = document.querySelectorAll(".message-item").length;
        return count > previousCount || count < previousCount;
      },
      previous,
      { timeout: 60_000 },
    );
    const t3 = Date.now();
    const after = await page.locator(".message-item").count();
    if (after < previous) {
      resets += 1;
      console.warn(`[stress] page ${pages}: list reset to ${after} (was ${previous}) — silent refresh or reload`);
    }
    console.log(`[stress] page ${pages}: pre-click ${t1 - t0}ms, click ${t2 - t1}ms, settle ${t3 - t2}ms, items ${after}`);
  }
  return { elapsedMs: Date.now() - start, pages, resets };
}

async function waitForBatchDone(page: Page, timeoutMs = 900_000): Promise<void> {
  await page.waitForFunction(
    () => !document.querySelector(".selection-action")?.hasAttribute("disabled"),
    undefined,
    { timeout: timeoutMs },
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
    await expect(page.locator(".message-count")).toHaveText(String(TOTAL), { timeout: 60_000 });
    await expect(page.locator(".sidebar-count").nth(1)).toHaveText(String(UNREAD), { timeout: 60_000 });
    await waitForIdle(page, 2_500, 120_000);

    const pf = await collectPf(page);
    const messagesRequests = requestSummary(pf.requests, "/api/messages");
    results.initialRender = {
      jank: jankSummary(pf),
      messagesRequests,
      statsRequests: requestSummary(pf.requests, "/api/stats"),
      accountsRequests: requestSummary(pf.requests, "/api/accounts"),
      domMessageItems: await page.evaluate(() => document.querySelectorAll(".message-item").length),
      domTotalNodes: await page.evaluate(() => document.getElementsByTagName("*").length),
    };
console.log("[stress] initial render", JSON.stringify(results.initialRender, null, 1));
    persist();
  });

  // ---- Phase 2: scroll pagination to the last page ------------------------
  let batchJankWindow: { from: number; to: number } = { from: 0, to: 0 };
  await test.step("scroll pagination loads all 20k", async () => {
const start = Date.now();
    const pfBefore = await collectPf(page);
    const pagination = await loadAllPages(page);
    const pfAfter = await collectPf(page);
    // The periodic silent refresh can reset the accumulated list back to page
    // 1; when it does, the loop records the reset and keeps going, so no count
    // assertion is made here — the data tells whether the end was reached.
    const finalCount = await page.locator(".message-item").count();
    batchJankWindow = { from: pfBefore.frames[pfBefore.frames.length - 1] ?? 0, to: pfAfter.frames[pfAfter.frames.length - 1] ?? Number.POSITIVE_INFINITY };

    const pf = await collectPf(page);
    results.scrollPagination = {
      elapsedMs: Date.now() - start,
      pages: pagination.pages,
      requests: requestSummary(pf.requests, "/api/messages"),
      jank: jankSummary(pf, batchJankWindow.from, batchJankWindow.to),
      domMessageItems: await page.evaluate(() => document.querySelectorAll(".message-item").length),
      domTotalNodes: await page.evaluate(() => document.getElementsByTagName("*").length),
    };
console.log("[stress] scroll pagination", JSON.stringify(results.scrollPagination, null, 1));
    persist();
  });

  // ---- Phase 3: batch mark-read of everything loaded -----------------------
await test.step("batch mark-read of 20k", async () => {
    await page.locator(".selection-toggle").click();
    await page.locator(".selection-select-all").click();
    const loadedCount = await page.locator(".message-item").count();
    await expect(page.locator(".selection-count")).toContainText(String(loadedCount), { timeout: 60_000 });

    const t0 = Date.now();
    await page.locator(".selection-action").first().click();
    await waitForBatchDone(page);
    const elapsedMs = Date.now() - t0;
    await waitForIdle(page, 3_000, 300_000);

    const pf = await collectPf(page);
    const flagsRequests = requestSummary(pf.requests, "/api/messages/batch/flags");
    const toast = pf.toasts[pf.toasts.length - 1];
    results.batchMarkRead = {
      elapsedMs,
      flagsRequests,
      apiRequestsTotalMs: flagsRequests.totalMs,
      toastText: toast?.text ?? null,
      toastKind: toast?.kind ?? null,
      unreadBadgeAfter: await page.locator(".sidebar-count").nth(1).textContent(),
      unreadRowsAfter: await page.locator(".message-item.unread").count(),
      selectedCountAfter: await page.locator(".selection-count").textContent(),
      jank: jankSummary(pf),
    };
    console.log("[stress] batch mark-read", JSON.stringify(results.batchMarkRead, null, 1));
    persist();

    // Remote flags were never persisted (dead IMAP); the UI must have reverted
    // to the server-authoritative unread state after the reload.
    await expect(page.locator(".sidebar-count").nth(1)).toHaveText(String(UNREAD), { timeout: 120_000 });
    if (results.batchMarkRead.toastKind) {
      expect(String(results.batchMarkRead.toastKind)).toContain("error");
    } else {
      console.warn("[stress] phase 3: no toast captured for batch mark-read");
    }
  });

// ---- Phase 4: batch move (archive) of everything loaded ------------------
  await test.step("batch archive of 20k (server schema cap)", async () => {
    await dismissToastIfPresent(page);
    const t0 = Date.now();
    await page.locator(".selection-action").nth(4).click();
    await waitForBatchDone(page, 300_000);
    const elapsedMs = Date.now() - t0;
    await waitForIdle(page, 3_000, 300_000);

    const pf = await collectPf(page);
    const moveRequests = requestSummary(pf.requests, "/api/messages/batch/move");
    const toast = pf.toasts[pf.toasts.length - 1];
    results.batchMove20k = {
      elapsedMs,
      moveRequests,
      toastText: toast?.text ?? null,
      toastKind: toast?.kind ?? null,
      jank: jankSummary(pf),
    };
console.log("[stress] batch archive 20k", JSON.stringify(results.batchMove20k, null, 1));
    persist();
  });

// ---- Phase 5: small (100-item) selection archive -------------------------
  await test.step("100-item selection archive", async () => {
    await dismissToastIfPresent(page);
    // Phase 4's move always exits selection mode in its finally (even on
    // failure), so the toolbar must be gone here; re-enter selection.
    await expect(page.locator(".selection-toolbar")).toHaveCount(0, { timeout: 30_000 });
    console.log("[stress] phase 5: re-enter selection mode");
    await page.locator(".selection-toggle").click({ timeout: 60_000 });
    await expect(page.locator(".selection-toolbar")).toHaveCount(1, { timeout: 30_000 });
    const items = page.locator(".message-item");
    const clickStart = Date.now();
    for (let i = 0; i < 100; i += 1) {
      await items.nth(i).click({ timeout: 60_000 });
      if (i % 25 === 24) console.log(`[stress] phase 5: ${i + 1}/100 items selected`);
    }
    const selectionMs = Date.now() - clickStart;
    await expect(page.locator(".selection-count")).toContainText("100", { timeout: 60_000 });

    const t0 = Date.now();
    await page.locator(".selection-action").nth(4).click();
    await waitForBatchDone(page, 300_000);
    const elapsedMs = Date.now() - t0;

    const pf = await collectPf(page);
    const toast = pf.toasts[pf.toasts.length - 1];
    results.smallMove = {
      selection100ClicksMs: selectionMs,
      elapsedMs,
      toastText: toast?.text ?? null,
      toastKind: toast?.kind ?? null,
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

