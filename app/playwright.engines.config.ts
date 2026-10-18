import { defineConfig } from "@playwright/test";
if (!process.env.RUNPHANTOM_F47_LOCK_PID || !process.env.RUNPHANTOM_F47_MODULE || !process.env.RUNPHANTOM_F47_OUTPUT || !process.env.RUNPHANTOM_F47_UI_EXECUTABLE) throw new Error("BLOCKED: dedicated owned browser runner and explicit installed engine required");
export default defineConfig({
  testDir: "./tests-e2e/browser-engine-qualification",
  testMatch: "**/*.journey.ts",
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["json"]],
  use: { headless: true, viewport: { width: 1280, height: 900 }, actionTimeout: 15_000, navigationTimeout: 20_000, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: ["chromium", "firefox", "webkit"].map(name => ({ name, use: { browserName: name as "chromium" | "firefox" | "webkit", launchOptions: { executablePath: process.env.RUNPHANTOM_F47_UI_EXECUTABLE } } })),
});
