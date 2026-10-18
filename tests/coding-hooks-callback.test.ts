import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CALLBACK_LIMITS, readClaudeHookStdin, runClaudeHookCallback } from "../src/coding-hooks/callback";
import { HOOK_LIMITS } from "../src/coding-hooks/shared";
import { hookFixture } from "./fixtures/coding-hooks-claude";

const checkout = path.resolve(import.meta.dir, ".."), installationId = "d".repeat(32);
let directory: string, profile: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "runphantom-f11-callback-")); profile = path.join(directory, "profile"); mkdirSync(profile); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function native(payload: string | Uint8Array | null, extra: string[] = [], executable?: string, env: NodeJS.ProcessEnv = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key)));
  const args = ["hooks", "handle", "claude", "--installation-id", installationId, "--capability-file", path.join(profile, "private capability ' $ ` .json"), ...extra];
  const started = performance.now();
  const child = spawn(executable ?? process.execPath, executable ? args : ["--no-env-file", path.join(checkout, "src/index.ts"), ...args], {
    cwd: directory, env: { ...inherited, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", DO_NOT_TRACK: "1", HOME: profile, USERPROFILE: profile, CLAUDE_CONFIG_DIR: path.join(profile, ".claude"), RUNPHANTOM_DB_PATH: path.join(profile, "forbidden.sqlite"), RUNPHANTOM_SECRET_STORE_PATH: path.join(profile, "forbidden-secrets.json"), ...env }, stdio: "pipe",
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
  child.stdin.on("error", () => { /* Oversized input may close before the writer finishes. */ });
  if (payload !== null) child.stdin.end(payload); else child.stdin.write('{"session_id":');
  const watchdog = setTimeout(() => child.kill("SIGKILL"), CALLBACK_LIMITS.lifetimeMs + 1500);
  try {
    const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), wallMs: performance.now() - started };
  } finally { clearTimeout(watchdog); child.stdin.destroy(); }
}
function noAuthoritySideEffects() {
  expect(readdirSync(profile)).toEqual([]);
  expect(existsSync(path.join(profile, "forbidden.sqlite"))).toBe(false);
  expect(existsSync(path.join(directory, "$(touch SHOULD_NOT_EXIST)"))).toBe(false);
}

describe("finite callback stdin", () => {
  test("actual bytes through EOF preserve business Unicode at the exact byte cap", async () => {
    const input = new PassThrough(), reading = readClaudeHookStdin(input, new AbortController().signal);
    input.end(Buffer.alloc(HOOK_LIMITS.stdinBytes, 32));
    const result = await reading; expect(result.status).toBe("accepted");
    if (result.status === "accepted") expect(Buffer.byteLength(result.text)).toBe(HOOK_LIMITS.stdinBytes);
  });
  test("an oversized chunk is refused before it is retained", async () => {
    const input = new PassThrough(), reading = readClaudeHookStdin(input, new AbortController().signal);
    input.end(Buffer.alloc(HOOK_LIMITS.stdinBytes + 1)); expect(await reading).toEqual({ status: "unavailable", reason: "stdin_limit" });
    expect(input.listenerCount("data")).toBe(0); expect(input.isPaused()).toBe(true);
  });
  test("invalid UTF8, stalled EOF and cancellation cannot produce a complete hook", async () => {
    const invalid = new PassThrough(), reading = readClaudeHookStdin(invalid, new AbortController().signal); invalid.end(Buffer.from([0xc3, 0x28]));
    expect(await reading).toEqual({ status: "unavailable", reason: "invalid_utf8" });
    const stalled = new PassThrough(), started = performance.now();
    expect(await readClaudeHookStdin(stalled, new AbortController().signal)).toEqual({ status: "unavailable", reason: "stdin_deadline" });
    expect(performance.now() - started).toBeLessThan(1000); expect(stalled.listenerCount("data")).toBe(0); stalled.destroy();
    const input = new PassThrough(), controller = new AbortController(), cancelled = readClaudeHookStdin(input, controller.signal); controller.abort();
    expect(await cancelled).toEqual({ status: "unavailable", reason: "aborted" }); input.destroy();
  });
  test("extra or malformed argv is refused before starting stdin acquisition", async () => {
    const input = new PassThrough();
    expect(await runClaudeHookCallback(["--installation-id", installationId, "--capture", "full"], input)).toBe(0);
    expect(await runClaudeHookCallback(["--installation-id", "invalid"], input)).toBe(0);
    expect(input.listenerCount("data")).toBe(0); input.destroy();
  });
});

