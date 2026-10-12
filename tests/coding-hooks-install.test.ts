import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLAUDE_HOOK_EVENTS } from "../src/coding-hooks/shared";
import { inspectClaudeHookSettings, mergeClaudeSettings, updateClaudeSettings, SETTINGS_LIMITS } from "../src/coding-hooks/install";

const authority = { executable: '/private/Run Phantom $fixture` /runphantom "copy"', installationId: "a".repeat(32) };
const original = { permissions: { allow: ["Read"], custom: { enabled: true } }, future: ["preserved", { value: 2 }], hooks: {
  PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ordinary existing command", timeout: 20 }] }],
  FutureEvent: [{ matcher: "future", hooks: [{ type: "http", url: "https://fixture.invalid/hook" }] }],
} };
const merged = (value: unknown, operation: "install" | "uninstall" = "install") => mergeClaudeSettings(JSON.stringify(value), operation, authority);

describe("exact owned Claude hook configuration", () => {
  test("direct exec arguments preserve special path characters, with no shell or capture-policy argument", () => {
    const result = merged(original);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    const settings = JSON.parse(result.text);
    for (const event of CLAUDE_HOOK_EVENTS) {
      const group = settings.hooks[event].at(-1);
      expect(group).toEqual({ matcher: "*", hooks: [{ type: "command", command: authority.executable, args: ["hooks", "handle", "claude", "--installation-id", authority.installationId], timeout: 3, onFailure: "continue" }] });
    }
    expect(settings.permissions).toEqual(original.permissions);
    expect(settings.future).toEqual(original.future);
    expect(settings.hooks.FutureEvent).toEqual(original.hooks.FutureEvent);
    expect(settings.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(result.ownedHandlers).toBe(10);
    expect(result.changed).toBe(true);
  });

  test("repeat installation is byte-identical, and uninstall preserves unrelated configuration", () => {
    const first = merged(original);
    expect(first.status).toBe("accepted");
    if (first.status !== "accepted") return;
    const second = mergeClaudeSettings(first.text, "install", authority);
    expect(second).toEqual({ ...first, changed: false });
    const removed = mergeClaudeSettings(first.text, "uninstall", authority);
    expect(removed.status).toBe("accepted");
    if (removed.status !== "accepted") return;
    expect(JSON.parse(removed.text)).toEqual(original);
    expect(removed.ownedHandlers).toBe(0);
    expect(mergeClaudeSettings(removed.text, "uninstall", authority)).toEqual({ ...removed, changed: false });
  });

  test("a second installation's exact handlers remain outside this authority", () => {
    const first = merged(original);
    if (first.status !== "accepted") throw new Error("fixture not admitted");
    const other = { ...authority, installationId: "b".repeat(32) };
    const second = mergeClaudeSettings(first.text, "install", other);
    if (second.status !== "accepted") throw new Error("fixture not admitted");
    const removed = mergeClaudeSettings(second.text, "uninstall", authority);
    expect(removed.status).toBe("accepted");
    if (removed.status !== "accepted") return;
    expect(mergeClaudeSettings(removed.text, "install", other).changed).toBe(false);
    expect(removed.text).toContain(other.installationId);
    expect(removed.text).not.toContain(authority.installationId);
  });

  test("additional unrelated handlers in an unchanged owned matcher group survive removal", () => {
    const first = merged({});
    if (first.status !== "accepted") throw new Error("fixture not admitted");
    const settings = JSON.parse(first.text);
    const ordinary = { type: "command", command: "ordinary after capture" };
    settings.hooks.Stop[0].hooks.push(ordinary);
    const removed = merged(settings, "uninstall");
    expect(removed.status).toBe("accepted");
    if (removed.status === "accepted") expect(JSON.parse(removed.text)).toEqual({ hooks: { Stop: [{ matcher: "*", hooks: [ordinary] }] } });
  });

  test("empty unrelated matcher groups and their metadata survive removal", () => {
    const empty = { matcher: "unrelated", hooks: [], future: { intentionallyEmpty: true } };
    const fixture = { hooks: { Stop: [empty] } };
    const first = merged(fixture);
    if (first.status !== "accepted") throw new Error("fixture not admitted");
    const removed = mergeClaudeSettings(first.text, "uninstall", authority);
    expect(removed.status).toBe("accepted");
    if (removed.status === "accepted") expect(JSON.parse(removed.text)).toEqual(fixture);
  });

  test.each(["timeout", "matcher", "group_metadata", "args", "handler_metadata"])("edited %s ownership refuses without silently removing or duplicating entries", edit => {
    const first = merged({});
    if (first.status !== "accepted") throw new Error("fixture not admitted");
    const settings = JSON.parse(first.text), group = settings.hooks.Stop[0];
    if (edit === "timeout") group.hooks[0].timeout = 50;
    if (edit === "matcher") group.matcher = "edited";
    if (edit === "group_metadata") group.future = "edited";
    if (edit === "args") group.hooks[0].args.push("--edited");
    if (edit === "handler_metadata") group.hooks[0].future = "edited";
    for (const operation of ["install", "uninstall"] as const) expect(merged(settings, operation)).toEqual({ status: "unavailable", reason: "ownership_uncertain" });
  });

  test("same executable with a different callback does not imply ownership", () => {
    const fixture = { hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: authority.executable, args: ["ordinary", "callback"] }] }] } };
    const removed = merged(fixture, "uninstall");
    expect(removed.status).toBe("accepted");
    if (removed.status === "accepted") { expect(removed.changed).toBe(false); expect(JSON.parse(removed.text)).toEqual(fixture); }
  });

  test("missing settings can be created, while missing-settings removal writes nothing", () => {
    expect(mergeClaudeSettings(null, "install", authority).status).toBe("accepted");
    expect(mergeClaudeSettings(null, "uninstall", authority)).toEqual({ status: "accepted", text: null, changed: false, ownedHandlers: 0 });
  });
});

