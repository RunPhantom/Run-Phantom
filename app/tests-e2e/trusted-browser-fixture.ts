import { test as base, expect } from "./fixtures";
import { createServer } from "node:http";
import { createServer as portServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRUSTED_BROWSER_FIXTURE_HTML } from "../../tests/helpers/trusted-browser-fixture-html";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const test = base.extend<{ browserApp: { url: string }; browserTarget: { origin: string; events: { type: string; trusted: boolean; value?: string }[] } }>({
  browserTarget: async ({}, use) => {
    const events: { type: string; trusted: boolean; value?: string }[] = [];
    const target = createServer((request, response) => {
      if (request.url === "/events") { let body = ""; request.on("data", chunk => { if (body.length < 8192) body += chunk; }); request.on("end", () => { events.push(JSON.parse(body)); response.end("recorded"); }); return; }
      if (request.url === "/accepted") { response.writeHead(202); response.end("accepted"); return; }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(TRUSTED_BROWSER_FIXTURE_HTML);
    }); target.listen(0, "127.0.0.1"); await once(target, "listening");
    try { await use({ origin: `http://127.0.0.1:${(target.address() as { port: number }).port}`, events }); }
    finally { target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); }
  },
  browserApp: async ({}, use, testInfo) => {
    const profile = mkdtempSync(path.join(tmpdir(), "rp-browser-ui-")); const reservation = portServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening"); const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(key)));
    const proc = spawn("bun", ["--no-env-file", "src/index.ts", "serve"], { cwd: repo, env: { ...env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_DB_PATH: path.join(profile, "runs.db"), RUNPHANTOM_BROWSER_ARTIFACTS: path.join(profile, "artifacts"), RUNPHANTOM_SKIP_WORKSPACE_ACTIVATE: "1", RUNPHANTOM_BROWSER_MODULE: process.env.RUNPHANTOM_TEST_BROWSER_MODULE, RUNPHANTOM_BROWSER_CACHE: process.env.RUNPHANTOM_TEST_BROWSER_CACHE }, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostic = ""; for (const stream of [proc.stdout, proc.stderr]) stream?.on("data", chunk => { if (diagnostic.length < 4000) diagnostic += chunk; });
    const ended = new Promise<void>(resolve => proc.once("close", () => resolve())); const url = `http://127.0.0.1:${port}`;
    try {
      const until = Date.now() + 15000; let healthy = false;
      while (Date.now() < until) { if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Controlled source daemon exited: ${diagnostic}`); try { if ((await fetch(`${url}/health`)).ok) { healthy = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 25)); }
      expect(healthy).toBe(true); await use({ url });
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) { proc.kill("SIGTERM"); const force = setTimeout(() => proc.kill("SIGKILL"), 15000); await ended; clearTimeout(force); }
      let reaped = false; try { process.kill(proc.pid!, 0); } catch { reaped = true; }
      writeFileSync(testInfo.outputPath("f28-source-daemon-proof.json"), JSON.stringify({ execution: "source-runtime UI", pid: proc.pid, cwd: repo, exited: proc.exitCode, signal: proc.signalCode, reaped, providers: "blank", fixture: "local controlled browser target" }, null, 2)); expect(reaped).toBe(true); rmSync(profile, { recursive: true, force: true });
    }
  },
});
export { expect };
