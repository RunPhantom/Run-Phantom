import { afterEach, beforeEach, expect, test } from "bun:test";
import { symlinkSync, writeFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, request } from "node:http";
import { CodingHookController } from "../src/coding-hooks/service";
import { acquireRegisteredClaudeTranscript } from "../src/coding-hooks/management";
import { parseClaudeHookInput } from "../src/coding-hooks/shared";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";
import { CodingHookStore, type HookAdmission, type InstallationBinding } from "../src/coding-hooks/store";
import { ClaudeHookManagement, installationIdForSettings, readClaudeCapability } from "../src/coding-hooks/management";
import { HOOK_PROTOCOL, hookDigest, parseHookAdmission } from "../src/coding-hooks/protocol";
import { normalizeClaudeHook } from "../src/coding-hooks/claude";
import { hookFixture, transcriptRecord, transcriptSnapshot } from "./fixtures/coding-hooks-claude";

interface Registration { registrationId: string; registeredWorkspace: string; transcriptRoot: string; projectDirectory: string; homeDirectory: string; }
// The actual source migration supplies schema; these store fixtures use a trusted test-only guard. Product startup uses the kernel lease.
let directory: string, prior: string | undefined, store: CodingHookStore, manager: ClaudeHookManagement, binding: InstallationBinding, registrations: Registration[];
const identity = "b".repeat(64);
const claims = (registration: Registration) => ({ workspaceClaim: hookDigest(JSON.stringify(["runphantom.claude.workspace-claim/v1", registration.registeredWorkspace])), projectClaim: hookDigest(JSON.stringify(["runphantom.claude.project-claim/v1", registration.projectDirectory])) });
const admit = (token: string, registration: Registration) => store.admit(token, identity, claims(registration));
const install = (value: InstallationBinding, roots: Registration[]) => manager.install(value, { registrations: roots, fullConsent: true });
const token = (id = binding.installationId) => readClaudeCapability(path.join(directory, "coding-hooks/claude", id + ".json"), id);
beforeEach(() => {
  closeDb(); prior = process.env.RUNPHANTOM_DB_PATH; directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runphantom-f11-catalog-")));
  for (const name of ["workspace-one/.claude", "workspace-two/.claude", "projects/one", "projects/two", "home/.claude"]) mkdirSync(path.join(directory, name), { recursive: true });
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "owner.sqlite"); const db = getDrizzleDb().$client; store = new CodingHookStore(db, {}, () => true); store.beginOwner(); manager = new ClaudeHookManagement(store, "http://127.0.0.1:5947");
  registrations = ["one", "two"].map(name => { const registeredWorkspace = path.join(directory, "workspace-" + name), transcriptRoot = path.join(directory, "projects"), projectDirectory = path.join(transcriptRoot, name); return { registrationId: hookDigest(JSON.stringify(["runphantom.claude.root/v1", registeredWorkspace, transcriptRoot, projectDirectory])), registeredWorkspace, transcriptRoot, projectDirectory, homeDirectory: path.join(directory, "home") }; });
  const settingsPath = path.join(directory, "home/.claude/settings.json"), first = registrations[0]; binding = { installationId: installationIdForSettings("global", settingsPath), scope: "global", captureMode: "metadata", workspace: null, registeredWorkspace: first.registeredWorkspace, transcriptRoot: first.transcriptRoot, projectDirectory: first.projectDirectory, homeDirectory: first.homeDirectory, settingsPath, executable: process.execPath };
});
afterEach(() => { closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
function batch(admission: HookAdmission) { const result = normalizeClaudeHook(hookFixture("Stop"), { sourceKey: admission.sourceKey, captureMode: "full" }, transcriptSnapshot([transcriptRecord()])); if (result.status !== "accepted") throw new Error("fixture"); return result.value; }
async function rejects(work: Promise<unknown>) { let failed = false; try { await work; } catch { failed = true; } expect(failed).toBe(true); }

test("one actual global settings capability admits two registered workspaces as separate metadata identities", async () => {
  await install(binding, registrations); const capability = await token(), first = admit(capability, registrations[0]), second = admit(capability, registrations[1]);
  expect(second.sourceKey).not.toBe(first.sourceKey); expect(second.binding.projectDirectory).toBe(registrations[1].projectDirectory); expect(second.captureMode).toBe("metadata");
  store.publish(capability, first, batch(first)); store.publish(capability, second, batch(second)); expect(store.db.query("SELECT id FROM runs").all()).toHaveLength(2); expect(JSON.stringify(store.db.query("SELECT * FROM spans").all())).not.toContain("safe exact business result");
  const status = await manager.doctor(binding.installationId); expect(status.registrationCount).toBe(2); expect(status.captureCoverage).toBe("registered_workspaces"); expect(status.transport).toBe("unavailable"); expect(status.captureVerified).toBe(false);
});
test("closed admission requires two consistent finite matching claims and refuses unregistered scopes", async () => {
  await install(binding, registrations); const capability = await token(), request = { version: HOOK_PROTOCOL, sourceSessionIdentity: identity, ...claims(registrations[1]) };
  expect(parseHookAdmission(JSON.stringify(request))).toEqual({ sourceSessionIdentity: identity, ...claims(registrations[1]) });
  expect(() => parseHookAdmission(JSON.stringify({ ...request, captureMode: "full", database: "/private/other.sqlite" }))).toThrow();
  expect(() => parseHookAdmission(JSON.stringify({ version: HOOK_PROTOCOL, sourceSessionIdentity: identity }))).toThrow();
  expect(() => store.admit(capability, identity, { ...claims(registrations[0]), projectClaim: claims(registrations[1]).projectClaim })).toThrow();
});
test("exact catalog reinstall is idempotent and conflicting workspace/project mappings refuse without new grants", async () => {
  await install(binding, registrations); const before = await token(), generation = admit(before, registrations[0]).installationGeneration;
  expect((await install(binding, [...registrations, registrations[0]])).unchanged).toBe(true); expect(await token()).toBe(before); expect(admit(before, registrations[0]).installationGeneration).toBe(generation);
  const ambiguous = { ...registrations[1], registeredWorkspace: registrations[0].registeredWorkspace }; ambiguous.registrationId = hookDigest(JSON.stringify(["runphantom.claude.root/v1", ambiguous.registeredWorkspace, ambiguous.transcriptRoot, ambiguous.projectDirectory])); await rejects(install(binding, [registrations[0], ambiguous]));
});
test("same actual project global metadata/local full shares once-only usage without sharing capture policy", async () => {
  await install(binding, registrations); const globalToken = await token(), global = admit(globalToken, registrations[0]), first = registrations[0], settingsPath = path.join(first.registeredWorkspace, ".claude/settings.local.json"), local = { ...binding, installationId: installationIdForSettings("local", settingsPath), scope: "local" as const, captureMode: "full" as const, workspace: first.registeredWorkspace, settingsPath };
  await install(local, [first]); const fullToken = await token(local.installationId), full = admit(fullToken, first); expect(full.sourceKey).toBe(global.sourceKey);
  store.publish(fullToken, full, batch(full)); store.publish(globalToken, global, batch(global)); expect(store.db.query("SELECT input_tokens,output_tokens FROM spans WHERE run_id=? AND span_type='LLM_GENERATION'").all(full.runId)).toEqual([{ input_tokens: 10, output_tokens: 4 }]);
  const other = admit(globalToken, registrations[1]); store.publish(globalToken, other, batch(other)); expect(JSON.stringify(store.db.query("SELECT * FROM spans WHERE run_id=?").all(other.runId))).not.toContain("safe exact business result"); expect(() => store.publish(fullToken, other, batch(other))).toThrow();
});

test("actual streamed publication is fenced by unregister before any filesystem await and retains earlier evidence", async () => {
  await install(binding, registrations); const oldToken = await token(), first = admit(oldToken, registrations[0]); store.publish(oldToken, first, batch(first)); const before = JSON.stringify(store.db.query("SELECT * FROM spans ORDER BY id").all());
  const controller = new CodingHookController(store), server = createServer((req, res) => { void controller.handle(req, res); }); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture");
  const client = request({ hostname: "127.0.0.1", port: address.port, path: "/api/coding-hooks/claude/publication", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + oldToken } });
  const response = new Promise<number>((resolve, reject) => { client.once("error", reject); client.once("response", res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); }); }); void response.catch(() => undefined);
  const body = JSON.stringify({ version: HOOK_PROTOCOL, ownerGeneration: first.ownerGeneration, installationGeneration: first.installationGeneration, sourceKey: first.sourceKey, batch: batch(first) }); client.write(body.slice(0, -1));
  const deadline = performance.now() + 500; while (controller.stats().active !== 1) { if (performance.now() > deadline) throw new Error("fixture barrier"); await new Promise<void>(resolve => setImmediate(resolve)); }
  let revokedAtPrepare = false; const prepare = store.prepareInstallation.bind(store); store.prepareInstallation = (...args) => { const receipt = prepare(...args); try { store.authenticate(oldToken); } catch { revokedAtPrepare = true; } return receipt; };
  try { await manager.unregister(binding.installationId, registrations[1].registrationId); expect(revokedAtPrepare).toBe(true); client.end(body.slice(-1)); expect(await response).toBe(401); expect(JSON.stringify(store.db.query("SELECT * FROM spans ORDER BY id").all())).toBe(before); const currentToken = await token(); expect(currentToken).not.toBe(oldToken); expect(() => admit(currentToken, registrations[1])).toThrow(); expect(admit(currentToken, registrations[0]).sourceKey).toBe(first.sourceKey); }
  finally { client.destroy(); await controller.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("symlink/overlapping registration and forged source path cannot grant acquisition", async () => {
  await install(binding, registrations); const first = registrations[0], admission = admit(await token(), first), filename = "11111111-1111-4111-8111-111111111111.jsonl", file = path.join(first.projectDirectory, filename), other = path.join(registrations[1].projectDirectory, filename); writeFileSync(file, "PRIVATE_ONE"); writeFileSync(other, "PRIVATE_TWO");
  const hook = parseClaudeHookInput(hookFixture("Stop", { cwd: first.registeredWorkspace, transcript_path: other })); if (hook.status !== "accepted") throw new Error("fixture"); expect((await acquireRegisteredClaudeTranscript(hook.value, admission)).status).toBe("unavailable");
  rmSync(file); symlinkSync(other, file); expect((await acquireRegisteredClaudeTranscript({ ...hook.value, transcriptPath: file }, admission)).status).toBe("unavailable");
  const symlinkWorkspace = path.join(directory, "workspace-link"); symlinkSync(first.registeredWorkspace, symlinkWorkspace); const linked = { ...first, registeredWorkspace: symlinkWorkspace }; linked.registrationId = hookDigest(JSON.stringify(["runphantom.claude.root/v1", linked.registeredWorkspace, linked.transcriptRoot, linked.projectDirectory])); await rejects(install(binding, [first, linked]));
  const overlap = { ...registrations[1], transcriptRoot: first.projectDirectory, projectDirectory: path.join(first.projectDirectory, "nested") }; mkdirSync(overlap.projectDirectory); overlap.registrationId = hookDigest(JSON.stringify(["runphantom.claude.root/v1", overlap.registeredWorkspace, overlap.transcriptRoot, overlap.projectDirectory])); await rejects(install(binding, [first, overlap]));
});
test("complete encoded catalog row and aggregate disabled/local occurrences enforce actual SQLite quotas", async () => {
  await install(binding, registrations); const before = JSON.stringify(store.db.query("SELECT * FROM coding_hook_installations").all()), tokenBefore = await token();
  const oversized = Array.from({ length: 40 }, (_, index) => { const registeredWorkspace = path.join(directory, "quota-workspace-" + index), projectDirectory = path.join(binding.transcriptRoot, "quota-project-" + index); return { ...registrations[0], registeredWorkspace, projectDirectory, registrationId: hookDigest(JSON.stringify(["runphantom.claude.root/v1", registeredWorkspace, binding.transcriptRoot, projectDirectory])) }; });
  expect(() => store.prepareInstallation(binding, "d".repeat(64), "c".repeat(64), [registrations[0], ...oversized])).toThrow(); expect(JSON.stringify(store.db.query("SELECT * FROM coding_hook_installations").all())).toBe(before);
  const low = new CodingHookStore(store.db, { registrations: 2 }, () => true), local = { ...binding, installationId: "d".repeat(32), scope: "local" as const, workspace: binding.registeredWorkspace, settingsPath: path.join(binding.registeredWorkspace, ".claude/settings.local.json") }; expect(() => low.prepareInstallation(local, "d".repeat(64), "c".repeat(64))).toThrow(); expect(() => admit(tokenBefore, registrations[1])).not.toThrow();
  store.disableInstallation(binding.installationId); expect(() => low.prepareInstallation(local, "d".repeat(64), "c".repeat(64))).toThrow(); expect(store.db.query("SELECT id FROM coding_hook_installations").all()).toHaveLength(1);
});
test("catalog filesystem failure preserves malformed settings and leaves changed authority disabled", async () => {
  await install(binding, registrations); const before = await token(); writeFileSync(binding.settingsPath, '{"broken":'); await rejects(install(binding, [registrations[0]])); expect(readFileSync(binding.settingsPath, "utf8")).toBe('{"broken":'); expect(() => store.authenticate(before)).toThrow(); expect(store.readInstallation(binding.installationId)!.row.state).toBe("disabled");
});

test("exact 64 aggregate registration occurrences include disabled authorities and refuse the next row atomically", async () => {
  await install(binding, registrations);
  for (let index = 0; index < 62; index++) {
    const workspace = path.join(directory, "count-workspace-" + index), projectDirectory = path.join(binding.transcriptRoot, "count-project-" + index); mkdirSync(path.join(workspace, ".claude"), { recursive: true }); mkdirSync(projectDirectory); const settingsPath = path.join(workspace, ".claude/settings.local.json");
    store.prepareInstallation({ ...binding, installationId: installationIdForSettings("local", settingsPath), scope: "local", workspace, registeredWorkspace: workspace, projectDirectory, settingsPath }, (index + 1).toString(16).padStart(64, "0"), "c".repeat(64));
  }
  expect((store.db.query("SELECT sum(json_array_length(data,'$.registrations')) count FROM coding_hook_installations").get() as { count: number }).count).toBe(64);
  const before = JSON.stringify(store.db.query("SELECT * FROM coding_hook_installations ORDER BY id").all()); expect(() => store.prepareInstallation({ ...binding, installationId: "e".repeat(32) }, "e".repeat(64), "c".repeat(64), registrations)).toThrow(); expect(JSON.stringify(store.db.query("SELECT * FROM coding_hook_installations ORDER BY id").all())).toBe(before);
});
test("actual UTF8 owner state over 32MiB refuses before retained row acquisition", async () => {
  await install(binding, registrations); const capability = await token(), claimsFirst = claims(registrations[0]);
  const sessions = [1, 2, 3].map(index => store.admit(capability, index.toString(16).padStart(64, "0"), claimsFirst)); const data = JSON.stringify({ privateQuotaFixture: "x".repeat(12000) });
  store.db.transaction(() => { const insert = store.db.query("INSERT INTO coding_hook_entities VALUES(?,?,?,'tool','pending',NULL,NULL,?,?,?,1)"); for (let index = 0; index < 2800; index++) { const entity = hookDigest("quota-fixture:" + index); insert.run(sessions[Math.floor(index / 1000)].sourceKey, entity, entity.slice(0, 16), "a".repeat(64), "a".repeat(64), data); } }).immediate();
  expect((store.db.query("SELECT sum(length(CAST(data AS BLOB))) bytes FROM coding_hook_entities").get() as { bytes: number }).bytes).toBeGreaterThan(33554432);
  const before = JSON.stringify(store.db.query("SELECT * FROM coding_hook_sessions").all()); expect(() => admit(capability, registrations[0])).toThrow(); expect(JSON.stringify(store.db.query("SELECT * FROM coding_hook_sessions").all())).toBe(before);
  store.db.exec("DELETE FROM coding_hook_entities"); expect(admit(capability, registrations[0]).captureMode).toBe("metadata");
});
test("catalog cannot represent global full or grant a local capability multiple roots", async () => {
  await rejects(install({ ...binding, captureMode: "full" }, registrations)); const settingsPath = path.join(binding.registeredWorkspace, ".claude/settings.local.json"), local = { ...binding, installationId: installationIdForSettings("local", settingsPath), scope: "local" as const, workspace: binding.registeredWorkspace, captureMode: "full" as const, settingsPath };
  await rejects(install(local, registrations)); expect(store.db.query("SELECT id FROM coding_hook_installations").all()).toEqual([]);
});

test("both actual registered workspace descriptors admit their own source bytes under global metadata", async () => {
  await install(binding, registrations); const capability = await token();
  for (const registration of registrations) {
    const admission = admit(capability, registration), file = path.join(registration.projectDirectory, "11111111-1111-4111-8111-111111111111.jsonl"), rawHook = hookFixture("Stop", { cwd: registration.registeredWorkspace, transcript_path: file });
    writeFileSync(file, JSON.stringify(transcriptRecord()) + "\n"); const hook = parseClaudeHookInput(rawHook); if (hook.status !== "accepted") throw new Error("fixture");
    const snapshot = await acquireRegisteredClaudeTranscript(hook.value, admission); expect(snapshot.status).toBe("accepted"); if (snapshot.status !== "accepted") throw new Error("fixture descriptor");
    const normalized = normalizeClaudeHook(rawHook, { sourceKey: admission.sourceKey, captureMode: admission.captureMode }, snapshot.value); if (normalized.status !== "accepted") throw new Error("fixture normalization");
    expect(JSON.stringify(normalized.value)).not.toContain("safe exact business result"); expect(store.publish(capability, admission, normalized.value).status).toBe("accepted");
  }
  expect(store.db.query("SELECT id FROM runs").all()).toHaveLength(2); expect(store.db.query("SELECT input_tokens,output_tokens FROM spans WHERE span_type='LLM_GENERATION'").all()).toEqual([{ input_tokens: 10, output_tokens: 4 }, { input_tokens: 10, output_tokens: 4 }]);
});
