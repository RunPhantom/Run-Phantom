import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { createServer } from "../src/server";
import { closeDb, getDbPath, getDrizzleDb } from "../src/db";
import { capabilityOwnerKey, readClaudeCapabilityDescriptor } from "../src/coding-hooks/capability";
import { cursorHook } from "./fixtures/coding-hooks-cursor";
import { validateLegacySource } from "../src/coding-hooks/retained-version";
import { snapshotRun } from "../src/evaluations/snapshot";
import { removeConfiguredClaudeHooks } from "../src/coding-hooks/commands";

let directory: string, workspace: string, server: Server | undefined;
const names = ["HOME", "USERPROFILE", "TMPDIR", "RUNPHANTOM_DB_PATH", "RUNPHANTOM_SECRET_STORE_PATH", "RUNPHANTOM_AGENT_PROVIDER", "CLAUDE_CONFIG_DIR", "RUNPHANTOM_BIN_PATH"];
let prior: (string | undefined)[];
const children = new Set<number>();
beforeEach(() => {
  closeDb(); prior = names.map(k => process.env[k]); directory = realpathSync(mkdtempSync(path.join(tmpdir(), "f13-private spaced-"))); workspace = path.join(directory, "workspace ' $literal`"); mkdirSync(workspace);
  process.env.HOME = directory; process.env.USERPROFILE = directory; process.env.TMPDIR = directory;
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, ".runphantom/runphantom.db"); process.env.CLAUDE_CONFIG_DIR = path.join(directory, "claude-config");
  process.env.RUNPHANTOM_SECRET_STORE_PATH = path.join(directory, ".runphantom/secrets.json"); process.env.RUNPHANTOM_AGENT_PROVIDER = "claude";
  const bin = path.join(directory, "bin ' $literal`", "run phantom"); mkdirSync(path.dirname(bin));
  writeFileSync(bin, "#!" + process.execPath + "\nawait import(" + JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../src/index.ts")).href) + ");\n", { mode: 0o700 });
  process.env.RUNPHANTOM_BIN_PATH = bin;
});
afterEach(async () => {
  if (server) { const current = server; server = undefined; await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve())); }
  expect(children.size).toBe(0); closeDb(); names.forEach((name, i) => { if (prior[i] === undefined) delete process.env[name]; else process.env[name] = prior[i]; });
  rmSync(directory, { recursive: true, force: true });
});
async function start() { const runtime = await createServer(0); server = runtime.server; await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve)); return runtime; }
async function manage(port: number, action = "install", changes: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/coding-hooks/claude/manage`, { method: "POST", headers: { "content-type": "application/json", "x-runphantom-hook-owner": capabilityOwnerKey(getDbPath()) }, body: JSON.stringify({ action, vendor: "cursor", scope: "local", workspace, captureMode: action === "install" ? "full" : "metadata", fullConsent: action === "install", ...changes }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
function installed(event = "stop", settings = path.join(workspace, ".cursor/hooks.json")): string { const value = JSON.parse(readFileSync(settings, "utf8")); return value.hooks[event].find((h: { command: string }) => h.command.includes("'hooks' 'handle' 'cursor'" )).command; }
async function invoke(command: string, input: string, hostExit?: number) {
  const env = { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, TMPDIR: directory, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", RUNPHANTOM_DB_PATH: path.join(directory, "MUST_NOT_CREATE.sqlite"), RUNPHANTOM_URL: "http://127.0.0.1:1", RUNPHANTOM_CLAUDE_CLI_CHAT: "0" };
  const child = spawn("/bin/sh", ["-c", hostExit === undefined ? command : command + "; exit " + hostExit], { env, detached: true, stdio: "pipe" });
  const pid = child.pid!; children.add(pid); let out = "", err = "";
  child.stdout.on("data", x => { out += x; }); child.stderr.on("data", x => { err += x; }); child.stdin.on("error", () => {});
  const timer = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* Already terminal. */ } }, 2500);
  child.stdin.end(input);
  const status = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }).finally(() => { clearTimeout(timer); children.delete(pid); });
  expect(status).toBe(hostExit ?? 0); expect(out).toBe(""); expect(err).toBe(""); expect(existsSync(path.join(directory, "MUST_NOT_CREATE.sqlite"))).toBe(false);
  expect(() => process.kill(-pid, 0)).toThrow();
}
const detail = async (port: number) => { const runs = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json() as { id: string; finished: number }[]; expect(runs).toHaveLength(1); const value = await (await fetch(`http://127.0.0.1:${port}/api/runs/detail/${runs[0].id}`)).json(); return { runs, value }; };
const payload = (event: string, fields: Record<string, unknown> = {}) => cursorHook(event, { workspace_roots: [workspace], cwd: workspace, ...fields });
describe.skipIf(process.platform === "win32")("actual isolated Cursor hook transport (synthetic vendor, private API profile)", () => {
  test("installed spaced-path native commands capture actual Runs output once without false runtime completion", async () => {
    const runtime = await start(); const first = await manage(runtime.port); expect(first.status).toBe(200); expect(first.body.policy).toBe("active");
    expect(getDbPath()).toBe(path.join(directory, ".runphantom/runphantom.db"));
    const config = readFileSync(path.join(workspace, ".cursor/hooks.json"), "utf8"), second = await manage(runtime.port); expect(second.status).toBe(200); expect(second.body.unchanged).toBe(true); expect(readFileSync(path.join(workspace, ".cursor/hooks.json"), "utf8")).toBe(config);
    for (const event of ["sessionStart", "beforeSubmitPrompt", "postToolUse", "afterAgentResponse", "stop", "sessionEnd"]) await invoke(installed(event), payload(event));
    const captured = await detail(runtime.port); expect(captured.runs[0].finished).toBe(0); expect(captured.value.run.name).toBe("Cursor session"); expect(captured.value.spans).toHaveLength(4);
    const root = captured.value.spans.find((s: any) => s.span_type === "AGENT_ROOT"); expect(root.status).toBe("UNSET");
    const assistant = captured.value.spans.find((s: any) => s.span_type === "LLM_GENERATION"); expect(assistant.normalized.capture).toMatchObject({ contract: "runphantom.cursor-hook.observation/v1", assistantText: "Captured synthetic Cursor answer", coverage: "partial", runtimeVerified: false, producerVerified: false });
    expect(assistant.input_payload).toBeNull(); expect(assistant.provider).toBeNull(); expect(assistant.input_tokens).toBeNull(); expect(assistant.output_tokens).toBeNull();
    expect(captured.value.spans.every((s: any) => s.start_time_ms === null && s.end_time_ms === null && s.duration_ms === null)).toBe(true);
    await invoke(installed("postToolUse"), payload("postToolUse")); await invoke(installed("afterAgentResponse"), payload("afterAgentResponse"));
    expect((await detail(runtime.port)).value.spans).toEqual(captured.value.spans);
    const snapshot = snapshotRun(captured.value.run, captured.value.spans, assistant.id); expect(snapshot.complete).toBe(false); expect(snapshot.output.complete).toBe(false);
    expect((await manage(runtime.port, "doctor")).body).toMatchObject({ configuration: "installed", captureVerified: false, transport: "available" });
  }, 15000);
  test("unknown workspaces, supplied transcript paths and imported Claude compatibility callbacks cannot add a second capture", async () => {
    const runtime = await start(); expect((await manage(runtime.port)).status).toBe(200);
    const event = payload("afterAgentResponse", { transcript_path: path.join(directory, "MUST_NOT_READ") }); await invoke(installed("afterAgentResponse"), event); const before = await detail(runtime.port);
    await invoke(installed("afterAgentResponse"), payload("afterAgentResponse", { cwd: directory, workspace_roots: [directory], text: "UNREGISTERED_PATH_CANARY" })); expect((await detail(runtime.port)).value.spans).toEqual(before.value.spans);
    const claudeCommand = installed().replace("'cursor'", "'claude'"); await invoke(claudeCommand, payload("postToolUse", { hook_event_name: "PostToolUse", session_id: "cursor-fixture-conversation", transcript_path: path.join(directory, "MUST_NOT_READ") })); expect((await detail(runtime.port)).value.spans).toEqual(before.value.spans);
    expect((await fetch(`http://127.0.0.1:${runtime.port}/api/runs/${before.runs[0].id}`, { method: "DELETE" })).status).toBe(200);
    await invoke(installed("afterAgentResponse"), payload("afterAgentResponse", { text: "DELETED_SOURCE_CANARY" }));
    expect(await (await fetch(`http://127.0.0.1:${runtime.port}/api/runs`)).json()).toEqual([]);
  }, 10000);
  test("metadata default, explicit consent refusal, uninstall and existing local uninstall preserve unrelated settings", async () => {
    const runtime = await start(), file = path.join(workspace, ".cursor/hooks.json"); mkdirSync(path.dirname(file)); writeFileSync(file, JSON.stringify({ version: 1, unrelated: { keep: true }, hooks: { stop: [{ command: "ordinary unrelated" }] } }));
    expect((await manage(runtime.port, "install", { fullConsent: false })).status).toBe(400);
    const install = await manage(runtime.port, "install", { captureMode: "metadata", fullConsent: false }); expect(install.status).toBe(200); expect(install.body.captureMode).toBe("metadata");
    await invoke(installed("afterAgentResponse"), payload("afterAgentResponse")); const captured = await detail(runtime.port); expect(JSON.stringify(captured.value.spans)).not.toContain("Captured synthetic Cursor answer");
    const command = installed(); expect((await manage(runtime.port, "uninstall")).body.status).toBe("removed"); expect((await manage(runtime.port, "uninstall")).body.status).toBe("removed");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, unrelated: { keep: true }, hooks: { stop: [{ command: "ordinary unrelated" }] } });
    await invoke(command, payload("afterAgentResponse", { text: "AFTER_REVOKE_CANARY" })); expect((await detail(runtime.port)).value.spans).toEqual(captured.value.spans);
    expect((await manage(runtime.port)).status).toBe(200); expect(await removeConfiguredClaudeHooks()).toBe(1); expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, unrelated: { keep: true }, hooks: { stop: [{ command: "ordinary unrelated" }] } });
  }, 10000);
  test("failed and cancelled tool observations keep real error state without runtime timing or secret leakage", async () => {
    const runtime = await start(); expect((await manage(runtime.port)).status).toBe(200);
    await invoke(installed("postToolUseFailure"), payload("postToolUseFailure", { is_interrupt: true, error_message: "Cancelled password=CURSOR_FAILURE_CANARY" }));
    const captured = await detail(runtime.port), tool = captured.value.spans.find((s: any) => s.span_type === "TOOL_CALL");
    expect(tool.status).toBe("ERROR"); expect(tool.normalized.capture.reportedPhase).toBe("interrupted"); expect(tool.duration_ms).toBeNull();
    expect(JSON.stringify(captured.value.spans)).not.toContain("CURSOR_FAILURE_CANARY"); expect(captured.runs[0].finished).toBe(0);
  }, 10000);
  test("daemon/export unavailability leaves stdout empty and the synthetic host's original exit untouched", async () => {
    const runtime = await start(); expect((await manage(runtime.port)).status).toBe(200); const command = installed();
    runtime.codingHooks.controller.pause();
    await invoke(command, payload("stop"), 37);
    runtime.codingHooks.controller.resume(runtime.codingHooks.store.currentOwnerGeneration(), () => {});
    const active = server!; server = undefined; await new Promise<void>((resolve, reject) => active.close(error => error ? reject(error) : resolve()));
    await invoke(command, payload("stop"), 37); await invoke(command, "{malformed", 37); expect(getDrizzleDb().$client.query("SELECT count(*) n FROM runs").get()).toEqual({ n: 0 });
  }, 10000);
  test("durable Cursor attribution rejects tampering and orphan projections without active-installation inference", async () => {
    const runtime = await start(); expect((await manage(runtime.port)).status).toBe(200);
    await invoke(installed("afterAgentResponse"), payload("afterAgentResponse"));
    const db = getDrizzleDb().$client, row = db.query("SELECT source_key,source_root_key,run_id,data FROM coding_hook_sessions").get() as { source_key: string; source_root_key: string; run_id: string; data: string };
    const check = () => validateLegacySource(db, row.source_key, row.source_root_key);
    expect(JSON.parse(row.data).producer).toBe("cursor"); expect(check()).toBe("legacy-main-v1");
    for (const producer of [undefined, "claude", "cursor-v2"]) {
      db.query("UPDATE coding_hook_sessions SET data=? WHERE source_key=?").run(JSON.stringify({ ...JSON.parse(row.data), producer }), row.source_key);
      expect(check).toThrow();
    }
    db.query("UPDATE coding_hook_sessions SET data=? WHERE source_key=?").run(row.data, row.source_key); expect(check()).toBe("legacy-main-v1");
    const orphanAttributes = [
      '{"source":"cursor_hook"}', '{"captureContract":"runphantom.cursor-hook.observation/v1"}',
      '{"captureContract":"ordinary","captureContract":"runphantom.cursor-hook.observation/v1"}',
      '{"captureContract":"runphantom.cursor-hook.observation/v1","captureContract":"ordinary"}',
      String.raw`{"captureContract":"ordinary","cap\u0074ureContract":"runphantom.cursor-hook.observation/v1"}`,
      '{"source":"ordinary","source":"cursor_hook"}', '{"source":"cursor_hook","source":"ordinary"}',
    ];
    for (const attributes of orphanAttributes) {
      db.exec("SAVEPOINT orphan_control");
      try {
        db.query("INSERT INTO spans(id,run_id,name,attributes) VALUES(?,?,?,?)").run("orphan-cursor", row.run_id, "Unanchored", attributes);
        expect(check).toThrow();
      } finally { db.exec("ROLLBACK TO orphan_control"); db.exec("RELEASE orphan_control"); }
    }
    for (const attributes of [
      '{"captureContract":"ordinary","note":"runphantom.cursor-hook.observation/v1"}',
      String.raw`{"cap\u0074ureContract":"ordinary","note":"cursor_hook"}`,
    ]) {
      db.exec("SAVEPOINT ordinary_control");
      try {
        db.query("INSERT INTO spans(id,run_id,name,attributes) VALUES(?,?,?,?)").run("ordinary-extra", row.run_id, "Ordinary", attributes);
        expect(check()).toBe("legacy-main-v1");
      } finally { db.exec("ROLLBACK TO ordinary_control"); db.exec("RELEASE ordinary_control"); }
    }
    expect(check()).toBe("legacy-main-v1");
  }, 10000);
  test("Cursor and Claude coexist on one workspace while context activation refreshes the nonselected Cursor owner", async () => {
    const runtime = await start(); const cursor = await manage(runtime.port); expect(cursor.status).toBe(200); await invoke(installed("afterAgentResponse"), payload("afterAgentResponse"));
    const claude = await manage(runtime.port, "install", { vendor: undefined }); expect(claude.status).toBe(200);
    const store = runtime.codingHooks.store, id = claude.body.installationId as string, current = store.readInstallation(id)!;
    const transition = { action: "activate-context-v2", installationIds: [id], expectedOwnerGeneration: store.currentOwnerGeneration(), expectedInstallations: [{ installationId: id, generation: current.row.generation, configSha256: current.row.config_sha256, catalogSha256: (await import("../src/coding-hooks/protocol")).hookDigest(current.row.data!) }] };
    const cap = path.join(path.dirname(getDbPath()), "coding-hooks/cursor", String(cursor.body.installationId) + ".json"), old = await readClaudeCapabilityDescriptor(cap, cursor.body.installationId as string);
    expect(await runtime.codingHooks.management().transitionContextV2(JSON.stringify(transition), runtime.codingHooks.controller)).toEqual({ status: "configured", unchanged: false, captureVerified: false });
    const next = await readClaudeCapabilityDescriptor(cap, cursor.body.installationId as string); expect(next.ownerGeneration).not.toBe(old.ownerGeneration); expect(next.token).toBe(old.token);
    await invoke(installed("afterAgentResponse"), payload("afterAgentResponse", { generation_id: "second", text: "Second current observation" }));
    expect((await detail(runtime.port)).value.spans.filter((s: any) => s.span_type === "LLM_GENERATION")).toHaveLength(2);
  }, 10000);
});
