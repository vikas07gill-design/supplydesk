import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  globalTimeout: 10 * 60 * 1000,
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { outputFolder: "playwright-report", open: "never" }], ["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || "https://supplydesk.in",
    extraHTTPHeaders: process.env.E2E_TEST_KEY ? { "x-e2e-key": process.env.E2E_TEST_KEY } : {},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ...devices["Desktop Chrome"]
  }
});
