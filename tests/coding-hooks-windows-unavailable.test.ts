import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as filePromises from "node:fs/promises";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { closeDb, getDrizzleDb } from "../src/db";
import { CAPABILITY_VERSION, capabilityOwnerKey, ClaudeCapabilityRefusal, encodeClaudeCapability, readClaudeCapabilityDescriptor } from "../src/coding-hooks/capability";
import { claimsForRegistration, registrationForBinding, sourceRootKey, type SourceRegistration } from "../src/coding-hooks/catalog";
import { ClaudeHookManagement, installationIdForSettings } from "../src/coding-hooks/management";
import { HookRefusal } from "../src/coding-hooks/protocol";
import { CodingHookStore, type InstallationBinding } from "../src/coding-hooks/store";
import { normalizeClaudeHook } from "../src/coding-hooks/claude";
import { hookFixture } from "./fixtures/coding-hooks-claude";

// These controls qualify the inactive Windows boundary, not native private-file support.
describe.skipIf(process.platform !== "win32")("native Windows unavailable private hook capability", () => {
  let directory: string, previousDatabase: string | undefined, store: CodingHookStore, manager: ClaudeHookManagement, binding: InstallationBinding, capability: string, ownerActive: boolean;
  const token = "b".repeat(64), identity = "c".repeat(64);
  beforeEach(() => {
    closeDb(); previousDatabase = process.env.RUNPHANTOM_DB_PATH;
    directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-hooks-windows-unavailable-")));
    for (const relative of ["workspace/.claude", "projects/project", "home"]) mkdirSync(path.join(directory, relative), { recursive: true });
    process.env.RUNPHANTOM_DB_PATH = path.join(directory, "owner.sqlite");
    // SQL component fixture only; it does not establish native lifetime-lease acceptance.
    ownerActive = true; store = new CodingHookStore(getDrizzleDb().$client, {}, () => ownerActive); store.beginOwner();
    manager = new ClaudeHookManagement(store, "http://127.0.0.1:5947");
    const workspace = path.join(directory, "workspace"), settingsPath = path.join(workspace, ".claude", "settings.local.json");
    binding = { installationId: installationIdForSettings("local", settingsPath), scope: "local", captureMode: "full", workspace, registeredWorkspace: workspace, transcriptRoot: path.join(directory, "projects"), projectDirectory: path.join(directory, "projects", "project"), homeDirectory: path.join(directory, "home"), settingsPath, executable: process.execPath };
    capability = path.join(directory, "coding-hooks", "claude", binding.installationId + ".json");
    writeFileSync(settingsPath, '{"unrelated":"preserve exact settings"}\n');
  });
  afterEach(() => {
    closeDb();
    if (previousDatabase === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previousDatabase;
    rmSync(directory, { recursive: true, force: true });
  });
  const tables = ["coding_hook_owner", "coding_hook_installations", "coding_hook_sessions", "coding_hook_entities", "runs", "spans"];
  function snapshot() { return tables.map(table => JSON.stringify(store.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all())); }
  function prepare(value = binding, registrations?: SourceRegistration[]) {
    const receipt = store.prepareInstallation(value, token, "d".repeat(64), registrations);
    store.commitInstallation(value.installationId, receipt.installationGeneration, token, "d".repeat(64), receipt.ownerGeneration);
    return store.admit(token, identity, claimsForRegistration(value));
  }
  async function hookRefusal(work: Promise<unknown>, reason: HookRefusal["reason"], status: number) {
    let failure: unknown; try { await work; } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(HookRefusal); expect((failure as HookRefusal).reason).toBe(reason); expect((failure as HookRefusal).status).toBe(status);
  }
  async function capabilityRefusal(file: string, reason: ClaudeCapabilityRefusal["reason"] = "unavailable", signal?: AbortSignal) {
    let failure: unknown; try { await readClaudeCapabilityDescriptor(file, binding.installationId, undefined, signal); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ClaudeCapabilityRefusal); expect((failure as ClaudeCapabilityRefusal).reason).toBe(reason);
  }
  async function withoutPrivateIO(work: () => Promise<void>) {
    const observers = [spyOn(filePromises, "lstat"), spyOn(filePromises, "realpath"), spyOn(filePromises, "open"), spyOn(filePromises, "mkdir"), spyOn(filePromises, "rename"), spyOn(filePromises, "unlink"), spyOn(filePromises, "access"), spyOn(filePromises, "stat")];
    try { await work(); for (const observer of observers) expect(observer).not.toHaveBeenCalled(); }
    finally { for (const observer of observers) observer.mockRestore(); }
  }
  function writeDescriptor(origin = "http://127.0.0.1:5947") {
    mkdirSync(path.dirname(capability), { recursive: true });
    const value = { version: CAPABILITY_VERSION, installationId: binding.installationId, capabilityFile: capability, ownerKey: capabilityOwnerKey(store.db.filename), state: "active" as const, token, ownerGeneration: "e".repeat(32), installationGeneration: "f".repeat(32), origin };
    writeFileSync(capability, encodeClaudeCapability(value));
  }

  test("valid, hard-linked and junction capability paths refuse without acquiring file metadata or bytes", async () => {
    writeDescriptor(); const before = readFileSync(capability), hardlink = path.join(directory, "hardlinked.json"), junction = path.join(directory, "junction");
    linkSync(capability, hardlink); symlinkSync(path.dirname(capability), junction, "junction");
    const state = snapshot();
    await withoutPrivateIO(async () => {
      for (const file of [capability, hardlink, path.join(junction, path.basename(capability)), path.join(directory, "absent.json")]) await capabilityRefusal(file);
    });
    expect(readFileSync(capability)).toEqual(before); expect(readFileSync(hardlink)).toEqual(before); expect(snapshot()).toEqual(state);
  });

  test("malformed identities and pre-aborted acquisitions retain typed refusals without private IO", async () => {
    const aborted = new AbortController(); aborted.abort();
    await withoutPrivateIO(async () => {
      await capabilityRefusal("relative.json", "unauthorized"); await capabilityRefusal(capability, "aborted", aborted.signal);
      await hookRefusal(manager.install({ ...binding, installationId: "invalid" }, { fullConsent: true }), "malformed", 400);
      await hookRefusal(manager.doctor("invalid"), "malformed", 400); await hookRefusal(manager.uninstall("invalid"), "malformed", 400);
    });
  });

  test("full-consent install cannot write settings, create a private directory or grant SQL authority", async () => {
    const before = snapshot(), settings = readFileSync(binding.settingsPath), entries = readdirSync(directory).sort();
    await withoutPrivateIO(async () => {
      await hookRefusal(manager.install(binding, { fullConsent: true }), "unavailable", 503);
      await hookRefusal(new ClaudeHookManagement(store).install(binding, { fullConsent: true }), "unavailable", 503);
      ownerActive = false; await hookRefusal(manager.install(binding, { fullConsent: true }), "unavailable", 503);
    });
    expect(snapshot()).toEqual(before); expect(readFileSync(binding.settingsPath)).toEqual(settings); expect(readdirSync(directory).sort()).toEqual(entries);
    expect(existsSync(path.join(directory, "coding-hooks"))).toBe(false); expect(store.db.query("SELECT * FROM coding_hook_installations").all()).toEqual([]);
  });

  test("doctor reports inactive unavailable capture without inspecting existing settings or capability bytes", async () => {
    prepare(); writeDescriptor(); const before = snapshot(), settings = readFileSync(binding.settingsPath), bytes = readFileSync(capability);
    await withoutPrivateIO(async () => {
      expect(await manager.doctor(binding.installationId, binding)).toEqual({ configuration: "unavailable", capability: "unavailable", capturePolicy: "inactive", transport: "unavailable", captureVerified: false, captureCoverage: "inactive", registrationCount: 0 });
    });
    expect(snapshot()).toEqual(before); expect(readFileSync(binding.settingsPath)).toEqual(settings); expect(readFileSync(capability)).toEqual(bytes);
  });

  test("trusted current-owner uninstall revokes queued authority while preserving unknown Windows files", async () => {
    const admission = prepare(), pending = normalizeClaudeHook(hookFixture("Stop"), { sourceKey: admission.sourceKey, captureMode: "full" }, null);
    expect(pending.status).toBe("accepted"); if (pending.status !== "accepted") throw new Error("fixture batch");
    writeDescriptor(); const settings = readFileSync(binding.settingsPath), bytes = readFileSync(capability), before = store.readInstallation(binding.installationId)!.row;
    await withoutPrivateIO(async () => {
      expect(await manager.uninstall(binding.installationId, binding)).toEqual({ status: "configuration_preserved", capturePolicy: "disabled", captureVerified: false });
    });
    const revoked = store.readInstallation(binding.installationId)!.row;
    expect(revoked.state).toBe("disabled"); expect(revoked.generation).not.toBe(before.generation); expect(revoked.token_sha256).not.toBe(before.token_sha256);
    expect(() => store.authenticate(token)).toThrow(); expect(() => store.admit(token, identity, claimsForRegistration(admission.binding))).toThrow(); expect(() => store.publish(token, admission, pending.value)).toThrow();
    expect(readFileSync(binding.settingsPath)).toEqual(settings); expect(readFileSync(capability)).toEqual(bytes); expect(readdirSync(path.dirname(capability))).toEqual([path.basename(capability)]);
    expect(store.db.query("SELECT * FROM runs").all()).toEqual([]); expect(store.db.query("SELECT * FROM spans").all()).toEqual([]);
  });

  test("unowned uninstall cannot mutate SQL authority or unknown files", async () => {
    prepare(); writeDescriptor(); const before = snapshot(), bytes = readFileSync(capability), settings = readFileSync(binding.settingsPath); ownerActive = false;
    await withoutPrivateIO(async () => { await hookRefusal(manager.uninstall(binding.installationId), "inactive", 503); });
    expect(snapshot()).toEqual(before); expect(readFileSync(capability)).toEqual(bytes); expect(readFileSync(binding.settingsPath)).toEqual(settings);
  });

  test("removing a real global registration revokes the whole unsupported authority without installing a replacement", async () => {
    const first = registrationForBinding(binding), registeredWorkspace = path.join(directory, "other-workspace"), projectDirectory = path.join(binding.transcriptRoot, "other-project");
    const second = { ...first, registeredWorkspace, projectDirectory, registrationId: sourceRootKey({ registeredWorkspace, projectDirectory, transcriptRoot: binding.transcriptRoot, homeDirectory: binding.homeDirectory }) };
    const settingsPath = path.join(binding.homeDirectory, ".claude", "settings.json"), global = { ...binding, scope: "global" as const, captureMode: "metadata" as const, workspace: null, settingsPath, installationId: installationIdForSettings("global", settingsPath) };
    prepare(global, [first, second]); const before = snapshot();
    await withoutPrivateIO(async () => {
      expect(await manager.unregister(global.installationId, "0".repeat(64))).toEqual({ status: "unchanged", captureVerified: false }); expect(snapshot()).toEqual(before);
      await hookRefusal(manager.unregister(global.installationId, second.registrationId), "unavailable", 503);
    });
    const revoked = store.readInstallation(global.installationId)!;
    expect(revoked.row.state).toBe("disabled"); expect(revoked.registrations).toHaveLength(2); expect(() => store.authenticate(token)).toThrow();
    expect(existsSync(path.join(directory, "coding-hooks"))).toBe(false); expect(existsSync(settingsPath)).toBe(false);
  });

  test("actual Windows source callback remains silent with no capability transport or publication", async () => {
    const before = snapshot(), settings = readFileSync(binding.settingsPath); let requests = 0;
    const listener = createServer((_request, response) => { requests++; response.end(); });
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve)); const address = listener.address(); if (!address || typeof address === "string") throw new Error("fixture listener");
    writeDescriptor(`http://127.0.0.1:${address.port}`); const bytes = readFileSync(capability);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key)));
    const child = spawn(process.execPath, ["--no-env-file", path.resolve(import.meta.dir, "../src/index.ts"), "hooks", "handle", "claude", "--installation-id", binding.installationId, "--capability-file", capability], { cwd: directory, env: { ...inherited, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HOME: binding.homeDirectory, USERPROFILE: binding.homeDirectory, CLAUDE_CONFIG_DIR: path.join(binding.homeDirectory, ".claude"), RUNPHANTOM_SECRET_STORE_PATH: path.join(binding.homeDirectory, "forbidden-secrets.json"), RUNPHANTOM_DB_PATH: store.db.filename, RUNPHANTOM_DAEMON_URL: `http://127.0.0.1:${address.port}` }, stdio: "pipe" });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk)); child.stdin.on("error", () => {});
    child.stdin.end(hookFixture("Stop")); const watchdog = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      expect(code).toBe(0); expect(Buffer.concat(stdout).length).toBe(0); expect(Buffer.concat(stderr).length).toBe(0); expect(requests).toBe(0);
    } finally { clearTimeout(watchdog); child.stdin.destroy(); await new Promise<void>(resolve => listener.close(() => resolve())); }
    expect(snapshot()).toEqual(before); expect(readFileSync(binding.settingsPath)).toEqual(settings); expect(readFileSync(capability)).toEqual(bytes);
  });
});
