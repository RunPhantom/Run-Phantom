import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";
import { CodingHookStore, type InstallationBinding } from "../src/coding-hooks/store";
import { acquireRegisteredClaudeTranscript, ClaudeHookManagement, installationIdForSettings, readClaudeCapability } from "../src/coding-hooks/management";
import { hookFixture } from "./fixtures/coding-hooks-claude";
import { parseClaudeHookInput } from "../src/coding-hooks/shared";

let directory: string, prior: string | undefined, store: CodingHookStore, manager: ClaudeHookManagement, binding: InstallationBinding, capability: string;
beforeEach(() => {
  closeDb(); prior = process.env.RUNPHANTOM_DB_PATH; directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runphantom-f11-management-")));
  for (const relative of ["workspace/.claude", "projects/project", "projects/other", "home"]) mkdirSync(path.join(directory, relative), { recursive: true });
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "owner.sqlite"); const db = getDrizzleDb().$client;
  db.exec(readFileSync(path.join(import.meta.dir, "fixtures/coding-hooks-bootstrap.sql"), "utf8")); store = new CodingHookStore(db); store.beginOwner(); manager = new ClaudeHookManagement(store);
  const workspace = path.join(directory, "workspace"), settingsPath = path.join(workspace, ".claude/settings.local.json");
  binding = { installationId: installationIdForSettings("local", settingsPath), scope: "local", captureMode: "metadata", workspace, registeredWorkspace: workspace, transcriptRoot: path.join(directory, "projects"), projectDirectory: path.join(directory, "projects/project"), homeDirectory: path.join(directory, "home"), settingsPath, executable: process.execPath };
  capability = path.join(directory, "coding-hooks/claude", binding.installationId + ".json");
});
afterEach(() => { closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
const identity = "b".repeat(64);
async function rejects(work: Promise<unknown>) { let failed = false; try { await work; } catch { failed = true; } expect(failed).toBe(true); }
async function token() { return readClaudeCapability(capability, binding.installationId); }

test("native configuration is idempotent with a private capability and honest inactive transport", async () => {
  writeFileSync(binding.settingsPath, '{"unrelated":{"keep":true}}'); const first = await manager.install(binding), firstToken = await token(), admission = store.admit(firstToken, identity), text = readFileSync(binding.settingsPath, "utf8");
  expect(first.transport).toBe("unavailable"); expect(first.captureVerified).toBe(false); expect(first.captureCoverage).toBe("registered_workspace_only");
  expect(text).not.toContain(firstToken); expect(statSync(capability).mode & 0o777).toBe(0o600); expect(statSync(path.dirname(capability)).mode & 0o777).toBe(0o700);
  const repeated = await manager.install(binding); expect(repeated.unchanged).toBe(true); expect(await token()).toBe(firstToken); expect(store.admit(firstToken, identity).installationGeneration).toBe(admission.installationGeneration); expect(readFileSync(binding.settingsPath, "utf8")).toBe(text);
  expect((await manager.doctor(binding.installationId)).captureVerified).toBe(false);
});
test("full consent is explicit and metadata downgrade revokes the previous token", async () => {
  await rejects(manager.install({ ...binding, captureMode: "full" })); expect(existsSync(capability)).toBe(false);
  await manager.install({ ...binding, captureMode: "full" }, { fullConsent: true }); const fullToken = await token(); expect(store.admit(fullToken, identity).captureMode).toBe("full");
  await manager.install(binding); expect(await token()).not.toBe(fullToken); expect(() => store.admit(fullToken, identity)).toThrow(); expect(store.admit(await token(), identity).captureMode).toBe("metadata");
});
test("malformed edited settings fail closed and preserve the actual bytes", async () => {
  await manager.install({ ...binding, captureMode: "full" }, { fullConsent: true }); const before = await token(); writeFileSync(binding.settingsPath, '{"broken":');
  await rejects(manager.install(binding)); expect(readFileSync(binding.settingsPath, "utf8")).toBe('{"broken":'); expect(() => store.admit(before, identity)).toThrow(); expect(store.readInstallation(binding.installationId)!.row.state).toBe("disabled");
});
test("capability symlinks and broad permissions refuse adoption without touching their target", async () => {
  await manager.install(binding); const sentinel = path.join(directory, "sentinel"); writeFileSync(sentinel, "PRIVATE_TARGET"); rmSync(capability); symlinkSync(sentinel, capability);
  await rejects(manager.install(binding)); expect(readFileSync(sentinel, "utf8")).toBe("PRIVATE_TARGET"); expect(store.readInstallation(binding.installationId)!.row.state).toBe("disabled");
  rmSync(capability); await manager.install(binding); chmodSync(capability, 0o644); await rejects(readClaudeCapability(capability, binding.installationId));
});
test("uninstall revokes authority first and removes only the known vector", async () => {
  writeFileSync(binding.settingsPath, '{"unrelated":true,"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"echo unknown"}]}]}}'); await manager.install(binding); const before = await token();
  expect((await manager.uninstall(binding.installationId)).status).toBe("removed"); expect(() => store.admit(before, identity)).toThrow(); expect(existsSync(capability)).toBe(false);
  const text = readFileSync(binding.settingsPath, "utf8"); expect(text).toContain("echo unknown"); expect(text).toContain('"unrelated"'); expect(text).not.toContain(binding.installationId);
});
test("native lease contention refuses without modifying config or authority", async () => {
  await manager.install(binding); const before = await token(), text = readFileSync(binding.settingsPath, "utf8"), lease = path.join(path.dirname(capability), binding.installationId + ".lock"); writeFileSync(lease, "held", { mode: 0o600 });
  await rejects(manager.install({ ...binding, captureMode: "full" }, { fullConsent: true })); expect(await token()).toBe(before); expect(readFileSync(binding.settingsPath, "utf8")).toBe(text); expect(store.admit(before, identity).captureMode).toBe("metadata");
});
test("registered descriptor authority refuses forged cwd, another project and symlinks before acquisition", async () => {
  await manager.install({ ...binding, captureMode: "full" }, { fullConsent: true }); const admission = store.admit(await token(), identity), file = path.join(binding.projectDirectory, "session_fixture.jsonl"), other = path.join(binding.transcriptRoot, "other/session_fixture.jsonl"); writeFileSync(file, '{"ordinary":"source"}\n'); writeFileSync(other, "PRIVATE_OTHER_PROJECT");
  const parsed = parseClaudeHookInput(hookFixture("Stop", { session_id: "session_fixture", cwd: binding.registeredWorkspace, transcript_path: file })); if (parsed.status !== "accepted") throw new Error("fixture hook");
  expect((await acquireRegisteredClaudeTranscript(parsed.value, admission)).status).toBe("accepted");
  expect(await acquireRegisteredClaudeTranscript({ ...parsed.value, cwd: directory }, admission)).toEqual({ status: "unavailable", reason: "path_not_authorized" });
  expect(await acquireRegisteredClaudeTranscript({ ...parsed.value, transcriptPath: other }, admission)).toEqual({ status: "unavailable", reason: "path_not_authorized" });
  rmSync(file); symlinkSync(other, file); expect((await acquireRegisteredClaudeTranscript(parsed.value, admission)).status).toBe("unavailable");
});

test("an owner rotation across actual capability/settings awaits cannot activate prepared policy", async () => {
  const prepare = store.prepareInstallation.bind(store); store.prepareInstallation = (...args) => { const receipt = prepare(...args); store.rotateOwner(); return receipt; };
  await rejects(manager.install({ ...binding, captureMode: "full" }, { fullConsent: true }));
  expect(store.readInstallation(binding.installationId)!.row.state).toBe("disabled"); const revoked = await token(); expect(() => store.admit(revoked, identity)).toThrow();
});
test("doctor distinguishes installed settings from an unavailable private capability", async () => {
  await manager.install(binding); expect((await manager.doctor(binding.installationId)).capability).toBe("available"); rmSync(capability);
  const status = await manager.doctor(binding.installationId); expect(status.configuration).toBe("installed"); expect(status.capability).toBe("unavailable"); expect(status.transport).toBe("unavailable"); expect(status.captureVerified).toBe(false);
});