describe("bounded settings admission", () => {
  test.each([
    '{"hooks":{},"hooks":{}}',
    '{"future":{"password":"private","passw\\u006frd":"safe"}}',
    '{"__proto__":{}}',
    '{"value":9007199254740993}',
    '{"value":1e400}',
    '[{"hooks":{}}]',
    '{"hooks":{"Stop":{}}}',
    '{"hooks":{"Stop":[{"hooks":"malformed"}]}}',
  ])("ambiguous or malformed settings cannot become a writable configuration", text => {
    expect(mergeClaudeSettings(text, "install", authority).status).toBe("unavailable");
  });

  test("byte, lexical depth and cumulative node caps apply before merge", () => {
    expect(mergeClaudeSettings(" ".repeat(SETTINGS_LIMITS.bytes + 1), "install", authority).reason).toBe("byte_limit");
    expect(mergeClaudeSettings(JSON.stringify({ value: "🧪".repeat(SETTINGS_LIMITS.bytes / 4) }), "install", authority).reason).toBe("byte_limit");
    expect(merged({ deep: JSON.parse("[".repeat(SETTINGS_LIMITS.depth) + "null" + "]".repeat(SETTINGS_LIMITS.depth)) }).reason).toBe("depth_limit");
    expect(merged({ first: Array(11000).fill(null), second: Array(11000).fill(null) }).reason).toBe("node_limit");
  });

  test("total handlers include unrelated events and new handlers, with an exact positive boundary", () => {
    const fixture = (count: number) => ({ hooks: { FutureEvent: [{ hooks: Array(count).fill({ type: "command", command: "ordinary" }) }] } });
    expect(merged(fixture(SETTINGS_LIMITS.handlers - 10)).status).toBe("accepted");
    expect(merged(fixture(SETTINGS_LIMITS.handlers - 9)).reason).toBe("handler_limit");
    expect(merged(fixture(SETTINGS_LIMITS.handlers + 1), "uninstall").reason).toBe("handler_limit");
  });

  test("hostile inputs are never coerced and operational authority is finite", () => {
    let calls = 0;
    expect(mergeClaudeSettings({ toString() { calls++; return "{}"; } }, "install", authority).status).toBe("unavailable");
    expect(calls).toBe(0);
    expect(mergeClaudeSettings("{}", "install", { ...authority, executable: "relative" }).reason).toBe("invalid_authority");
    expect(mergeClaudeSettings("{}", "install", { ...authority, installationId: "../other" }).reason).toBe("invalid_authority");
    const accessor = { get executable() { calls++; return authority.executable; }, installationId: authority.installationId };
    expect(mergeClaudeSettings("{}", "install", accessor).reason).toBe("invalid_authority");
    expect(calls).toBe(0);
  });
});

