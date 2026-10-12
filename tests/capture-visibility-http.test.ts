import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureTrace, captureInput, captureOutput, filterSecret } from "./fixtures/capture-visibility";
import { encodeFidelityRequest } from "./fixtures/otlp-evidence";

const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-capture-http-"));
const owned: ChildProcess[] = [], closed = new Map<ChildProcess, Promise<unknown>>();
const logs: string[] = [];
let base: string, daemon: ChildProcess;
const source = captureTrace(1661), binary = captureTrace(1662);
function proof(name: string, value: unknown) {
  if (process.env.F16_EVIDENCE_PATH) { mkdirSync(process.env.F16_EVIDENCE_PATH, { recursive: true }); writeFileSync(path.join(process.env.F16_EVIDENCE_PATH, name), JSON.stringify(value, null, 2) + "\n"); }
}
async function start() {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(key)));
  const executable = process.env.F16_ARTIFACT_EXECUTABLE;
  daemon = spawn(executable ?? "bun", executable ? ["serve"] : ["src/index.ts", "serve"], {
    cwd: executable ? path.dirname(executable) : path.resolve(import.meta.dir, ".."), stdio: ["ignore", "pipe", "pipe"], env: { ...env,
      HOME: directory, USERPROFILE: directory, RUNPHANTOM_DB_PATH: path.join(directory, "capture.db"), RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json"),
      RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  daemon.stdout?.on("data", data => logs.push(String(data))); daemon.stderr?.on("data", data => logs.push(String(data)));
  owned.push(daemon); closed.set(daemon, once(daemon, "close")); base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("Owned capture daemon exited before health");
    try { const health = await fetch(base + "/health"); if (health.ok && (await health.json()).pid === daemon.pid) return; } catch { /* Await owned health. */ }
    await Bun.sleep(25);
  }
  throw new Error("Owned capture daemon failed to become healthy");
}
async function stop(proc: ChildProcess) {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
  const timer = setTimeout(() => proc.kill("SIGKILL"), 2500);
  try { await closed.get(proc); } finally { clearTimeout(timer); }
}
beforeAll(start, 15000);
afterAll(async () => {
  await Promise.all(owned.map(stop)); rmSync(directory, { recursive: true, force: true });
  proof("http-cleanup.json", { pids: owned.map(p => ({ pid: p.pid, reaped: p.exitCode !== null || p.signalCode !== null, exit: p.exitCode, signal: p.signalCode })), profileRemoved: !existsSync(directory), secretInLogs: logs.join("").includes(filterSecret) });
});
async function json(route: string) { const response = await fetch(base + route); expect(response.status).toBe(200); return response.json(); }
async function post(route: string, data: unknown) { return fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); }
async function verify(id: string) {
  const detail = await json(`/api/runs/detail/${id}`);
  expect(detail.spans).toHaveLength(4);
  expect(detail.spans[0].normalized).toMatchObject({ kind: "retrieval", collection: "manuals", topK: 3, resultCount: 0 });
  expect(detail.spans[1].normalized).toMatchObject({ kind: "embedding", dimensions: 1536 });
  const llm = detail.spans[2]; expect(llm.captureVisibility.stream).toMatchObject({ state: "completed", coverage: "complete", chunks: [{ text: "Hello " }, { text: "world" }] });
  expect(llm.captureVisibility.source).toMatchObject({ traceId: id, spanId: llm.id });
  expect(llm.captureVisibility.usage).toMatchObject({ cacheReadInputTokens: 0, reasoningOutputTokens: 2 });
  expect(llm.normalized.userMessage).toBe(captureInput); expect(llm.output_payload).toBe(captureOutput); expect(llm.input_tokens).toBe(7); expect(llm.output_tokens).toBe(3);
  expect(detail.spans[3].captureVisibility.stream).toMatchObject({ state: "cancelled", chunks: [{ text: "Partial evidence" }] });
  expect(JSON.stringify(detail)).not.toContain(filterSecret);
  const exported = await json(`/api/runs/${id}/export`); expect(JSON.stringify(exported)).not.toContain(filterSecret);
  const meta = await json(`/api/spans/${llm.id}?run_id=${id}`); expect(meta.captureVisibility.stream.state).toBe("completed");
  const query = await post("/api/traces/query", { sql: `SELECT id,span_type,attributes FROM spans WHERE run_id='${id}' ORDER BY start_time_ms` }); expect(query.status).toBe(200);
  const raw = await query.json(); expect(raw.rows).toHaveLength(4); expect(raw.rows[0].attributes).toContain(filterSecret);
  proof(`http-${id}.json`, { process: { pid: daemon.pid, artifact: Boolean(process.env.F16_ARTIFACT_EXECUTABLE) }, detail, exported, meta, sqlRowCount: raw.rows.length, rawFilterRetained: raw.rows[0].attributes.includes(filterSecret) });
  return { detail, exported };
}
test("actual OTLP JSON/protobuf, idempotent identity, public privacy and separate two-boot persistence", async () => {
  expect((await post("/v1/traces", source.body)).status).toBe(200);
  const response = await fetch(base + "/v1/traces", { method: "POST", headers: { "Content-Type": "application/x-protobuf" }, body: encodeFidelityRequest(binary.body as any) }); expect(response.status).toBe(200);
  expect((await post("/v1/traces", source.body)).status).toBe(200);
  const first = await verify(source.id); await verify(binary.id);
  const list = await json("/api/runs"); expect(JSON.stringify(list)).toContain(source.id);
  const firstPid = daemon.pid; await stop(daemon); await start(); expect(daemon.pid).not.toBe(firstPid);
  const second = await verify(source.id); expect(second.detail.spans).toEqual(first.detail.spans);
  expect((await post("/api/import-run", first.exported)).status).toBe(200);
  const portable = await json(`/api/runs/detail/${source.id}`); expect(portable.spans[2].captureVisibility.stream.state).toBe("completed");
  proof("http-two-boot.json", { firstPid, secondPid: daemon.pid, independentProcess: firstPid !== daemon.pid, equalPersistedViews: true, portableReinterpreted: true });
}, 30000);