describe("actual silent CLI callback without authority activation", () => {
  test.each([
    hookFixture("Stop"), "{broken", '{"session_id":"a","hook_event_name":"Stop","session_id":"b"}',
    '{"session_id":"a","hook_event_name":"Stop","\\u0073ession_id":"b"}',
    hookFixture("FutureEvent"), '{"session_id":"a","hook_event_name":"Stop","duration_ms":1e400}',
    '{"session_id":"a","hook_event_name":"Stop","extra":' + "[".repeat(17) + "0" + "]".repeat(17) + "}",
  ].map(payload => [payload]))("finite payload %# exits zero with empty stdout/stderr and no local authority", async payload => {
    const result = await native(payload); expect(result.status).toBe(0); expect(result.stdout.length).toBe(0); expect(result.stderr.length).toBe(0);
    expect(result.wallMs).toBeLessThan(CALLBACK_LIMITS.lifetimeMs); noAuthoritySideEffects();
  });
  test("oversized, invalid UTF8 and actual stalled pipe preserve host exit and lifetime", async () => {
    for (const payload of [Buffer.alloc(HOOK_LIMITS.stdinBytes + 1), Buffer.from([0xc3, 0x28]), null]) {
      const result = await native(payload); expect(result.status).toBe(0); expect(result.stdout.length).toBe(0); expect(result.stderr.length).toBe(0);
      expect(result.wallMs).toBeLessThan(CALLBACK_LIMITS.lifetimeMs); noAuthoritySideEffects();
    }
  });
  test("forged policy, owner/database and remote URL never start publication or a daemon", async () => {
    let requests = 0;
    const trap = createServer((_request, response) => { requests++; response.writeHead(500); response.end("private trap"); });
    await new Promise<void>(resolve => trap.listen(0, "127.0.0.1", resolve));
    const address = trap.address(); if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
    try {
      const result = await native(hookFixture("Stop", { captureMode: "full", database: "/private/other.sqlite", runtimeVerified: true, ownerGeneration: "forged", endpoint: "http://127.0.0.1:" + address.port }), [], undefined, { RUNPHANTOM_URL: "http://127.0.0.1:" + address.port, RUNPHANTOM_PORT: String(address.port) });
      expect(result.status).toBe(0); expect(result.stdout.length).toBe(0); expect(result.stderr.length).toBe(0); expect(requests).toBe(0); noAuthoritySideEffects();
    } finally { await new Promise<void>((resolve, reject) => trap.close(error => error ? reject(error) : resolve())); }
  });
  // This fixture launches the POSIX development wrapper through a symlink with a quoted filename.
  test.skipIf(process.platform === "win32")("direct executable vectors survive spaces, quotes, dollars and backticks without shell interpretation", async () => {
    const executable = path.join(directory, "run phantom ' \" $dollar `backtick`"); symlinkSync(path.join(checkout, "bin/runphantom-dev"), executable);
    const result = await native(hookFixture("Stop"), [], executable);
    expect(result.status).toBe(0); expect(result.stdout.length).toBe(0); expect(result.stderr.length).toBe(0); expect(result.wallMs).toBeLessThan(CALLBACK_LIMITS.lifetimeMs); noAuthoritySideEffects();
  });
  test("extra callback arguments remain silent and do not wait on a stalled pipe", async () => {
    const result = await native(null, ["--capture", "full", "--database", "/private/forged.sqlite"]);
    expect(result.status).toBe(0); expect(result.stdout.length).toBe(0); expect(result.stderr.length).toBe(0); expect(result.wallMs).toBeLessThan(CALLBACK_LIMITS.stdinEOFMs); noAuthoritySideEffects();
  });
});