describe("actual settings filesystem behavior", () => {
  test("doctor separates exact installed configuration from inactive consent and transport", async () => fixture(async (directory, file) => {
    const binary = path.join(directory, "run phantom"); await writeFile(binary, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    const owned = { ...authority, executable: binary };
    expect((await updateClaudeSettings(file, "install", owned)).status).toBe("accepted");
    const before = await readFile(file, "utf8"), result = await inspectClaudeHookSettings(file, owned);
    expect(result).toEqual({ configuration: "installed", ownedHandlers: 10, executable: "available", installedVendorVersion: null, capturePolicy: "inactive", transport: "unavailable", captureVerified: false });
    expect(await readFile(file, "utf8")).toBe(before);
    const settings = JSON.parse(before); delete settings.hooks.Stop; await writeFile(file, JSON.stringify(settings));
    expect((await inspectClaudeHookSettings(file, owned)).configuration).toBe("partial");
    settings.hooks.SessionStart[0].hooks[0].timeout = 4; const edited = JSON.stringify(settings); await writeFile(file, edited);
    expect((await inspectClaudeHookSettings(file, owned)).reason).toBe("ownership_uncertain"); expect(await readFile(file, "utf8")).toBe(edited);
  }));

  test("doctor missing, malformed and symlink settings do not create or repair configuration", async () => fixture(async (_directory, file) => {
    const missing = await inspectClaudeHookSettings(file, authority);
    expect(missing.configuration).toBe("missing"); expect(missing.executable).toBe("unavailable");
    expect(await Bun.file(path.dirname(file)).exists()).toBe(false);
    await mkdir(path.dirname(file)); const malformed = '{"hooks":{},"hooks":{}}'; await writeFile(file, malformed);
    expect((await inspectClaudeHookSettings(file, authority)).reason).toBe("duplicate_keys"); expect(await readFile(file, "utf8")).toBe(malformed);
    const target = file + ".original"; await writeFile(target, "{}"); await rm(file); await symlink(target, file);
    expect((await inspectClaudeHookSettings(file, authority)).reason).toBe("path_not_authorized"); expect(await readFile(target, "utf8")).toBe("{}");
  }));

  async function fixture(run: (directory: string, file: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "runphantom-hook-settings-"));
    try { await run(directory, path.join(directory, ".claude", "settings.local.json")); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }

  test("actual install twice and uninstall preserve original data and private file mode", async () => fixture(async (_directory, file) => {
    await mkdir(path.dirname(file)); await writeFile(file, JSON.stringify(original), { mode: 0o600 });
    expect((await updateClaudeSettings(file, "install", authority)).status).toBe("accepted");
    const first = await readFile(file, "utf8");
    expect((await updateClaudeSettings(file, "install", authority)).changed).toBe(false);
    expect(await readFile(file, "utf8")).toBe(first);
    expect((await updateClaudeSettings(file, "uninstall", authority)).status).toBe("accepted");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(original);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(path.join(path.dirname(file), ".runphantom-hooks.lock")).exists()).toBe(false);
  }));

  test("malformed raw bytes and uncertain edited ownership remain exact", async () => fixture(async (_directory, file) => {
    await mkdir(path.dirname(file));
    for (const text of ['{"hooks":{},"hooks":{}}', '{"hooks":']) {
      await writeFile(file, text);
      expect((await updateClaudeSettings(file, "install", authority)).status).toBe("unavailable");
      expect(await readFile(file, "utf8")).toBe(text);
    }
    const first = merged({}); if (first.status !== "accepted") throw new Error("fixture not admitted");
    const changed = JSON.parse(first.text); changed.hooks.Stop[0].hooks[0].timeout = 50;
    const edited = JSON.stringify(changed); await writeFile(file, edited);
    expect((await updateClaudeSettings(file, "uninstall", authority)).reason).toBe("ownership_uncertain");
    expect(await readFile(file, "utf8")).toBe(edited);
  }));

  test("actual byte cap, special-file and symlink refusal preserve unrelated targets", async () => fixture(async (directory, file) => {
    await mkdir(path.dirname(file));
    await writeFile(file, " ".repeat(SETTINGS_LIMITS.bytes + 1));
    expect((await updateClaudeSettings(file, "install", authority)).reason).toBe("byte_limit");
    expect((await stat(file)).size).toBe(SETTINGS_LIMITS.bytes + 1);
    await rm(file); await mkdir(file);
    expect((await updateClaudeSettings(file, "install", authority)).reason).toBe("not_regular_file");
    await rm(file, { recursive: true });
    const target = path.join(directory, "unrelated.json"); await writeFile(target, '{"ordinary":"untouched"}');
    await symlink(target, file);
    expect((await updateClaudeSettings(file, "install", authority)).reason).toBe("path_not_authorized");
    expect(await readFile(target, "utf8")).toBe('{"ordinary":"untouched"}');
  }));

  test("lock contention refuses rather than waiting or overwriting settings", async () => fixture(async (_directory, file) => {
    await mkdir(path.dirname(file)); const text = JSON.stringify(original); await writeFile(file, text);
    const lock = path.join(path.dirname(file), ".runphantom-hooks.lock"); await writeFile(lock, "owned fixture lock");
    expect((await updateClaudeSettings(file, "install", authority)).reason).toBe("locked");
    expect(await readFile(file, "utf8")).toBe(text);
    expect(await readFile(lock, "utf8")).toBe("owned fixture lock");
  }));

  test("missing removal creates no parent, while new settings use the same trusted target", async () => fixture(async (_directory, file) => {
    expect(await updateClaudeSettings(file, "uninstall", authority)).toEqual({ status: "accepted", text: null, changed: false, ownedHandlers: 0 });
    expect(await Bun.file(path.join(path.dirname(file), ".runphantom-hooks.lock")).exists()).toBe(false);
    expect((await updateClaudeSettings(file, "install", authority)).status).toBe("accepted");
    const text = await readFile(file, "utf8"); expect(JSON.parse(text).hooks.Stop).toHaveLength(1);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  }));
});
