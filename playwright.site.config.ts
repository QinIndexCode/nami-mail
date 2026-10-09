import { defineConfig } from "@playwright/test";

const siteUrl = "http://127.0.0.1:5176";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/site/*.test.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: siteUrl,
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/preview-site.mjs",
    url: siteUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
