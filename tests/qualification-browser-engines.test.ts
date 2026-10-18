import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { accepted, ENGINES, matrix, reportOutcome, summarize, privateEnvironment, type EngineIdentity } from "../scripts/qualification/browser-engines";
const identities: EngineIdentity[] = ENGINES.map(engine => ({ engine, executable: `/installed/${engine}`, executableSha256: "a".repeat(64), nativeBinary: `/installed/${engine}`, nativeSha256: "a".repeat(64), available: true, reason: null }));
const passed = { collected: 5, passed: 5, failed: 0, skipped: 0, retries: 0, exitCode: 0 };
test("an absent engine cannot qualify even with copied green test counts", () => {
  const cells = matrix("darwin-arm64", identities.map(item => item.engine === "firefox" ? { ...item, available: false, reason: "installed-engine-missing" } : item), { firefox: passed }, 5);
  expect(cells.filter(cell => cell.platform === "darwin-arm64" && cell.engine === "firefox").every(cell => cell.status === "BLOCKED")).toBe(true);
  expect(summarize(cells)).toMatchObject({ accepted: false, exitCode: 2 });
});
test("zero collection, skips, retries, expected failures and nonzero process exit fail exact execution", () => {
  expect(accepted(passed, 5)).toBe(true);
  for (const altered of [{ ...passed, collected: 0 }, { ...passed, skipped: 1 }, { ...passed, retries: 1 }, { ...passed, failed: 1 }, { ...passed, exitCode: 2 }, { ...passed, passed: 3 }]) expect(accepted(altered, 5)).toBe(false);
  const result = reportOutcome({ suites: [{ specs: [{ tests: [{ expectedStatus: "failed", results: [{ status: "passed" }] }, { results: [{ status: "failed" }, { status: "passed", retry: 1 }] }, { results: [{ status: "skipped" }] }] }] }] }, 0);
  expect(result).toEqual({ collected: 3, passed: 1, failed: 1, skipped: 1, retries: 1, exitCode: 0 });
});
test("available base success does not fill other native hosts or integrated recordings and new UI cells", () => {
  const cells = matrix("darwin-arm64", identities, { chromium: { ...passed, nativeAudit: true }, firefox: passed, webkit: passed }, 5);
  expect(cells.filter(cell => cell.platform === "darwin-arm64" && cell.capability === "trusted-outcome").map(cell => cell.status)).toEqual(["PASSED", "PASSED", "PASSED"]);
  expect(cells.find(cell => cell.platform === "darwin-arm64" && cell.engine === "chromium" && cell.capability === "native-accessibility")?.status).toBe("PASSED");
  expect(cells.filter(cell => cell.capability === "F37-recordings").every(cell => cell.status === "BLOCKED")).toBe(true);
  expect(cells.filter(cell => cell.platform === "win32-x64").every(cell => cell.status === "BLOCKED")).toBe(true);
  expect(cells.find(cell => cell.platform === "darwin-arm64" && cell.engine === "firefox" && cell.capability === "native-accessibility")?.reason).toBe("product-audit-engine-unsupported");
  expect(summarize(cells).accepted).toBe(false);
});
test("private child environment does not inherit credentials or arbitrary host settings", () => {
  const before = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = "/private/fixture";
  try { const env = privateEnvironment("/owned/profile"); expect(env.HOME).toBe("/owned/profile"); expect(env.USERPROFILE).toBe("/owned/profile"); expect(env.CLAUDE_CONFIG_DIR).toBeUndefined(); expect(Object.keys(env).some(key => key.includes("API_KEY") || key.includes("TOKEN"))).toBe(false); }
  finally { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; }
});
test("dedicated journey filenames and config cannot join the original default spec roster", () => {
  const config = readFileSync(new URL("../app/playwright.engines.config.ts", import.meta.url), "utf8");
  expect(config).toContain('testMatch: "**/*.journey.ts"'); expect(config).toContain('testDir: "./tests-e2e/browser-engine-qualification"');
  expect(config).toContain("retries: 0"); expect(config).toContain("workers: 1"); expect(config).toContain("forbidOnly: true");
});

test("direct config invocation refuses missing runtime before any browser journey can start", () => {
  const config = fileURLToPath(new URL("../app/playwright.engines.config.ts", import.meta.url));
  const child = spawnSync(process.execPath, ["--no-env-file", "-e", `await import(${JSON.stringify(config)})`], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR! }, encoding: "utf8", timeout: 10_000 });
  expect(child.status).not.toBe(0); expect(child.stderr).toContain("BLOCKED: dedicated owned browser runner");
});
