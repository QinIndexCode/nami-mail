import { defineConfig } from "@playwright/test";

/**
 * Real-chain e2e: renderer -> vite proxy -> Fastify -> SQLite.
 *
 * Kept in a separate config from playwright.config.ts on purpose. That config
 * reuses whatever dev server is already running and the demo shell never
 * touches the API, so this one needs its own isolated fixture server on its own
 * port, with its own seeded database — never the developer's real mailbox.
 */

const webPort = 5174;
const apiPort = 3199;
const webUrl = `http://127.0.0.1:${webPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/real-chain.spec.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // The fixture server and the seeded database are shared, and the specs assert
  // on server-side totals, so they must not interleave.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: webUrl,
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // Seeds a 6-message database, then runs the server against it.
      command: "node scripts/e2e-real/serve-fixture.mjs --port " + apiPort + " --count 6 --dir data/e2e-real",
      url: `${apiUrl}/api/stats`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `npm --workspace @nami/web run dev -- --port ${webPort}`,
      url: webUrl,
      // The proxy target is part of this server's identity: reusing a dev server
      // that proxies to 3187 would silently point the run at the wrong backend.
      reuseExistingServer: false,
      timeout: 90_000,
      env: { NAMI_API_PORT: apiPort },
    },
  ],
});
