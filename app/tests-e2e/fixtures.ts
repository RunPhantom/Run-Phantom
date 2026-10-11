import { test as base, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startManagedDaemon, type RuntimeProvenance } from "./daemon-runtime";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export type RunPhantomHandle = {
  url: string;
  dbPath: string;
  port: number;
};

type ManagedRunPhantomHandle = RunPhantomHandle & { runtime: RuntimeProvenance };

export const test = base.extend<{ runPhantom: ManagedRunPhantomHandle; localNetworkOnly: void }>({
  localNetworkOnly: [async ({ page }, use) => {
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      const isDocumentLocal = ["about:", "blob:", "data:"].includes(url.protocol);
      if (isLocal || isDocumentLocal) await route.continue();
      else await route.abort("blockedbyclient");
    });
    await use();
  }, { auto: true }],
  runPhantom: async ({}, use, testInfo) => {
    const daemon = await startManagedDaemon(REPO_ROOT, process.env, testInfo.workerIndex);
    await testInfo.attach("runphantom-runtime-start", { body: JSON.stringify(daemon.runtime, null, 2), contentType: "application/json" });
    try {
      await use(daemon);
    } finally {
      const cleanup = await daemon.stop();
      await testInfo.attach("runphantom-runtime-cleanup", { body: JSON.stringify({ runtime: daemon.runtime, ...cleanup }, null, 2), contentType: "application/json" });
    }
  },
});

export { expect };
export const REPO_ROOT_PATH = REPO_ROOT;
