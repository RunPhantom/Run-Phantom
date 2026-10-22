import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");

test("installed browser selection refuses a missing artifact instead of starting a source daemon", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runphantom-native-negative-"));
  try {
    const report = path.join(directory, "results.json");
    const child = spawn("node", ["app/node_modules/@playwright/test/cli.js", "test", "--config", "app/playwright.config.ts",
      "native-fixture.spec.ts", "--project=chromium", "--workers=1", "--retries=0", "--reporter=json"], {
      cwd: root,
      env: { ...process.env, RUNPHANTOM_E2E_RUNTIME: "installed", RUNPHANTOM_E2E_BINARY: path.join(directory, "missing"),
        RUNPHANTOM_E2E_SHA256: "0".repeat(64), PLAYWRIGHT_JSON_OUTPUT_NAME: report },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    }).finally(() => clearTimeout(timer));
    const results = JSON.parse(await readFile(report, "utf8")) as { stats: { unexpected: number }; suites: unknown[] };
    expect(exit).toBe(1);
    expect(results.stats.unexpected).toBe(1);
    expect(JSON.stringify(results.suites)).toContain("native_artifact_missing");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 35_000);
