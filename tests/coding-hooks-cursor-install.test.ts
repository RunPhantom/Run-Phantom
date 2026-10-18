import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cursorCommand, inspectCursorSettings, mergeCursorSettings } from "../src/coding-hooks/cursor-install";
import { updateClaudeSettings } from "../src/coding-hooks/install";
import { CURSOR_HOOK_EVENTS } from "../src/coding-hooks/cursor";
const authority = { installationId: "b".repeat(32), executable: "/private/Run Phantom ' $fixture`/runphantom", capabilityFile: "/private/custom profile/coding-hooks/cursor/" + "b".repeat(32) + ".json" };
const ordinary = { command: "ordinary-existing-command", matcher: "Read", future: { preserve: true } };
const original = { version: 1, future: { enabled: true }, hooks: { afterAgentResponse: [ordinary], futureEvent: [{ command: "future-command", timeout: 100 }] } };
function install(raw: string | null) { const result = mergeCursorSettings(raw, "install", authority); if (result.status !== "accepted" || result.text === null) throw new Error("install unavailable"); return result; }
describe.skipIf(process.platform === "win32")("exact-owned POSIX Cursor hook configuration", () => {
  test("installs observation-only events twice and removes only owned entries", () => {
    const first = install(JSON.stringify(original));
    expect(first.changed).toBe(true); expect(first.ownedHandlers).toBe(CURSOR_HOOK_EVENTS.length);
    const second = install(first.text); expect(second.changed).toBe(false); expect(second.text).toBe(first.text);
    const settings = JSON.parse(first.text!);
    for (const event of CURSOR_HOOK_EVENTS) expect(settings.hooks[event].at(-1)).toEqual({ command: cursorCommand(authority), timeout: 3, failClosed: false });
    expect(settings.hooks.preToolUse).toBeUndefined(); expect(settings.hooks.beforeMCPExecution).toBeUndefined(); expect(settings.future).toEqual(original.future); expect(settings.hooks.afterAgentResponse[0]).toEqual(ordinary);
    const removed = mergeCursorSettings(first.text, "uninstall", authority);
    expect(removed.status).toBe("accepted"); if (removed.status === "accepted") { expect(JSON.parse(removed.text!)).toEqual(original); expect(mergeCursorSettings(removed.text, "uninstall", authority)).toEqual({ status: "accepted", text: removed.text, changed: false, ownedHandlers: 0 }); }
  });
  test("shell words quote spaces, quotes and expansion syntax independently", () => {
    expect(cursorCommand(authority)).toStartWith("'/private/Run Phantom '\\'' $fixture`/runphantom'");
    expect(cursorCommand(authority)).not.toContain("--full"); expect(cursorCommand(authority)).not.toContain("Bearer");
  });
  test("handler quota counts newly installed events as well as unrelated handlers", () => {
    const settings = (count: number) => JSON.stringify({ version: 1, hooks: { futureEvent: Array.from({ length: count }, () => ({ command: "ordinary" })) } });
    expect(mergeCursorSettings(settings(256 - CURSOR_HOOK_EVENTS.length), "install", authority).status).toBe("accepted");
    expect(mergeCursorSettings(settings(257 - CURSOR_HOOK_EVENTS.length), "install", authority)).toEqual({ status: "unavailable", reason: "handler_limit" });
  });
  test("an edited owned handler is preserved rather than overwritten", () => {
    const first = install(null), value = JSON.parse(first.text!); value.hooks.stop[0].failClosed = true;
    const raw = JSON.stringify(value); expect(mergeCursorSettings(raw, "install", authority)).toEqual({ status: "unavailable", reason: "ownership_uncertain" });
    expect(mergeCursorSettings(raw, "uninstall", authority)).toEqual({ status: "unavailable", reason: "ownership_uncertain" });
  });
  test("duplicate owned handlers are refused and unrelated empty arrays survive", () => {
    const first = install(JSON.stringify({ version: 1, hooks: { futureEvent: [] } })), value = JSON.parse(first.text!);
    expect(value.hooks.futureEvent).toEqual([]); value.hooks.stop.push(value.hooks.stop[0]); expect(mergeCursorSettings(JSON.stringify(value), "install", authority).status).toBe("unavailable");
  });
  for (const raw of ['{"version":1,"version":1}', '{"hooks":', '{"version":2}', '{"hooks":{"stop":{}}}', '{"hooks":{"stop":[null]}}', '{"__proto__":{}}', '[]']) test(`leaves malformed settings unavailable: ${raw}`, () => {
    expect(mergeCursorSettings(raw, "install", authority).status).toBe("unavailable"); expect(mergeCursorSettings(raw, "uninstall", authority).status).toBe("unavailable");
  });
  test("actual bounded writer and doctor preserve malformed bytes and do not launch the executable", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "f13-settings spaced-"))), file = path.join(directory, "hooks.json");
    try {
      const raw = '{"version":1,"hooks":'; await writeFile(file, raw);
      expect((await updateClaudeSettings(file, "install", authority, mergeCursorSettings)).status).toBe("unavailable"); expect(await readFile(file, "utf8")).toBe(raw);
      await writeFile(file, JSON.stringify(original)); expect((await updateClaudeSettings(file, "install", authority, mergeCursorSettings)).status).toBe("accepted");
      const doctor = await inspectCursorSettings(file, authority); expect(doctor.configuration).toBe("installed"); expect(doctor.installedVendorVersion).toBeNull(); expect(doctor.captureVerified).toBe(false);
      const text = await readFile(file, "utf8"); expect((await updateClaudeSettings(file, "install", authority, mergeCursorSettings)).changed).toBe(false); expect(await readFile(file, "utf8")).toBe(text);
      expect((await updateClaudeSettings(file, "uninstall", authority, mergeCursorSettings)).status).toBe("accepted"); expect(JSON.parse(await readFile(file, "utf8"))).toEqual(original);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test("actual writer rejects symlink settings without changing the target", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "f13-symlink-"))), target = path.join(directory, "unrelated.json"), file = path.join(directory, "config/hooks.json");
    try { await mkdir(path.dirname(file)); await writeFile(target, "{}"); await symlink(target, file); expect((await updateClaudeSettings(file, "install", authority, mergeCursorSettings)).status).toBe("unavailable"); expect(await readFile(target, "utf8")).toBe("{}"); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
});

if (process.platform === "win32") test("native Windows install refuses unsupported private ownership without writing config", () => {
  expect(mergeCursorSettings(null, "install", { installationId: "b".repeat(32), executable: path.resolve("runphantom.exe"), capabilityFile: path.resolve("private/capability.json") })).toEqual({ status: "unavailable", reason: "invalid_authority" });
});
