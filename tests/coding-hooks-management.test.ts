import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";
import { claimsForRegistration } from "../src/coding-hooks/catalog";
import { CodingHookStore, type InstallationBinding } from "../src/coding-hooks/store";
import { acquireRegisteredClaudeTranscript, ClaudeHookManagement, installationIdForSettings, readClaudeCapability } from "../src/coding-hooks/management";
import { hookFixture } from "./fixtures/coding-hooks-claude";
import { parseClaudeHookInput } from "../src/coding-hooks/shared";
import { capabilityOwnerKey, readClaudeCapabilityDescriptor } from "../src/coding-hooks/capability";
import { Database } from "bun:sqlite";
import { startCodingHookOwner } from "../src/coding-hooks/owner";

// The actual source migration supplies schema; these store fixtures use a trusted test-only guard. Product startup uses the kernel lease.
let directory: string, prior: string | undefined, store: CodingHookStore, manager: ClaudeHookManagement, binding: InstallationBinding, capability: string;
beforeEach(() => {
  closeDb(); prior = process.env.RUNPHANTOM_DB_PATH; directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runphantom-f11-management-")));
  for (const relative of ["workspace/.claude", "projects/project", "projects/other", "home"]) mkdirSync(path.join(directory, relative), { recursive: true });
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "owner.sqlite"); const db = getDrizzleDb().$client;
  store = new CodingHookStore(db, {}, () => true); store.beginOwner(); manager = new ClaudeHookManagement(store, "http://127.0.0.1:5947");
  const workspace = path.join(directory, "workspace"), settingsPath = path.join(workspace, ".claude/settings.local.json");
  binding = { installationId: installationIdForSettings("local", settingsPath), scope: "local", captureMode: "metadata", workspace, registeredWorkspace: workspace, transcriptRoot: path.join(directory, "projects"), projectDirectory: path.join(directory, "projects/project"), homeDirectory: path.join(directory, "home"), settingsPath, executable: process.execPath };
  capability = path.join(directory, "coding-hooks/claude", binding.installationId + ".json");
});
afterEach(() => { closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
const admit = (token: string, identity: string) => store.admit(token, identity, claimsForRegistration(store.authenticate(token).binding));
const identity = "b".repeat(64);
async function rejects(work: Promise<unknown>) { let failed = false; try { await work; } catch { failed = true; } expect(failed).toBe(true); }
async function token() { return readClaudeCapability(capability, binding.installationId); }

test("native configuration is idempotent with a private capability and honest inactive transport", async () => {
  writeFileSync(binding.settingsPath, '{"unrelated":{"keep":true}}'); const first = await manager.install(binding), firstToken = await token(), admission = admit(firstToken, identity), text = readFileSync(binding.settingsPath, "utf8");
  expect(first.transport).toBe("unavailable"); expect(first.captureVerified).toBe(false); expect(first.captureCoverage).toBe("registered_workspace_only");
  expect(text).not.toContain(firstToken); expect(statSync(capability).mode & 0o777).toBe(0o600); expect(statSync(path.dirname(capability)).mode & 0o777).toBe(0o700);
  const repeated = await manager.install(binding); expect(repeated.unchanged).toBe(true); expect(await token()).toBe(firstToken); expect(admit(firstToken, identity).installationGeneration).toBe(admission.installationGeneration); expect(readFileSync(binding.settingsPath, "utf8")).toBe(text);
  expect((await manager.doctor(binding.installationId)).captureVerified).toBe(false);
});
test("full consent is explicit and metadata downgrade revokes the previous token", async () => {
  await rejects(manager.install({ ...binding, captureMode: "full" })); expect(existsSync(capability)).toBe(false);
  await manager.install({ ...binding, captureMode: "full" }, { fullConsent: true }); const fullToken = await token(); expect(admit(fullToken, identity).captureMode).toBe("full");
  await manager.install(binding); expect(await token()).not.toBe(fullToken); expect(() => admit(fullToken, identity)).toThrow(); expect(admit(await token(), identity).captureMode).toBe("metadata");
});
test("malformed edited settings fail closed and preserve the actual bytes", async () => {
  await manager.install({ ...binding, captureMode: "full" }, { fullConsent: true }); const before = await token(); writeFileSync(binding.settingsPath, '{"broken":');
  await rejects(manager.install(binding)); expect(readFileSync(binding.settingsPath, "utf8")).toBe('{"broken":'); expect(() => admit(before, identity)).toThrow(); expect(store.readInstallation(binding.installationId)!.row.state).toBe("disabled");
});
test("capability symlinks and broad permissions refuse adoption without touching their target", async () => {
  await manager.install(binding); const sentinel = path.join(directory, "sentinel"); writeFileSync(sentinel, "PRIVATE_TARGET"); rmSync(capability); symlinkSync(sentinel, capability);
  await rejects(manager.install(binding)); expect(readFileSync(sentinel, "utf8")).toBe("PRIVATE_TARGET"); expect(store.readInstallation(binding.installationId)!.row.state).toBe("disabled");
  rmSync(capability); await manager.install(binding); chmodSync(capability, 0o644); await rejects(readClaudeCapability(capability, binding.installationId));
});
test("uninstall revokes authority first and removes only the known vector", async () => {
  writeFileSync(binding.settingsPath, '{"unrelated":true,"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"echo unknown"}]}]}}'); await manager.install(binding); const before = await token();
  expect((await manager.uninstall(binding.installationId)).status).toBe("removed"); expect(() => admit(before, identity)).toThrow(); expect(existsSync(capability)).toBe(false);
  const text = readFileSync(binding.settingsPath, "utf8"); expect(text).toContain("echo unknown"); expect(text).toContain('"unrelated"'); expect(text).not.toContain(binding.installationId);
});
test("native lease contention refuses without modifying config or authority", async () => {
  await manager.install(binding); const before = await token(), text = readFileSync(binding.settingsPath, "utf8"), lease = path.join(path.dirname(capability), binding.installationId + ".lock"); writeFileSync(lease, "held", { mode: 0o600 });
  await rejects(manager.install({ ...binding, captureMode: "full" }, { fullConsent: true })); expect(await token()).toBe(before); expect(readFileSync(binding.settingsPath, "utf8")).toBe(text); expect(admit(before, identity).captureMode).toBe("metadata");
});
test("registered descriptor authority refuses forged cwd, another project and symlinks before acquisition", async () => {
  await manager.install({ ...binding, captureMode: "full" }, { fullConsent: true }); const admission = admit(await token(), identity), file = path.join(binding.projectDirectory, "session_fixture.jsonl"), other = path.join(binding.transcriptRoot, "other/session_fixture.jsonl"); writeFileSync(file, '{"ordinary":"source"}\n'); writeFileSync(other, "PRIVATE_OTHER_PROJECT");
  const parsed = parseClaudeHookInput(hookFixture("Stop", { session_id: "session_fixture", cwd: binding.registeredWorkspace, transcript_path: file })); if (parsed.status !== "accepted") throw new Error("fixture hook");
  expect((await acquireRegisteredClaudeTranscript(parsed.value, admission)).status).toBe("accepted");
  expect(await acquireRegisteredClaudeTranscript({ ...parsed.value, cwd: directory }, admission)).toEqual({ status: "unavailable", reason: "path_not_authorized" });
  expect(await acquireRegisteredClaudeTranscript({ ...parsed.value, transcriptPath: other }, admission)).toEqual({ status: "unavailable", reason: "path_not_authorized" });
  rmSync(file); symlinkSync(other, file); expect((await acquireRegisteredClaudeTranscript(parsed.value, admission)).status).toBe("unavailable");
});

test("an owner rotation across actual capability/settings awaits cannot activate prepared policy", async () => {
  const prepare = store.prepareInstallation.bind(store); store.prepareInstallation = (...args) => { const receipt = prepare(...args); store.rotateOwner(); return receipt; };
  await rejects(manager.install({ ...binding, captureMode: "full" }, { fullConsent: true }));
  expect(store.readInstallation(binding.installationId)!.row.state).toBe("disabled"); const revoked = await token(); expect(() => admit(revoked, identity)).toThrow();
});
test("doctor distinguishes installed settings from an unavailable private capability", async () => {
  await manager.install(binding); expect((await manager.doctor(binding.installationId)).capability).toBe("available"); rmSync(capability);
  const status = await manager.doctor(binding.installationId); expect(status.configuration).toBe("installed"); expect(status.capability).toBe("unavailable"); expect(status.transport).toBe("unavailable"); expect(status.captureVerified).toBe(false);
});
test("inactive installation creates only inert configuration and a disabled private descriptor without fake owner generations", async () => {
  store.db.exec("DELETE FROM coding_hook_owner"); const inactive = new ClaudeHookManagement(new CodingHookStore(store.db));
  const before = JSON.stringify(store.db.query("SELECT * FROM coding_hook_owner").all()), result = await inactive.install({ ...binding, captureMode: "full" }, { fullConsent: true });
  expect(result.policy).toBe("disabled"); expect(result.captureMode).toBe("metadata"); expect(result.transport).toBe("unavailable"); expect(result.captureVerified).toBe(false);
  expect(JSON.stringify(store.db.query("SELECT * FROM coding_hook_owner").all())).toBe(before); expect(store.db.query("SELECT * FROM coding_hook_installations").all()).toEqual([]);
  const descriptor = await readClaudeCapabilityDescriptor(capability, binding.installationId, capabilityOwnerKey(realpathSync(store.db.filename)));
  expect(descriptor.state).toBe("disabled"); expect(descriptor.token).toBeNull(); expect(descriptor.ownerGeneration).toBeNull(); expect(descriptor.installationGeneration).toBeNull(); expect(descriptor.origin).toBeNull();
  expect(readFileSync(binding.settingsPath, "utf8")).toContain(capability); expect(() => new CodingHookStore(store.db).beginOwner()).toThrow("inactive");
  expect(result.captureCoverage).toBe("inactive"); expect(result.registrationCount).toBe(0);
  const configuredOrigin = new ClaudeHookManagement(new CodingHookStore(store.db), "http://127.0.0.1:5947"); expect((await configuredOrigin.install({ ...binding, captureMode: "full" }, { fullConsent: true })).policy).toBe("disabled");
  expect(JSON.stringify(store.db.query("SELECT * FROM coding_hook_owner").all())).toBe(before);
  const diagnostic = await inactive.doctor(binding.installationId, binding); expect(diagnostic.configuration).toBe("installed"); expect(diagnostic.capturePolicy).toBe("inactive"); expect(diagnostic.owner).toBe("inactive"); expect(diagnostic.captureVerified).toBe(false);
  expect((await inactive.uninstall(binding.installationId, binding)).status).toBe("removed"); expect(existsSync(capability)).toBe(false); expect(readFileSync(binding.settingsPath, "utf8")).not.toContain(binding.installationId);
  expect(JSON.stringify(store.db.query("SELECT * FROM coding_hook_owner").all())).toBe(before);
});
test("real lifetime lease release across filesystem awaits fences the final management commit", async () => {
  const owner = await startCodingHookOwner(store.db), management = new ClaudeHookManagement(owner.store, "http://127.0.0.1:5947"), prepare = owner.store.prepareInstallation.bind(owner.store);
  let closing: Promise<void> | undefined;
  owner.store.prepareInstallation = (...args) => { const receipt = prepare(...args); closing = owner.close(); return receipt; };
  try {
    await rejects(management.install({ ...binding, captureMode: "full" }, { fullConsent: true })); await closing;
    expect(owner.lease.isActive()).toBe(false); expect(owner.store.readInstallation(binding.installationId)!.row.state).toBe("disabled");
    const diagnostic = await management.doctor(binding.installationId); expect(diagnostic.owner).toBe("inactive"); expect(diagnostic.capturePolicy).toBe("inactive"); expect(diagnostic.capability).toBe("unavailable"); expect(diagnostic.captureVerified).toBe(false);
  } finally { await owner.close(); }
});
test("a changed actual owner generation refreshes only the private descriptor and preserves identical catalog/token", async () => {
  await manager.install(binding); const before = await token(), prior = await readClaudeCapabilityDescriptor(capability, binding.installationId); store.rotateOwner();
  const repeated = await manager.install(binding), current = await readClaudeCapabilityDescriptor(capability, binding.installationId);
  expect(repeated.unchanged).toBe(true); expect(current.ownerGeneration).not.toBe(prior.ownerGeneration); expect(current.ownerGeneration).toBe(store.currentOwnerGeneration());
  expect(current.installationGeneration).toBe(prior.installationGeneration); expect(await token()).toBe(before);
});
test("distinct actual profiles cannot borrow duplicate-ID settings or a copied private capability", async () => {
  const custom = path.join(directory, "custom profile"); mkdirSync(custom, { mode: 0o700 }); const customDb = path.join(custom, "owner.sqlite");
  // SQLite makes an actual consistent file snapshot including WAL content; this remains test-only bootstrap.
  store.db.query("VACUUM INTO ?").run(customDb); const db = new Database(customDb);
  try {
    const otherStore = new CodingHookStore(db, {}, () => true); otherStore.beginOwner(); const otherManager = new ClaudeHookManagement(otherStore, "http://127.0.0.1:5949");
    await manager.install(binding); const currentToken = await token(), text = readFileSync(binding.settingsPath, "utf8");
    await rejects(otherManager.install({ ...binding, executable: "/private/other executable" })); expect(readFileSync(binding.settingsPath, "utf8")).toBe(text); expect(otherStore.readInstallation(binding.installationId)).toBeNull(); expect(admit(currentToken, identity).captureMode).toBe("metadata");
    const otherCapability = path.join(custom, "coding-hooks/claude", binding.installationId + ".json"); expect(otherCapability).not.toBe(capability); expect(existsSync(otherCapability)).toBe(false);
    mkdirSync(path.dirname(otherCapability), { recursive: true, mode: 0o700 }); writeFileSync(otherCapability, readFileSync(capability), { mode: 0o600 });
    await rejects(readClaudeCapabilityDescriptor(otherCapability, binding.installationId, capabilityOwnerKey(realpathSync(customDb))));
    expect(() => otherStore.authenticate(currentToken)).toThrow("unauthorized");
  } finally { db.close(); }
});
