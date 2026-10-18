import { test as base, expect, type Browser, type BrowserServer, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { createServer as reserveServer } from "node:net";
import { once } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, openSync, closeSync, readSync, readdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { TRUSTED_BROWSER_FIXTURE_HTML } from "../../../tests/helpers/trusted-browser-fixture-html";
import type { BrowserSummary, BrowserObservation } from "../../../src/verification/browser-types";
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const RUN_ID = "47000000000000000000000000000001", SPAN_ID = "4700000000000002", OUTPUT = "F47 captured response Café 東京";
function fileHash(file: string) { const fd = openSync(file, "r"), digest = createHash("sha256"), bytes = Buffer.alloc(1024 * 1024); try { for (;;) { const count = readSync(fd, bytes, 0, bytes.length, null); if (!count) break; digest.update(bytes.subarray(0, count)); } return digest.digest("hex"); } finally { closeSync(fd); } }
export interface NativeEvent { type: string; trusted: boolean; value?: string }
interface ProcessRow { pid: number; parent: number; group: number; executable: string; sha256: string | null }
function descendants(root: number): ProcessRow[] {
  const raw = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,comm="], { encoding: "utf8" });
  if (raw.status !== 0) throw new Error("Native process identity unavailable");
  const all = raw.stdout.split("\n").flatMap(line => { const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line); return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), executable: match[4], sha256: null as string | null }] : []; });
  const selected = new Set([root]); for (let changed = true; changed;) { changed = false; for (const row of all) if (selected.has(row.parent) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; } }
  return all.filter(row => row.pid !== root && selected.has(row.pid)).map(row => ({ ...row, sha256: existsSync(row.executable) ? fileHash(row.executable) : null }));
}
function gone(pid: number) { try { process.kill(pid, 0); return false; } catch { return true; } }
async function until(check: () => Promise<boolean> | boolean, ms = 15_000) {
  const end = Date.now() + ms; while (!await check()) { if (Date.now() >= end) throw new Error("Owned qualification condition exceeded its finite deadline"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
async function port() { const server = reserveServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const value = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return value; }
async function closeServer(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
export interface External { browser: Browser; server: BrowserServer; pages: Page[]; endpoint: string; pid: number }
export interface Backend {
  url: string; profile: string; events: NativeEvent[]; target: string; external: External | null;
  api<T>(route: string, body?: unknown, method?: string): Promise<{ status: number; body: T }>;
  observe(id: string): Promise<BrowserObservation>;
  sample(): void;
}
export const test = base.extend<{ backend: Backend; attached: boolean }>({
  attached: [false, { option: true }],
  backend: async ({ browser, browserName, attached }, use, info) => {
    if (!process.env.RUNPHANTOM_F47_MODULE || !process.env.RUNPHANTOM_F47_BUN || !process.env.RUNPHANTOM_F47_OUTPUT) throw new Error("BLOCKED: explicit installed runtime and owned runner required");
    const profile = mkdtempSync(path.join(tmpdir(), "rp-f47-")), cwd = path.join(profile, "empty-cwd"); mkdirSync(cwd);
    const events: NativeEvent[] = [], completions: number[] = []; let duplicate = 0;
    const target = createServer((request, response) => {
      const route = new URL(request.url!, "http://localhost").pathname;
      if (route === "/events") { let bytes = ""; request.on("data", chunk => { if (bytes.length < 8192) bytes += String(chunk); }); request.on("end", () => { events.push(JSON.parse(bytes) as NativeEvent); response.end("recorded"); }); return; }
      if (route === "/accepted") { response.writeHead(202); response.end("accepted"); return; }
      if (route === "/duplicate") { const current = ++duplicate; setTimeout(() => { const status = current === 1 ? 201 : 202; completions.push(status); response.writeHead(status); response.end("recorded fact"); }, current === 1 ? 200 : 10); return; }
      response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(TRUSTED_BROWSER_FIXTURE_HTML.replace("</body>", '<section id="audit-invalid"><button id="unnamed"></button></section><button id="fix-audit">Fix audit</button><script>document.querySelector("#fix-audit").onclick=()=>document.querySelector("#unnamed").setAttribute("aria-label","Named control")</script></body>'));
    }); target.listen(0, "127.0.0.1"); await once(target, "listening"); const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    let external: External | null = null, daemon: ChildProcess | undefined, sentinelTarget: Server | undefined;
    const sampled = new Map<number, ProcessRow>(); let logs = "", teardownError: unknown;
    try {
      if (attached) {
        const appRequire = createRequire(path.join(repo, "app/package.json")); const runtime = appRequire("@playwright/test") as { chromium: typeof import("@playwright/test").chromium };
        const cdpPort = await port(), server = await runtime.chromium.launchServer({ headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
        const connected = await runtime.chromium.connect(server.wsEndpoint()), context = await connected.newContext(), pages = [await context.newPage(), await context.newPage(), await context.newPage()];
        sentinelTarget = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(TRUSTED_BROWSER_FIXTURE_HTML); }); sentinelTarget.listen(0, "127.0.0.1"); await once(sentinelTarget, "listening");
        const sentinelUrl = `http://127.0.0.1:${(sentinelTarget.address() as { port: number }).port}`;
        for (const [i, page] of pages.entries()) { await page.goto(i === 2 ? sentinelUrl : targetUrl); await page.evaluate(index => { document.body.dataset.physicalTab = String(index); document.body.insertAdjacentHTML("beforeend", `<div id="physical${index}">Physical tab ${index}</div>`); }, i); }
        external = { browser: connected, server, pages, endpoint: `http://127.0.0.1:${cdpPort}`, pid: server.process().pid! };
      }
      const daemonPort = await port(), binary = process.env.RUNPHANTOM_F47_BINARY, bun = process.env.RUNPHANTOM_F47_BUN;
      const env: Record<string, string> = { HOME: profile, USERPROFILE: profile, TMPDIR: profile, PATH: process.env.PATH!, LANG: "C.UTF-8", TZ: "UTC", BUN_INSTALL_AUTO: "disable", RUNPHANTOM_DB_PATH: path.join(profile, "runs.sqlite"), RUNPHANTOM_SECRET_STORE_PATH: path.join(profile, "secrets.json"), RUNPHANTOM_PORT: String(daemonPort), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_BROWSER_MODULE: process.env.RUNPHANTOM_F47_MODULE, RUNPHANTOM_BROWSER_ARTIFACTS: path.join(profile, "artifacts"), RUNPHANTOM_SKIP_WORKSPACE_ACTIVATE: "1", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { RUNPHANTOM_BROWSER_CACHE: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}), ...(external ? { RUNPHANTOM_BROWSER_CDP: external.endpoint } : {}) };
      const initialEntries = readdirSync(profile); expect(initialEntries).toEqual(["empty-cwd"]);
      daemon = spawn(binary ?? bun, binary ? ["serve"] : ["--no-env-file", path.join(repo, "src/index.ts"), "serve"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      for (const stream of [daemon.stdout, daemon.stderr]) stream?.on("data", chunk => { if (logs.length < 64 * 1024) logs += String(chunk); });
      const url = `http://127.0.0.1:${daemonPort}`;
      await until(async () => { if (daemon!.exitCode !== null || daemon!.signalCode !== null) throw new Error(`Owned backend failed startup: ${logs}`); try { const response = await fetch(`${url}/health`); return response.ok && (await response.json() as { pid: number }).pid === daemon!.pid; } catch { return false; } });
      const sample = () => { for (const row of descendants(daemon!.pid!)) sampled.set(row.pid, row); };
      const api = async <T,>(route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => { const response = await fetch(url + route, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() as T }; };
      writeFileSync(info.outputPath("runtime.json"), JSON.stringify({ sourceHead: process.env.RUNPHANTOM_F47_HEAD, uiEngine: browserName, uiVersion: browser.version(), uiExecutable: process.env.RUNPHANTOM_F47_UI_EXECUTABLE, uiExecutableSHA256: fileHash(process.env.RUNPHANTOM_F47_UI_EXECUTABLE!), daemon: { mode: binary ? "copied" : "source", executable: binary ?? bun, executableSha256: fileHash(binary ?? bun), pid: daemon.pid, cwd, profile, initialEntries, sameBackendForUIAndAPI: true }, optionalRuntime: process.env.RUNPHANTOM_F47_MODULE, providerKeysPresent: Object.keys(env).some(key => /API_KEY|TOKEN|CLAUDE_CONFIG/.test(key)), productionUI: true, fullIntegratedAcceptance: false }, null, 2));
      await use({ url, profile, target: targetUrl, events, external, api, sample, observe: async id => (await api<BrowserObservation>(`/api/verification/browser/sessions/${id}/events`)).body });
      sample();
    } finally {
      if (daemon) {
        const exited = new Promise<void>(resolve => daemon!.once("close", () => resolve()));
        if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill("SIGTERM"); try { await until(() => daemon!.exitCode !== null || daemon!.signalCode !== null, 15_000); } catch (error) { teardownError = error; daemon.kill("SIGKILL"); } await exited; }
        try { await until(() => [...sampled.values()].every(row => gone(row.pid)), 10_000); } catch (error) { teardownError ??= error; for (const row of sampled.values()) if (!gone(row.pid)) process.kill(row.pid, "SIGKILL"); }
      }
      if (external) { const owned = external; await owned.browser.close(); await owned.server.close(); await until(() => gone(owned.pid)); }
      await closeServer(target); if (sentinelTarget) await closeServer(sentinelTarget);
      const proof = { daemonPid: daemon?.pid, daemonReaped: !daemon?.pid || gone(daemon.pid), processes: [...sampled.values()].map(row => ({ ...row, reaped: gone(row.pid) })), externalPid: external?.pid, externalReaped: !external || gone(external.pid), targetCompletions: completions, controlledEvents: events.map(({ type, trusted }) => ({ type, trusted })), forcedCleanup: Boolean(teardownError) };
      writeFileSync(info.outputPath("teardown.json"), JSON.stringify(proof, null, 2)); writeFileSync(info.outputPath("daemon.log"), logs);
      const clean = proof.daemonReaped && proof.externalReaped && proof.processes.every(row => row.reaped) && !teardownError;
      if (clean) rmSync(profile, { recursive: true, force: true });
      expect(clean, "Owned processes must be reaped before profile removal and lease release").toBe(true);
    }
  },
});
export { expect };
export async function seed(backend: Backend) {
  const time = BigInt(Date.now()) * 1_000_000n;
  const attrs = (input: Record<string, string>) => Object.entries(input).map(([key, value]) => ({ key, value: { stringValue: value } }));
  const response = await backend.api("/v1/traces", { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: RUN_ID, spanId: "4700000000000001", name: "F47 captured run", startTimeUnixNano: String(time), endTimeUnixNano: String(time + 10_000_000n), attributes: attrs({ "runphantom.span.kind": "agent_root", "runphantom.input": "F47 captured task", "runphantom.output": OUTPUT }) }, { traceId: RUN_ID, spanId: SPAN_ID, parentSpanId: "4700000000000001", name: "F47 model output", startTimeUnixNano: String(time + 1_000_000n), endTimeUnixNano: String(time + 8_000_000n), attributes: attrs({ "ai.operationId": "ai.generateText", "ai.prompt": "F47 captured task", "ai.response.text": OUTPUT, "ai.model.id": "fixture-model" }) }] }] }] });
  expect(response.status).toBe(200);
}
export async function open(backend: Backend, engine: string): Promise<BrowserSummary> {
  const response = await backend.api<BrowserSummary>("/api/verification/browser/sessions", { engine, url: backend.target, recordVideo: false }); expect(response.status).toBe(201); expect(response.body.state).toBe("ready"); expect(response.body.engine).toBe(engine); expect(response.body.engineVersion).not.toBe(""); backend.sample(); return response.body;
}
