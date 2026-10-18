import path from "node:path";
import { defineConfig } from "@playwright/test";
process.env.REVIEW_QUEUE_CONNECTED = "1";
export default defineConfig({
  testDir: ".", testMatch: "review-queues.spec.ts", workers: 1, retries: 0, fullyParallel: false, reporter: "list", timeout: 60000,
  use: { baseURL: "http://127.0.0.1:16950", headless: true, viewport: { width: 1440, height: 900 }, screenshot: "only-on-failure", ...(process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === "1" ? { channel: "chrome" } : {}) },
  webServer: { cwd: path.resolve(import.meta.dirname, ".."), command: "bun tests-e2e/review-queue-connected-server.ts", url: "http://127.0.0.1:16950/api/review-queues", reuseExistingServer: false, timeout: 30000 },
});
