import { defineConfig } from "@playwright/test";

const webUrl = "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: webUrl,
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm --workspace @nami/web run dev -- --port 5173",
    url: webUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
