import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as netServer } from "node:net";
import { spawn } from "node:child_process";
import { removeConfiguredClaudeHooks } from "../src/coding-hooks/commands";
import { installationIdForSettings } from "../src/coding-hooks/management";
import { hookFixture, hookSession, transcriptRecord } from "./fixtures/coding-hooks-claude";
import { request, type Server } from "node:http";
import { capabilityOwnerKey, readClaudeCapabilityDescriptor } from "../src/coding-hooks/capability";
import { HOOK_PROTOCOL, hookDigest } from "../src/coding-hooks/protocol";
import { claimsForRegistration } from "../src/coding-hooks/catalog";
import { normalizeClaudeHook } from "../src/coding-hooks/claude";
import type { InstallationBinding } from "../src/coding-hooks/store";
import { createServer } from "../src/server";
import { closeDb, getDrizzleDb } from "../src/db";
let directory: string, prior: string | undefined, server: Server | undefined;
let configPrior: string | undefined, secretPrior: string | undefined, providerPrior: string | undefined;
beforeEach(() => { closeDb(); prior = process.env.RUNPHANTOM_DB_PATH; directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runphantom-f11-runtime-"))); mkdirSync(path.join(directory, "profile")); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "profile/owner.sqlite"); configPrior = process.env.CLAUDE_CONFIG_DIR; secretPrior = process.env.RUNPHANTOM_SECRET_STORE_PATH; providerPrior = process.env.RUNPHANTOM_AGENT_PROVIDER; process.env.CLAUDE_CONFIG_DIR = path.join(directory, "claude-config"); process.env.RUNPHANTOM_SECRET_STORE_PATH = path.join(directory, "profile/secrets.json"); process.env.RUNPHANTOM_AGENT_PROVIDER = "claude"; });
afterEach(async () => { if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server = undefined; closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; for (const [name, value] of [["CLAUDE_CONFIG_DIR", configPrior], ["RUNPHANTOM_SECRET_STORE_PATH", secretPrior], ["RUNPHANTOM_AGENT_PROVIDER", providerPrior]]) { if (value === undefined) delete process.env[name!]; else process.env[name!] = value; } rmSync(directory, { recursive: true, force: true }); });
test("actual daemon startup owns the migrated connection before opening its public listener", async () => {
  ({ server } = await createServer(0));
  expect(server.listening).toBe(false);
  expect(getDrizzleDb().$client.query("SELECT generation,source_epoch FROM coding_hook_owner WHERE id=1").get()).not.toBeNull();
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
});

async function start() {
  const runtime = await createServer(0); server = runtime.server; await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve)); return runtime;
}
function binding(scope: "global" | "local", name = "workspace", captureMode: "metadata" | "full" = "metadata"): InstallationBinding {
  const workspace = path.join(directory, name), root = path.join(directory, "projects"), project = path.join(root, name); mkdirSync(path.join(workspace, ".claude"), { recursive: true }); mkdirSync(project, { recursive: true });
  const settings = scope === "local" ? path.join(workspace, ".claude/settings.local.json") : path.join(directory, "settings.json");
  return { installationId: installationIdForSettings(scope, settings), scope, captureMode, workspace: scope === "global" ? null : workspace, registeredWorkspace: workspace, transcriptRoot: root, projectDirectory: project, homeDirectory: directory, settingsPath: settings, executable: realpathSync(path.resolve(import.meta.dir, "../bin/runphantom-dev")) };
}
const capabilityPath = (b: InstallationBinding) => path.join(directory, "profile/coding-hooks/claude", b.installationId + ".json");
async function native(b: InstallationBinding, fields: Record<string, unknown> = {}, event = "Stop") {
  const vector = JSON.parse(readFileSync(b.settingsPath, "utf8")).hooks[event].flatMap((group: any) => group.hooks).find((handler: any) => Array.isArray(handler.args) && handler.args[4] === b.installationId);
  expect(vector).toBeDefined(); expect(vector.command).toBe(b.executable); expect(vector.args).toEqual(["hooks", "handle", "claude", "--installation-id", b.installationId, "--capability-file", capabilityPath(b)]);
  expect(JSON.stringify(vector)).not.toMatch(/Bearer|ownerGeneration|installationGeneration|http:/);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key)));
  const child = spawn(vector.command, vector.args, { env: { ...inherited, RUNPHANTOM_DB_PATH: path.join(directory, "MUST_NOT_CREATE.sqlite"), RUNPHANTOM_URL: "http://127.0.0.1:1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdio: "pipe" });
  let stdout = "", stderr = ""; const started = performance.now(); child.stdout.on("data", x => stdout += x); child.stderr.on("data", x => stderr += x); child.stdin.on("error", () => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  child.stdin.end(hookFixture(event, { cwd: b.registeredWorkspace, transcript_path: path.join(b.projectDirectory, hookSession + ".jsonl"), ...fields }));
  const status = await new Promise(resolve => child.once("close", resolve)); clearTimeout(timer);
  expect(status).toBe(0); expect(stdout).toBe(""); expect(stderr).toBe(""); expect(performance.now() - started).toBeLessThan(1500); expect(existsSync(path.join(directory, "MUST_NOT_CREATE.sqlite"))).toBe(false);
}
const source = (b: InstallationBinding, records = [transcriptRecord()]) => writeFileSync(path.join(b.projectDirectory, hookSession + ".jsonl"), records.map(x => JSON.stringify(x)).join("\n") + "\n");
const spans = () => JSON.stringify(getDrizzleDb().$client.query("SELECT * FROM spans ORDER BY id").all());
test("installed native argument callback uses only the private custom-profile descriptor and actual raw routes", async () => {
  const runtime = await start(), b = binding("local", "workspace", "full"); await runtime.codingHooks.management().install(b, { fullConsent: true }); source(b);
  await native(b, { tool_response: { password: "PRIVATE_CALLBACK_SECRET" } }); expect(spans()).toContain("safe exact business result"); expect(spans()).not.toContain("PRIVATE_CALLBACK_SECRET");
  expect((await runtime.codingHooks.management().doctor(b.installationId)).transport).toBe("available"); expect((await runtime.codingHooks.management().doctor(b.installationId)).captureVerified).toBe(false);
});
test("two actual daemon DB boots preserve source epoch and once-only usage while old descriptors cannot acquire newer content", async () => {
  let runtime = await start(); const b = binding("local", "workspace", "full"); await runtime.codingHooks.management().install(b, { fullConsent: true }); source(b); await native(b);
  const first = await readClaudeCapabilityDescriptor(capabilityPath(b), b.installationId), oldSession = getDrizzleDb().$client.query("SELECT source_key,run_id FROM coding_hook_sessions").get();
  const epoch = getDrizzleDb().$client.query("SELECT source_epoch FROM coding_hook_owner").get(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server = undefined;
  runtime = await start(); expect(getDrizzleDb().$client.query("SELECT source_epoch FROM coding_hook_owner").get()).toEqual(epoch);
  const second = transcriptRecord({ uuid: "record_2", requestId: "request_2", message: { id: "msg_2", model: "fixture-model", content: [{ type: "text", text: "second boot content" }], usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }); source(b, [transcriptRecord(), second]);
  await native(b); expect(spans()).not.toContain("second boot content");
  await runtime.codingHooks.management().install(b, { fullConsent: true }); const current = await readClaudeCapabilityDescriptor(capabilityPath(b), b.installationId);
  expect(current.token).toBe(first.token); expect(current.installationGeneration).toBe(first.installationGeneration); expect(current.ownerGeneration).not.toBe(first.ownerGeneration);
  await native(b); await native(b); expect(spans()).toContain("second boot content"); expect(getDrizzleDb().$client.query("SELECT source_key,run_id FROM coding_hook_sessions").get()).toEqual(oldSession);
  expect(getDrizzleDb().$client.query("SELECT input_tokens,output_tokens FROM spans WHERE span_type='LLM_GENERATION' ORDER BY input_tokens").all()).toEqual([{ input_tokens: 7, output_tokens: 3 }, { input_tokens: 10, output_tokens: 4 }]);
});
test("actual global metadata across two workspaces and local full share one project's identities without promoting the other", async () => {
  const runtime = await start(), first = binding("global", "one"), other = binding("global", "two"), full = binding("local", "one", "full");
  await runtime.codingHooks.management().install(first, { registrations: [first, other].map(b => ({ registrationId: hookDigest(JSON.stringify(["runphantom.claude.root/v1", b.registeredWorkspace, b.transcriptRoot, b.projectDirectory])), registeredWorkspace: b.registeredWorkspace, transcriptRoot: b.transcriptRoot, projectDirectory: b.projectDirectory, homeDirectory: b.homeDirectory })) });
  await runtime.codingHooks.management().install(full, { fullConsent: true }); source(full); source(other); await native(full); await native(first); await native(other);
  expect(getDrizzleDb().$client.query("SELECT source_key FROM coding_hook_sessions").all()).toHaveLength(2);
  const bodies = getDrizzleDb().$client.query("SELECT output_payload FROM spans WHERE span_type='LLM_GENERATION'").all(); expect(bodies.filter((x: any) => x.output_payload !== null)).toHaveLength(1); expect(bodies.filter((x: any) => x.output_payload === null)).toHaveLength(1);
  expect(getDrizzleDb().$client.query("SELECT input_tokens FROM spans WHERE span_type='LLM_GENERATION'").all()).toHaveLength(2);
  const before = spans(); await native(full, { cwd: other.registeredWorkspace }); await native(full, { transcript_path: path.join(other.projectDirectory, hookSession + ".jsonl") }); expect(spans()).toBe(before);
  await native(full, { reason: "other" }, "SessionEnd"); expect(getDrizzleDb().$client.query("SELECT state FROM coding_hook_sessions WHERE source_root_key=?").get(hookDigest(JSON.stringify(["runphantom.claude.root/v1", full.registeredWorkspace, full.transcriptRoot, full.projectDirectory])))).toEqual({ state: "closed" });
});
test("actual clear rotates before paused publication, drains hooks, preserves tombstones and exposes no capability", async () => {
  const runtime = await start(), b = binding("local", "workspace", "full"); await runtime.codingHooks.management().install(b, { fullConsent: true }); source(b); await native(b);
  const cap = await readClaudeCapabilityDescriptor(capabilityPath(b), b.installationId), identity = hookDigest(JSON.stringify(["runphantom.claude.session-identity/v1", hookSession])), admission = runtime.codingHooks.store.admit(cap.token!, identity, claimsForRegistration(b));
  const normalized = normalizeClaudeHook(hookFixture("PostToolUse", { tool_use_id: "late_tool", tool_name: "Bash", tool_response: "late publication" }), { sourceKey: admission.sourceKey, captureMode: "full" }, null); if (normalized.status !== "accepted") throw new Error("fixture batch");
  const body = JSON.stringify({ version: HOOK_PROTOCOL, ownerGeneration: admission.ownerGeneration, installationGeneration: admission.installationGeneration, sourceKey: admission.sourceKey, batch: normalized.value });
  const client = request(`http://127.0.0.1:${runtime.port}/api/coding-hooks/claude/publication`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cap.token } }); client.on("error", () => {});
  const response = new Promise<number>(resolve => client.once("response", r => { r.resume(); r.once("end", () => resolve(r.statusCode!)); })); client.write(body.slice(0, -1));
  const deadline = performance.now() + 500; while (!runtime.codingHooks.controller.stats().active) { if (performance.now() > deadline) throw new Error("fixture barrier"); await new Promise<void>(r => setImmediate(r)); }
  const clear = await fetch(`http://127.0.0.1:${runtime.port}/api/clear`, { method: "POST" }); expect(clear.status).toBe(200); expect(await clear.text()).not.toContain(cap.token!); expect(await response).toBe(503); client.destroy();
  expect(runtime.codingHooks.controller.stats()).toEqual({ active: 0, queued: 0, closed: false }); expect(getDrizzleDb().$client.query("SELECT id FROM runs").all()).toEqual([]); expect(getDrizzleDb().$client.query("SELECT state FROM coding_hook_sessions").all()).toEqual([{ state: "suppressed" }]);
  await native(b); expect(spans()).toBe("[]"); expect((await runtime.codingHooks.management().doctor(b.installationId)).transport).toBe("unavailable");
});
test("native management CLI matches actual daemon owner and refuses global full or a different profile before registration", async () => {
  const runtime = await start(), workspace = path.join(directory, "managed workspace"); mkdirSync(workspace);
  const cmd = { action: "install", scope: "local", workspace, captureMode: "full", fullConsent: true };
  const denied = await fetch(`http://127.0.0.1:${runtime.port}/api/coding-hooks/claude/manage`, { method: "POST", headers: { "content-type": "application/json", "x-runphantom-hook-owner": "0".repeat(64) }, body: JSON.stringify(cmd) }); expect(denied.status).toBe(403); expect(existsSync(path.join(workspace, ".claude"))).toBe(false);
  const executable = realpathSync(path.resolve(import.meta.dir, "../bin/runphantom-dev")), inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key)));
  const child = spawn(executable, ["hooks", "install", "claude", "--local", "--cwd", workspace, "--full", "--consent-full"], { env: { ...inherited, RUNPHANTOM_PORT: String(runtime.port), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdio: "pipe" }); let output = "", error = ""; child.stdout.on("data", x => output += x); child.stderr.on("data", x => error += x); child.stdin.end();
  expect(await new Promise(resolve => child.once("close", resolve))).toBe(0); expect(error).toBe(""); const result = JSON.parse(output); expect(result.policy).toBe("active"); expect(result.captureMode).toBe("full"); expect(result.transport).toBe("available"); expect(result.captureVerified).toBe(false); expect(output).not.toMatch(/token|ownerGeneration|Bearer/);
  const refused = await fetch(`http://127.0.0.1:${runtime.port}/api/coding-hooks/claude/manage`, { method: "POST", headers: { "content-type": "application/json", "x-runphantom-hook-owner": capabilityOwnerKey(getDrizzleDb().$client.filename) }, body: JSON.stringify({ ...cmd, scope: "global" }) }); expect(refused.status).toBe(400);
});
test("a competing actual CLI daemon refuses before owner generation changes or the current listener is disturbed", async () => {
  const runtime = await start(), before = getDrizzleDb().$client.query("SELECT * FROM coding_hook_owner").all();
  const child = spawn(process.execPath, ["--no-env-file", path.resolve(import.meta.dir, "../src/index.ts"), "serve"], { env: { ...process.env, RUNPHANTOM_PORT: String(runtime.port), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", OPENAI_API_KEY: "", RUNPHANTOM_OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }, stdio: "pipe" });
  let error = ""; child.stderr.on("data", x => error += x); child.stdout.resume(); child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  const status = await new Promise(resolve => child.once("close", resolve)); clearTimeout(timer); expect(status).toBe(1); expect(error).toContain("occupied"); expect(getDrizzleDb().$client.query("SELECT * FROM coding_hook_owner").all()).toEqual(before); expect((await fetch(`http://127.0.0.1:${runtime.port}/health`)).status).toBe(200);
});
test("main to SubagentStop to main advances one descriptor while forged agent paths cannot grant another cursor", async () => {
  const runtime = await start(), b = binding("local", "workspace", "full"); await runtime.codingHooks.management().install(b, { fullConsent: true }); source(b); await native(b);
  const db = getDrizzleDb().$client, first = db.query("SELECT incarnation_key,source_cursor FROM coding_hook_sessions").get() as { incarnation_key: string; source_cursor: number };
  const agent = path.join(b.projectDirectory, hookSession, "subagents/agent-child_1.jsonl"); mkdirSync(path.dirname(agent), { recursive: true }); writeFileSync(agent, JSON.stringify(transcriptRecord({ uuid: "agent_private", message: { id: "agent_private", content: [{ type: "text", text: "INDEPENDENT_AGENT_BYTES_NOT_ACQUIRED" }] } })) + "\n");
  await native(b, { agent_id: "child_1", agent_type: "Task", agent_transcript_path: agent }, "SubagentStop");
  const advisory = db.query("SELECT status,attributes FROM spans WHERE name='Task'").get() as { status: string; attributes: string }; expect(advisory.status).toBe("UNSET"); expect(JSON.parse(advisory.attributes)).toMatchObject({ reportedPhase: "complete", runtimeVerified: false, producerVerified: false }); expect(spans()).not.toContain("INDEPENDENT_AGENT_BYTES_NOT_ACQUIRED"); expect(db.query("SELECT incarnation_key,source_cursor FROM coding_hook_sessions").get()).toEqual(first);
  const before = spans(); await native(b, { agent_id: "child_1", agent_transcript_path: path.join(directory, "forged/agent-child_1.jsonl") }, "SubagentStop"); expect(spans()).toBe(before);
  const second = transcriptRecord({ uuid: "record_2", requestId: "request_2", message: { id: "msg_2", content: [{ type: "text", text: "MAIN_CONTINUES_AFTER_SUBSTOP" }] } }); source(b, [transcriptRecord(), second]); await native(b);
  expect(spans()).toContain("MAIN_CONTINUES_AFTER_SUBSTOP"); const current = db.query("SELECT incarnation_key,source_cursor FROM coding_hook_sessions").get() as { incarnation_key: string; source_cursor: number }; expect(current.incarnation_key).toBe(first.incarnation_key); expect(current.source_cursor).toBeGreaterThan(first.source_cursor);
});
test("offline native installation remains disabled without creating a daemon owner or full grant", async () => {
  const workspace = path.join(directory, "offline"); mkdirSync(workspace);
  const trap = netServer(); await new Promise<void>(resolve => trap.listen(0, "127.0.0.1", resolve)); const port = (trap.address() as { port: number }).port; await new Promise<void>(resolve => trap.close(() => resolve()));
  const child = spawn(realpathSync(path.resolve(import.meta.dir, "../bin/runphantom-dev")), ["hooks", "install", "claude", "--local", "--cwd", workspace, "--full", "--consent-full"], { env: { ...process.env, RUNPHANTOM_PORT: String(port), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", OPENAI_API_KEY: "", RUNPHANTOM_OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }, stdio: "pipe" }); let output = "", error = ""; child.stdout.on("data", x => output += x); child.stderr.on("data", x => error += x); child.stdin.end();
  expect(await new Promise(resolve => child.once("close", resolve))).toBe(0); expect(error).toBe(""); const result = JSON.parse(output); expect(result.policy).toBe("disabled"); expect(result.captureMode).toBe("metadata"); expect(result.transport).toBe("unavailable"); expect(getDrizzleDb().$client.query("SELECT * FROM coding_hook_owner").all()).toEqual([]);
  const settings = path.join(workspace, ".claude/settings.local.json"), id = installationIdForSettings("local", settings), cap = await readClaudeCapabilityDescriptor(path.join(directory, "profile/coding-hooks/claude", id + ".json"), id); expect(cap.state).toBe("disabled"); expect(cap.token).toBeNull(); expect(cap.ownerGeneration).toBeNull(); expect(cap.origin).toBeNull();
});
test("public management adds only registered global scopes and identical catalog registration preserves current capability", async () => {
  const runtime = await start(), first = path.join(directory, "first-project"), second = path.join(directory, "second-project"); mkdirSync(first); mkdirSync(second);
  const manage = (value: unknown) => fetch(`http://127.0.0.1:${runtime.port}/api/coding-hooks/claude/manage`, { method: "POST", headers: { "content-type": "application/json", "x-runphantom-hook-owner": capabilityOwnerKey(getDrizzleDb().$client.filename) }, body: JSON.stringify(value) });
  const install = (workspace: string) => ({ action: "install", scope: "global", workspace, captureMode: "metadata", fullConsent: false });
  expect((await manage(install(first))).status).toBe(200); const added = await manage(install(second)); expect(added.status).toBe(200); expect((await added.json() as any).registrationCount).toBe(2);
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"), id = installationIdForSettings("global", settings), file = path.join(directory, "profile/coding-hooks/claude", id + ".json"), before = await readClaudeCapabilityDescriptor(file, id);
  expect((await manage(install(first))).status).toBe(200); expect(await readClaudeCapabilityDescriptor(file, id)).toEqual(before);
  const existing = readFileSync(settings, "utf8"); expect((await manage({ ...install(first), captureMode: "full", fullConsent: true })).status).toBe(400); expect((await manage({ ...install(first), databasePath: path.join(directory, "forged.sqlite") })).status).toBe(400); expect(readFileSync(settings, "utf8")).toBe(existing); expect(existsSync(path.join(directory, "forged.sqlite"))).toBe(false);
  const removed = await manage({ ...install(first), action: "unregister" }); expect(removed.status).toBe(200); const current = await readClaudeCapabilityDescriptor(file, id); expect(current.token).not.toBe(before.token); expect(current.installationGeneration).not.toBe(before.installationGeneration); expect((await runtime.codingHooks.management().doctor(id)).registrationCount).toBe(1);
});
test("existing uninstall revokes exact owned settings before binary cleanup and preserves unknown handlers and trace bytes", async () => {
  const runtime = await start(), b = binding("local", "workspace", "full"); writeFileSync(b.settingsPath, '{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"echo unknown"}]}]}}'); await runtime.codingHooks.management().install(b, { fullConsent: true }); source(b); await native(b);
  const before = spans(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server = undefined;
  const removed = await removeConfiguredClaudeHooks(process.env.RUNPHANTOM_DB_PATH); expect(removed).toBe(1); const settings = readFileSync(b.settingsPath, "utf8"); expect(settings).toContain("echo unknown"); expect(settings).not.toContain(b.installationId); expect(existsSync(capabilityPath(b))).toBe(false); expect(spans()).toBe(before); expect(getDrizzleDb().$client.query("SELECT state,capture_mode FROM coding_hook_installations").all()).toEqual([{ state: "disabled", capture_mode: "metadata" }]);
});

function activationBody(runtime: Awaited<ReturnType<typeof start>>, ids: string[]) {
  return { action: "activate-context-v2", installationIds: [...ids].sort(), expectedOwnerGeneration: runtime.codingHooks.store.currentOwnerGeneration(), expectedInstallations: [...ids].sort().map(id => {
    const installed = runtime.codingHooks.store.readInstallation(id)!;
    return { installationId: id, generation: installed.row.generation, configSha256: installed.row.config_sha256, catalogSha256: hookDigest(installed.row.data!) };
  }) };
}
const hookRows = () => JSON.stringify(["coding_hook_owner", "coding_hook_installations", "coding_hook_sessions", "coding_hook_entities", "runs", "spans"].map(table => getDrizzleDb().$client.query(`SELECT * FROM ${table} ORDER BY rowid`).all()));
function activate(runtime: Awaited<ReturnType<typeof start>>, body: unknown) {
  return fetch(`http://127.0.0.1:${runtime.port}/api/coding-hooks/claude/manage`, { method: "POST", headers: { "content-type": "application/json", "x-runphantom-hook-owner": capabilityOwnerKey(getDrizzleDb().$client.filename) }, body: JSON.stringify(body) });
}
test("actual daemon supports manual context activation while new installations remain v1", async () => {
  const runtime = await start(), b = binding("local", "workspace", "full");
  expect(runtime.codingHooks.store.contextOptions.contextTransport).toBe(true);
  await runtime.codingHooks.management().install(b, { fullConsent: true });
  expect(runtime.codingHooks.store.readInstallation(b.installationId)!.catalogVersion).toBe("runphantom.claude-catalog/v1");
  const epoch = getDrizzleDb().$client.query("SELECT source_epoch FROM coding_hook_owner").get(), settings = readFileSync(b.settingsPath, "utf8");
  const response = await activate(runtime, activationBody(runtime, [b.installationId]));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: "configured", unchanged: false, captureVerified: false });
  expect(runtime.codingHooks.store.readInstallation(b.installationId)!.catalogVersion).toBe("runphantom.claude-catalog/v2");
  expect(getDrizzleDb().$client.query("SELECT source_epoch FROM coding_hook_owner").get()).toEqual(epoch); expect(readFileSync(b.settingsPath, "utf8")).toBe(settings);
  expect(getDrizzleDb().$client.query("SELECT * FROM coding_hook_sessions").all()).toEqual([]);
});
test("actual transport selection is read-only closed and fenced by both installed generations", async () => {
  const runtime = await start(), b = binding("local", "workspace"); await runtime.codingHooks.management().install(b);
  const cap = await readClaudeCapabilityDescriptor(capabilityPath(b), b.installationId), before = hookRows();
  const body = { version: HOOK_PROTOCOL, ownerGeneration: cap.ownerGeneration, installationGeneration: cap.installationGeneration };
  const select = (text: string, token = cap.token!) => fetch(`http://127.0.0.1:${runtime.port}/api/coding-hooks/claude/transport`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: text });
  const response = await select(JSON.stringify(body)); expect(response.status).toBe(200); expect(await response.json()).toEqual({ ...body, transport: "main-v1" }); expect(hookRows()).toBe(before);
  for (const text of [JSON.stringify({ ...body, transport: "context-v2" }), JSON.stringify({ ...body, ownerGeneration: "0".repeat(32) }), JSON.stringify({ ...body, installationGeneration: "0".repeat(32) }), JSON.stringify(body).replace('"version":', '"version":"invalid","version":')]) {
    const refused = await select(text); expect(refused.status).toBeGreaterThanOrEqual(400); expect(hookRows()).toBe(before);
  }
  expect((await select(" ".repeat(16385))).status).toBe(413); expect(hookRows()).toBe(before);
  expect((await select(JSON.stringify(body), "0".repeat(64))).status).toBe(401); expect(hookRows()).toBe(before);
});
test("manually activated actual installed vector acquires main and two independent agents without moving main cursor", async () => {
  const runtime = await start(), b = binding("local", "workspace", "full"); await runtime.codingHooks.management().install(b, { fullConsent: true });
  const old = await readClaudeCapabilityDescriptor(capabilityPath(b), b.installationId);
  expect((await activate(runtime, activationBody(runtime, [b.installationId]))).status).toBe(200); source(b); await native(b);
  const db = getDrizzleDb().$client, main = db.query("SELECT incarnation_key,source_cursor,observed_file_bytes,prefix_bytes,prefix_sha256 FROM coding_hook_sessions").get(); expect(main).not.toBeNull();
  const agents = path.join(b.projectDirectory, hookSession, "subagents"); mkdirSync(agents, { recursive: true });
  writeFileSync(path.join(agents, "agent-child_1.jsonl"), JSON.stringify(transcriptRecord()) + "\n");
  writeFileSync(path.join(agents, "agent-child_2.jsonl"), JSON.stringify(transcriptRecord({ uuid: "agent_record_2", requestId: "agent_request_2", message: { id: "agent_msg_2", model: "fixture-model", content: [{ type: "text", text: "ACTUAL_SECOND_AGENT_RESULT" }], usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })) + "\n");
  for (const id of ["child_1", "child_2"]) { await native(b, { agent_id: id, agent_type: "Task", agent_transcript_path: path.join(agents, `agent-${id}.jsonl`) }, "SubagentStop"); expect(db.query("SELECT incarnation_key,source_cursor,observed_file_bytes,prefix_bytes,prefix_sha256 FROM coding_hook_sessions").get()).toEqual(main); }
  expect(spans()).toContain("ACTUAL_SECOND_AGENT_RESULT");
  const data = db.query("SELECT data FROM coding_hook_sessions").get() as { data: string }; expect(JSON.parse(data.data).agents).toHaveLength(2); expect(JSON.parse(data.data).mainRevision).toBe(1);
  expect(db.query("SELECT sum(input_tokens) input,sum(output_tokens) output FROM spans WHERE span_type='LLM_GENERATION'").get()).toEqual({ input: 13, output: 6 });
  const before = spans(); await native(b); expect(spans()).toBe(before); expect(db.query("SELECT sum(input_tokens) input,sum(output_tokens) output FROM spans WHERE span_type='LLM_GENERATION'").get()).toEqual({ input: 13, output: 6 });
  const refused = await fetch(`http://127.0.0.1:${runtime.port}/api/coding-hooks/claude/transport`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + old.token }, body: JSON.stringify({ version: HOOK_PROTOCOL, ownerGeneration: old.ownerGeneration, installationGeneration: old.installationGeneration }) }); expect(refused.status).toBe(401); expect(spans()).toBe(before);
});
test("actual native explicit activation CLI submits only selected current CAS without printing private credentials", async () => {
  const runtime = await start(), b = binding("local", "workspace"); await runtime.codingHooks.management().install(b);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key)));
  const child = spawn(realpathSync(path.resolve(import.meta.dir, "../bin/runphantom-dev")), ["hooks", "activate-context-v2", "claude", "--installation-id", b.installationId], { env: { ...inherited, RUNPHANTOM_PORT: String(runtime.port), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdio: "pipe" });
  let output = "", error = ""; child.stdout.on("data", value => output += value); child.stderr.on("data", value => error += value); child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  const status = await new Promise(resolve => child.once("close", resolve)); clearTimeout(timer); expect(status).toBe(0); expect(error).toBe(""); expect(JSON.parse(output)).toEqual({ status: "configured", unchanged: false, captureVerified: false }); expect(output).not.toMatch(/token|ownerGeneration|Bearer|http:/); expect(runtime.codingHooks.store.readInstallation(b.installationId)!.catalogVersion).toBe("runphantom.claude-catalog/v2");
});

test("actual manual transition preserves existing v1 evidence and never upgrades its independent agent authority", async () => {
  const runtime = await start(), b = binding("local", "workspace", "full"); await runtime.codingHooks.management().install(b, { fullConsent: true }); source(b); await native(b);
  const db = getDrizzleDb().$client, before = JSON.stringify(["coding_hook_sessions", "coding_hook_entities", "runs", "spans"].map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  expect((await activate(runtime, activationBody(runtime, [b.installationId]))).status).toBe(200);
  expect(JSON.stringify(["coding_hook_sessions", "coding_hook_entities", "runs", "spans"].map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()))).toBe(before);
  const agent = path.join(b.projectDirectory, hookSession, "subagents/agent-old_v1.jsonl"); mkdirSync(path.dirname(agent), { recursive: true }); writeFileSync(agent, JSON.stringify(transcriptRecord({ uuid: "old_v1_agent", message: { id: "old_v1_agent", content: [{ type: "text", text: "V1_AGENT_MUST_NOT_BE_ACQUIRED" }] } })) + "\n");
  await native(b, { agent_id: "old_v1", agent_transcript_path: agent }, "SubagentStop"); expect(spans()).not.toContain("V1_AGENT_MUST_NOT_BE_ACQUIRED"); expect(JSON.stringify(["coding_hook_sessions", "coding_hook_entities", "runs", "spans"].map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()))).toBe(before);
  source(b, [transcriptRecord(), transcriptRecord({ uuid: "next_main", requestId: "next_main_request", message: { id: "next_main_message", model: "fixture-model", content: [{ type: "text", text: "LEGACY_MAIN_CONTINUES" }], usage: { input_tokens: 7, output_tokens: 3 } } })]); await native(b); expect(spans()).toContain("LEGACY_MAIN_CONTINUES");
  const session = db.query("SELECT data FROM coding_hook_sessions").get() as { data: string }; expect(JSON.parse(session.data).version).toBeUndefined();
});
test("actual activation rejects incomplete sharing closure and malformed owner action before any fence", async () => {
  const runtime = await start(), local = binding("local", "workspace", "full"), global = binding("global", "workspace"); await runtime.codingHooks.management().install(local, { fullConsent: true }); await runtime.codingHooks.management().install(global);
  const before = hookRows(), body = activationBody(runtime, [local.installationId]); expect((await activate(runtime, body)).status).toBe(409); expect(hookRows()).toBe(before);
  const unauthorized = await fetch(`http://127.0.0.1:${runtime.port}/api/coding-hooks/claude/manage`, { method: "POST", headers: { "content-type": "application/json", "x-runphantom-hook-owner": "0".repeat(64) }, body: JSON.stringify(activationBody(runtime, [local.installationId, global.installationId])) }); expect(unauthorized.status).toBe(403); expect(hookRows()).toBe(before);
  const duplicate = await fetch(`http://127.0.0.1:${runtime.port}/api/coding-hooks/claude/manage`, { method: "POST", headers: { "content-type": "application/json", "x-runphantom-hook-owner": capabilityOwnerKey(getDrizzleDb().$client.filename) }, body: JSON.stringify(activationBody(runtime, [local.installationId, global.installationId])).replace('"action":', '"action":"install","action":') }); expect(duplicate.status).toBe(400); expect(hookRows()).toBe(before);
  expect((await activate(runtime, activationBody(runtime, [local.installationId, global.installationId]))).status).toBe(200); expect(runtime.codingHooks.store.readInstallation(local.installationId)!.row.capture_mode).toBe("full"); expect(runtime.codingHooks.store.readInstallation(global.installationId)!.row.capture_mode).toBe("metadata");
});
test("actual clear after installed v2 capture keeps suppression and never reacquires newly appended bodies", async () => {
  const runtime = await start(), b = binding("local", "workspace", "full"); await runtime.codingHooks.management().install(b, { fullConsent: true }); expect((await activate(runtime, activationBody(runtime, [b.installationId]))).status).toBe(200); source(b); await native(b);
  const db = getDrizzleDb().$client, epoch = db.query("SELECT source_epoch FROM coding_hook_owner").get(); expect((await fetch(`http://127.0.0.1:${runtime.port}/api/clear`, { method: "POST" })).status).toBe(200); expect(db.query("SELECT source_epoch FROM coding_hook_owner").get()).toEqual(epoch); expect(db.query("SELECT state FROM coding_hook_sessions").all()).toEqual([{ state: "suppressed" }]);
  source(b, [transcriptRecord(), transcriptRecord({ uuid: "cleared_append", message: { id: "cleared_append", content: [{ type: "text", text: "CLEARED_BODY_MUST_NOT_BE_ACQUIRED" }] } })]); await native(b); expect(spans()).toBe("[]");
  await runtime.codingHooks.management().install(b, { fullConsent: true }); await native(b); expect(spans()).toBe("[]"); expect(db.query("SELECT state FROM coding_hook_sessions").all()).toEqual([{ state: "suppressed" }]);
});
