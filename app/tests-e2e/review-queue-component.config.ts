import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir:".",testMatch:"review-queues.spec.ts",workers:1,retries:0,fullyParallel:false,reporter:"list",timeout:60000,
  use:{ baseURL:"http://127.0.0.1:16947",headless:true,viewport:{ width:1440,height:900 },screenshot:"only-on-failure",...(process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === "1" ? { channel:"chrome" } : {}) },
  webServer:{ cwd:path.resolve(import.meta.dirname,".."),command:"bun tests-e2e/review-queue-component-server.ts",url:"http://127.0.0.1:16947/fixture-health",reuseExistingServer:false,timeout:30000 },
});
