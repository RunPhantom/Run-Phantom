import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { manageCodexHooks, removeConfiguredCodexHooks } from "../src/coding-hooks/codex-install";
import { closeDb, getDrizzleDb } from "../src/db";
import { createServer } from "../src/server";
import { snapshotRun } from "../src/evaluations/snapshot";
import type { SnapshotRun, SnapshotSpan } from "../src/evaluations/protocol";
import { codexHook, codexJsonl, codexRecord, codexRecords, codexTurn } from "./fixtures/coding-hooks-codex";
const filesystemTest = test.skipIf(process.platform === "win32");
let dir: string, home: string, workspace: string, source: string, settings: string, prior: string | undefined;
let runtime: Awaited<ReturnType<typeof createServer>> | undefined;
beforeEach(() => {
  closeDb(); prior = process.env.RUNPHANTOM_DB_PATH;
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "runphantom-codex-")));
  home = path.join(dir, "private home"); workspace = path.join(dir, "project with 'quoted' spaces");
  for (const d of [home, workspace, path.join(home, ".codex/sessions/2026/10/18"), path.join(workspace, ".codex")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  source = path.join(home, ".codex/sessions/2026/10/18/rollout.jsonl");
  settings = path.join(workspace, ".codex/hooks.json");
  writeFileSync(source, codexJsonl(codexRecords(workspace)), { mode: 0o600 });
  process.env.RUNPHANTOM_DB_PATH = path.join(home, "runtime.sqlite");
});
afterEach(async () => {
  if (runtime) { runtime.server.closeAllConnections(); await new Promise<void>((resolve, reject) => runtime!.server.close(e => e ? reject(e) : resolve())); runtime = undefined; }
  closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior;
  rmSync(dir, { recursive: true, force: true });
});
function options(port = 5947) { return { workspace, home, codexHome: path.join(home, ".codex"), fullConsent: true, port }; }
async function refused(promise: Promise<unknown>, reason: string) {
  const error: unknown = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(reason);
}
function command(): string { return JSON.parse(readFileSync(settings, "utf8")).hooks.Stop.find((g: { hooks: { command: string }[] }) => g.hooks[0].command.includes("--registration-file")).hooks[0].command; }
async function native(payload = codexHook(workspace, source), vector = command()) {
  const started = performance.now();
  const child = spawn("/bin/sh", ["-c", "exec " + vector], { cwd: workspace, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: dir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", RUNPHANTOM_DB_PATH: path.join(home, "MUST_NOT_CREATE.sqlite"), RUNPHANTOM_URL: "http://127.0.0.1:1" }, stdio: "pipe" });
  let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b); child.stdin.on("error", () => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
  const ended = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  child.stdin.end(payload);
  let result;
  try { result = await ended; } finally { clearTimeout(timer); }
  expect(result).toEqual({ code: 0, signal: null }); expect(stdout).toBe(""); expect(stderr).toBe("");
  expect(existsSync(path.join(home, "MUST_NOT_CREATE.sqlite"))).toBe(false);
  return performance.now() - started;
}
async function start(port = 0) {
  runtime = await createServer(port);
  await new Promise<void>(resolve => runtime!.server.listen(port, "127.0.0.1", resolve));
  return (runtime.server.address() as { port: number }).port;
}
const rows = () => getDrizzleDb().$client.query("SELECT * FROM spans ORDER BY id").all() as { id: string; run_id: string; input_tokens: number | null; output_tokens: number | null; input_payload: string | null; output_payload: string | null; attributes: string }[];
filesystemTest("install twice and uninstall preserve unrelated hooks and config.toml bytes", async () => {
  const unrelated = { description: "keep", other: { enabled: false }, hooks: { Stop: [{ hooks: [{ type: "command", command: "printf untouched" }] }] } };
  writeFileSync(settings, JSON.stringify(unrelated));
  const toml = path.join(workspace, ".codex/config.toml"); writeFileSync(toml, 'model = "unrelated"\n');
  await manageCodexHooks("install", options()); const installed = readFileSync(settings, "utf8");
  expect(await manageCodexHooks("install", options())).toMatchObject({ configuration: "installed", changed: false, captureVerified: false });
  expect(readFileSync(settings, "utf8")).toBe(installed);
  expect(await manageCodexHooks("doctor", options())).toMatchObject({ configuration: "installed", enabled: true, captureVerified: false, vendorTrust: "review_in_codex_hooks", transport: "not_probed" });
  expect(await removeConfiguredCodexHooks(home)).toBe(1);
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(unrelated);
  expect(readFileSync(toml, "utf8")).toBe('model = "unrelated"\n');
  expect(await manageCodexHooks("uninstall", options())).toMatchObject({ configuration: "missing" });
});
filesystemTest("malformed settings and changed owned handler are untouched and consent is required", async () => {
  writeFileSync(settings, '{"hooks":{},"hooks":{}}'); const before = readFileSync(settings, "utf8");
  await refused(manageCodexHooks("install", options()), "invalid_hooks_json"); expect(readFileSync(settings, "utf8")).toBe(before);
  rmSync(settings); await refused(manageCodexHooks("install", { ...options(), fullConsent: false }), "consent");
  await manageCodexHooks("install", options()); const config = JSON.parse(readFileSync(settings, "utf8")); config.hooks.Stop[0].hooks[0].timeout = 99; writeFileSync(settings, JSON.stringify(config));
  const changed = readFileSync(settings, "utf8"); await refused(manageCodexHooks("uninstall", options()), "changed_owned_hook"); expect(readFileSync(settings, "utf8")).toBe(changed);
});
filesystemTest("actual installed shell callback handles spaced paths and stays silent when daemon refuses", async () => {
  await manageCodexHooks("install", options(1)); await native(); await native("malformed");
});
filesystemTest("actual callback reaches Runs/detail, upserts deterministic roots and replaces authoritative rollup", async () => {
  const port = await start(); await manageCodexHooks("install", options(port)); await native(); const initial = rows();
  expect(initial).toHaveLength(4); await native(); expect(rows()).toEqual(initial);
  const runId = initial[0].run_id, detail = await fetch(`http://127.0.0.1:${port}/api/runs/detail/${runId}`); expect(detail.status).toBe(200);
  const body = await detail.json() as { spans: { normalized: { capture?: { runtimeVerified: boolean; coverage: string; assistantText: string } } }[] };
  expect(body.spans.some(s => s.normalized.capture?.assistantText === "Found the café result")).toBe(true);
  expect(body.spans.every(s => s.normalized.capture?.runtimeVerified === false && s.normalized.capture?.coverage === "partial")).toBe(true);
  expect(initial.every(s => (s as unknown as { status: string; end_time_ms: number }).status === "UNSET" && (s as unknown as { end_time_ms: number }).end_time_ms === 0)).toBe(true);
  const run = getDrizzleDb().$client.query("SELECT * FROM runs WHERE id=?").get(runId) as SnapshotRun;
  const frozen = snapshotRun(run, initial as unknown as SnapshotSpan[]);
  const frozenBytes = JSON.stringify(frozen);
  expect(frozen.complete).toBe(false); expect(frozen.output.complete).toBe(false); expect(frozen.metrics.durationMs).toBeNull();
  expect(frozen.metrics).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null });
  expect(initial.find(s => JSON.parse(s.attributes).entityKind === "session")).toMatchObject({ input_tokens: 19, output_tokens: 5 });
  const records = codexRecords(workspace);
  records.push(codexRecord("turn_context", { turn_id: codexTurn + "-second", cwd: workspace, model: "fixture-model" }, 6), ...codexRecords(workspace).slice(2, 6), codexRecord("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 31, cached_input_tokens: 8, output_tokens: 9, reasoning_output_tokens: 2, total_tokens: 40 } } }, 7));
  writeFileSync(source, codexJsonl(records)); await native();
  expect(getDrizzleDb().$client.query("SELECT count(*) n FROM runs").get()).toEqual({ n: 1 });
  expect(rows()).toHaveLength(7);
  expect(rows().reduce((n, r) => n + (r.input_tokens ?? 0), 0)).toBe(31);
  expect(rows().reduce((n, r) => n + (r.output_tokens ?? 0), 0)).toBe(9);
  expect(JSON.stringify(frozen)).toBe(frozenBytes);
  const originalBytes = JSON.stringify(initial); expect(originalBytes).toContain("café");
  const staleCommand = command(); await manageCodexHooks("uninstall", options(port)); const frozenRows = rows(); await native(codexHook(workspace, source), staleCommand); expect(rows()).toEqual(frozenRows);
});
filesystemTest("foreign cwd, linked/public sources and public registration do not publish", async () => {
  const port = await start(); await manageCodexHooks("install", options(port));
  await native(codexHook(dir, source)); expect(rows()).toHaveLength(0);
  chmodSync(source, 0o644); await native(); expect(rows()).toHaveLength(0); chmodSync(source, 0o600);
  const linked = source + ".linked.jsonl"; symlinkSync(source, linked); await native(codexHook(workspace, linked)); expect(rows()).toHaveLength(0);
  const registration = command().match(/'([^']+\.json)' '--installation-id'/)![1]; chmodSync(registration, 0o644); await native(); expect(rows()).toHaveLength(0);
});

filesystemTest("a real stalled export deadline cannot poison later capture or management", async () => {
  let requests = 0, bodyComplete = false, closed = false;
  const stalled = httpServer((req) => { expect(req.url).toBe("/v1/traces"); requests++; req.resume(); req.once("end", () => { bodyComplete = true; }); });
  await new Promise<void>(resolve => stalled.listen(0, "127.0.0.1", resolve));
  const port = (stalled.address() as { port: number }).port;
  try {
    await manageCodexHooks("install", options(port));
    const elapsed = await native();
    expect(requests).toBe(1); expect(bodyComplete).toBe(true); expect(elapsed).toBeLessThan(1500);
    expect(readdirSync(path.join(home, ".runphantom/codex-hooks")).filter(n => n.endsWith(".lock"))).toEqual([]);
    expect(await manageCodexHooks("doctor", options(port))).toMatchObject({ configuration: "installed", enabled: true });
    await new Promise<void>((resolve, reject) => stalled.close(e => e ? reject(e) : resolve())); closed = true;
    await start(port); await native(); expect(rows()).toHaveLength(4);
    expect(await manageCodexHooks("uninstall", options(port))).toMatchObject({ configuration: "removed" });
    expect(readdirSync(path.join(home, ".runphantom/codex-hooks"))).toEqual([]);
  } finally {
    if (!closed) await new Promise<void>(resolve => stalled.close(() => resolve()));
  }
});

filesystemTest("actual process exit releases only its own lock inode and preserves a replacement", () => {
  const module = path.resolve(import.meta.dir, "../src/coding-hooks/codex-lock.ts"), lock = path.join(home, "exit-control.lock");
  for (const replacement of [false, true]) {
    const script = `import { acquireCodexLock } from ${JSON.stringify(module)}; import { unlinkSync, writeFileSync } from "node:fs"; acquireCodexLock(${JSON.stringify(lock)}); ${replacement ? `unlinkSync(${JSON.stringify(lock)}); writeFileSync(${JSON.stringify(lock)}, "replacement-owner");` : ""} process.exit(0);`;
    const result = spawnSync(process.execPath, ["--no-env-file", "-e", script], { cwd: workspace, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 2000, encoding: "utf8" });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.signal).toBeNull(); expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
    if (replacement) expect(readFileSync(lock, "utf8")).toBe("replacement-owner"); else expect(existsSync(lock)).toBe(false);
  }
});
