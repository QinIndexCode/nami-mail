import { expect, test, type Page } from "@playwright/test";

/**
 * Real-chain smoke: renderer -> vite proxy -> Fastify -> SQLite.
 *
 * Every other spec in this directory boots `/?demo=1`, where `isDemo`
 * short-circuits each load in App.tsx and substitutes fixture data. That is the
 * right trade for UI work, but it means the request path itself — proxy target,
 * token-less Host allowlist, DTO shape, error mapping, payload decryption — had
 * no browser-level coverage at all. A past regression took this exact route:
 * `npm run dev` returned 403 on every /api call while 870 unit tests stayed
 * green, because the tests injected the app and never opened a socket.
 *
 * So this spec asserts the seam rather than the styling: it must render data it
 * can only have gotten from the server, and it must not render data it could
 * only have gotten from the demo fixtures.
 */

/** The fixture server, which Playwright started for this run. */
const API = "http://127.0.0.1:3199";

/** Reads a JSON endpoint from the fixture server, outside the browser. */
async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`);
  expect(response.ok, `GET ${path} -> ${response.status}`).toBe(true);
  return (await response.json()) as T;
}

type Stats = { messages: number; unread: number };
type Account = { id: string; email: string; providerName: string };
type Message = { id: string; subject: string; seen: boolean; textBody: string; htmlBody: string };

/**
 * Opens the app the way a user does — no `?demo=1` — and waits for the first
 * server-backed list. The first-run translation-terms gate is real state on a
 * fresh database, so it has to be dismissed exactly as a user would.
 */
async function bootRealApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#nami-splash")).toHaveClass(/done/, { timeout: 30_000 });
  const terms = page.locator(".translation-terms-card");
  if (await terms.isVisible().catch(() => false)) {
    await terms.locator(".primary-button").click();
  }
  await expect(page.locator(".message-item").first()).toBeVisible({ timeout: 30_000 });
}

/** The fixture message this spec opens: its HTML body carries a remote image. */
const TRACKING_SUBJECT = "含远程图片的邮件";

/**
 * The list DTO deliberately omits `html_body` (a row is not a body), so the
 * fixture is located by the subject it does expose and opened through the UI,
 * which is the path that fetches and decrypts the real payload.
 */
async function trackingPixelMessage(): Promise<string> {
  const listed = await api<{ items: Message[] }>("/api/messages?pageSize=100");
  const row = listed.items.find((message) => message.subject === TRACKING_SUBJECT);
  expect(row, `fixture message "${TRACKING_SUBJECT}" is missing from the server list`).toBeTruthy();
  return row!.id;
}

test.describe("real chain (no demo fixtures)", () => {
  test("renders the seeded account and server-backed message list", async ({ page }) => {
    const stats = await api<Stats>("/api/stats");
    const accounts = await api<Account[]>("/api/accounts");
    expect(accounts.length).toBeGreaterThan(0);

    await bootRealApp(page);

    // The list must reflect the server's own totals. `stats.messages` is only
    // knowable over HTTP, so this is the assertion that fails if the UI quietly
    // falls back to demo data.
    await expect(page.locator(".message-count")).toHaveText(String(stats.messages), { timeout: 30_000 });

    // The seeded account exists only in the database. Its address is the
    // button's accessible name rather than its visible text, which shows the
    // row carries the real address and not a placeholder.
    await expect(page.getByRole("button", { name: accounts[0].email })).toBeVisible();
    // ...and so does a subject the demo fixtures do not use.
    await expect(page.getByText("含远程图片的邮件").first()).toBeVisible();
  });

  test("decrypts and renders a stored HTML body", async ({ page }) => {
    await trackingPixelMessage();
    await bootRealApp(page);
    await page.getByText(TRACKING_SUBJECT).first().click();

    // The body text lives inside the encrypted payload, so seeing it proves the
    // read path fetched and decrypted with the fixture's master key.
    await expect(page.locator(".mail-html")).toContainText("附件中的文档请在本周五前完成评审。");
  });

  test("never requests a remote mail image directly", async ({ page }) => {
    await trackingPixelMessage();

    // Record every outbound request so a direct fetch to the sender's host is
    // observable. `.invalid` never resolves, so without the rewrite the image
    // would fail — silently, and only visible here.
    //
    // Matched on the origin, not on a substring: a proxied request carries the
    // sender's host percent-encoded inside its own query string, so a substring
    // test would flag the very request that proves the defence works.
    const directRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith("https://tracker.invalid")) directRequests.push(request.url());
    });

    await bootRealApp(page);
    await page.getByText(TRACKING_SUBJECT).first().click();
    await expect(page.locator(".mail-html")).toBeVisible();
    // Give any direct image fetch a chance to be issued before asserting.
    await page.waitForTimeout(1_000);

    // The rendered source itself must already point at the proxy: that holds
    // even though the host never resolves, so this cannot pass by luck.
    const renderedSrc = await page.locator(".mail-html img").first().getAttribute("src");
    expect(renderedSrc, "the mail image was not rewritten to the proxy").toContain("/api/images/proxy?url=");

    expect(directRequests, "the renderer fetched the sender's image host directly").toEqual([]);
  });
});
