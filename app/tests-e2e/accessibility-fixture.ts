import { test as browserTest, expect } from "./trusted-browser-fixture";
import { accessibilityRuntime } from "../../tests/helpers/accessibility-runtime";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type NativeHost = ReturnType<typeof accessibilityRuntime> & { profile: string };

export const test = browserTest.extend<{ auditHost: NativeHost }>({
  auditHost: async ({}, use, testInfo) => {
    const installed = process.env.RUNPHANTOM_TEST_BROWSER_MODULE;
    if (!installed) throw new Error("Native audit fixture requires the explicitly selected installed runtime");
    const profile = mkdtempSync(path.join(tmpdir(), "rp-accessibility-ui-")), runtime = accessibilityRuntime(profile, installed);
    try { await use({ ...runtime, profile }); }
    finally {
      writeFileSync(runtime.release, "release");
      const births = existsSync(runtime.pidFile) ? readFileSync(runtime.pidFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
      for (const row of births) { let reaped = false; try { process.kill(row.pid, 0); } catch { reaped = true; } row.reaped = reaped; expect(reaped).toBe(true); }
      writeFileSync(testInfo.outputPath("f35-native-process-proof.json"), JSON.stringify({ claim: "actual source-runtime UI native fixture; no copied executable qualification", installed, births }, null, 2));
      writeFileSync(testInfo.outputPath("f35-native-runtime-wrapper.mjs"), readFileSync(runtime.module));
      rmSync(profile, { recursive: true, force: true });
    }
  },
  browserApp: async ({ auditHost }, use, testInfo) => {
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(key)));
    const proc = spawn("bun", ["--no-env-file", "src/index.ts", "serve"], { cwd: repo, env: { ...env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_DB_PATH: path.join(auditHost.profile, "runs.db"), RUNPHANTOM_BROWSER_ARTIFACTS: path.join(auditHost.profile, "artifacts"), RUNPHANTOM_SKIP_WORKSPACE_ACTIVATE: "1", RUNPHANTOM_BROWSER_MODULE: auditHost.module }, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostic = ""; for (const stream of [proc.stdout, proc.stderr]) stream?.on("data", chunk => { if (diagnostic.length < 4000) diagnostic += chunk; });
    const ended = new Promise<void>(resolve => proc.once("close", () => resolve())), url = `http://127.0.0.1:${port}`;
    const birth = spawnSync("ps", ["-p", String(proc.pid), "-o", "lstart=,command="], { encoding: "utf8" }).stdout.trim();
    try {
      const deadline = Date.now() + 15000; let healthy = false;
      while (Date.now() < deadline) { if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Controlled source daemon exited: ${diagnostic}`); try { if ((await fetch(`${url}/health`)).ok) { healthy = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 25)); }
      expect(healthy).toBe(true); await use({ url });
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) { proc.kill("SIGTERM"); const force = setTimeout(() => proc.kill("SIGKILL"), 15000); await ended; clearTimeout(force); }
      let reaped = false; try { process.kill(proc.pid!, 0); } catch { reaped = true; }
      writeFileSync(testInfo.outputPath("f35-source-daemon-proof.json"), JSON.stringify({ source: "current source daemon + built current UI", pid: proc.pid, actualBirthAndCommand: birth, cwd: repo, listener: url, exited: proc.exitCode, signal: proc.signalCode, reaped, providerCredentials: "blank", reseed: false }, null, 2)); expect(reaped).toBe(true);
    }
  },
});
export { expect };
