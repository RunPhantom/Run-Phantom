import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { observeOwnedChild, ownedClock, type OwnedChild, type OwnedClock } from "./helpers/owned-child";
import { startTeamFixture, type TeamFixtureOperations, type TeamFixtureReceiptSink } from "./helpers/team-server";

class Clock implements OwnedClock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; run: () => void }>();
  waits: number[] = [];
  errors: unknown[] = [];
  now = () => this.time;
  setTimeout = (run: () => void, ms: number) => { const id = ++this.next; this.timers.set(id, { at: this.time + ms, run }); return id; };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  sleep = async (ms: number) => { this.waits.push(ms); this.advance(ms); };
  advance(ms: number) {
    const end = this.time + ms;
    while (true) {
      const pending = [...this.timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending) break;
      this.time = pending[1].at; this.timers.delete(pending[0]);
      try { pending[1].run(); } catch (error) { this.errors.push(error); }
    }
    this.time = end;
  }
}
class Child extends EventEmitter implements OwnedChild {
  pid: number | undefined = 123;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM") { this.signals.push(signal); this.exit(null, signal); return true; }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.exitCode = code; this.signalCode = signal; this.emit("exit", code, signal); this.emit("close", code, signal);
  }
}
function fixture() {
  const child = new Child(); const clock = new Clock();
  const calls = { directories: [] as string[], remove: [] as string[], release: 0, spawn: [] as { command: string; args: string[]; options: any }[], probes: [] as { url: string; signal: AbortSignal }[] };
  const profile = `PRIVATE_OWNED_PROFILE_${crypto.randomUUID()}`;
  const operations: TeamFixtureOperations = {
    clock,
    makeDirectory: prefix => { calls.directories.push(prefix); return profile; },
    removeDirectory: value => { calls.remove.push(value); },
    reservePort: async () => ({ port: 12345, release: async () => { calls.release++; } }),
    spawn: (command, args, options) => { calls.spawn.push({ command, args, options }); return child; },
    probe: async (url, options) => { calls.probes.push({ url, signal: options.signal }); return { status: 200 }; },
  };
  const publications: string[] = [];
  const publish: TeamFixtureReceiptSink = value => { publications.push(value); };
  return { child, clock, calls, profile, operations, publications, publish };
}
function throwAdversarial(value: unknown): never {
  throw value;
}
async function failure(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return error as any; }
  throw new Error("Expected failure; unexpected resolution must fail the control");
}
async function outcome(promise: Promise<any>) {
  try { return { value: await promise, error: undefined as any }; } catch (error) { return { value: undefined as any, error: error as any }; }
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function exposed(error: any) { return JSON.stringify({ name: error?.name, message: error?.message, stack: error?.stack, cause: error?.cause, code: error?.code, diagnostic: error?.diagnostic }); }
function begin(f: ReturnType<typeof fixture>, sink: TeamFixtureReceiptSink = f.publish, binary?: string) { return startTeamFixture("lifecycle", binary, f.operations, sink); }

for (const binary of [undefined, "PRIVATE_BINARY_PATH"] as const) {
  test(`Team ${binary ? "binary" : "source"} launch metadata and actual session200 contract stay intact`, async () => {
    const f = fixture(); const handle = await begin(f, f.publish, binary);
    try {
      expect(f.calls.spawn).toHaveLength(1); const launch = f.calls.spawn[0];
      expect(launch.command).toBe(binary ?? (process.versions.bun ? process.execPath : "bun"));
      expect(launch.args).toEqual(binary ? ["team", "serve"] : [path.resolve(import.meta.dir, "../src/index.ts"), "team", "serve"]);
      expect(launch.options.cwd).toBe(f.profile); expect(launch.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
      expect(launch.options.env).toMatchObject({ HOME: f.profile, USERPROFILE: f.profile, RUNPHANTOM_TEAM_DATA_DIR: path.join(f.profile, "team"), RUNPHANTOM_TEAM_PORT: "12345", RUNPHANTOM_TEAM_BIND_HOST: "127.0.0.1", RUNPHANTOM_TEAM_PUBLIC_ORIGIN: handle.url, RUNPHANTOM_TEAM_BOOTSTRAP_CODE: handle.setupCode });
      expect(handle.profile).toBe(f.profile); expect(handle.dataDir).toBe(path.join(f.profile, "team")); expect(handle.setupCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(f.calls.probes).toHaveLength(1); expect(f.calls.probes[0].url).toBe(`${handle.url}/api/team/session`);
      expect(f.calls.probes[0].signal).toBeInstanceOf(AbortSignal); expect(f.calls.probes[0].signal.aborted).toBe(false);
      expect(f.clock.waits).toEqual([]); expect(f.publications).toEqual([]);
    } finally { await handle.close(); }
  });
}

for (const stage of ["directory", "reservation", "release", "spawn"] as const) {
  test(`Team ${stage} acquisition failure removes only safely owned state and stays private`, async () => {
    const f = fixture(); const canary = `PRIVATE_${stage}_${crypto.randomUUID()}`;
    const fail = () => { throw Object.assign(new Error(canary), { code: "EACCES", cause: new Error(canary) }); };
    if (stage === "directory") f.operations.makeDirectory = fail;
    if (stage === "reservation") f.operations.reservePort = async () => fail();
    if (stage === "release") f.operations.reservePort = async () => ({ port: 12345, release: async () => { f.calls.release++; fail(); } });
    if (stage === "spawn") f.operations.spawn = fail;
    const error = await failure(begin(f));
    expect(f.calls.remove).toEqual(stage === "reservation" || stage === "spawn" ? [f.profile] : []);
    expect(f.child.signals).toEqual([]); expect(f.calls.probes).toEqual([]);
    expect(exposed(error) + f.publications.join("")).not.toContain(canary);
    expect(error.code).toBe(stage === "directory" ? "SETUP_FAILED" : stage === "spawn" ? "SPAWN_FAILED" : "RESERVATION_FAILED");
    expect(f.publications).toHaveLength(1);
    if (stage === "release") expect(error.diagnostic?.secondaryCleanupFailure).toBe("CLEANUP_FAILED");
  });
}

for (const terminal of ["numeric", "signal"] as const) {
  test(`Team already ${terminal}-terminated child never receives a readiness request or another signal`, async () => {
    const f = fixture();
    if (terminal === "numeric") f.child.exitCode = 17; else f.child.signalCode = "SIGABRT";
    const result = await outcome(begin(f));
    try {
      expect(f.calls.probes).toEqual([]); expect(result.value).toBeUndefined();
      expect(result.error?.code).toBe("EXITED_BEFORE_READY"); expect(f.child.signals).toEqual([]); expect(f.calls.remove).toEqual([f.profile]);
    } finally { if (result.value) await result.value.close(); }
  });
}

test("Team terminal fields changed during listener installation are rechecked before any probe", async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Intentionally capture the original method; invocation restores its receiver with on.call(this, event, listener).
  const f = fixture(); const on = f.child.on;
  f.child.on = function (event, listener) { const value = on.call(this, event, listener); if (event === "error") this.exit(null, "SIGTERM"); return value; };
  const result = await outcome(begin(f));
  try {
    expect(f.calls.probes).toEqual([]); expect(result.value).toBeUndefined(); expect(result.error?.code).toBe("EXITED_BEFORE_READY");
    expect(f.calls.remove).toEqual([f.profile]); expect(f.child.signals).toEqual([]);
  } finally { if (result.value) await result.value.close(); }
});

for (const terminal of ["numeric", "signal"] as const) {
  test(`Team ${terminal} exit during a200 probe cannot return a dead fixture`, async () => {
    const f = fixture();
    f.operations.probe = async (url, options) => { f.calls.probes.push({ url, signal: options.signal }); f.child.exit(terminal === "numeric" ? 9 : null, terminal === "signal" ? "SIGKILL" : null); return { status: 200 }; };
    const result = await outcome(begin(f));
    try {
      expect(result.value).toBeUndefined(); expect(result.error?.code).toBe("EXITED_BEFORE_READY");
      expect(f.calls.probes).toHaveLength(1); expect(f.child.signals).toEqual([]); expect(f.calls.remove).toEqual([f.profile]);
    } finally { if (result.value) await result.value.close(); }
  });
}

for (const terminal of ["numeric", "signal"] as const) {
  for (const boundary of ["probe", "last-wait"] as const) {
    test(`Team ${terminal} termination on final ${boundary} is classified before exhaustion`, async () => {
      const f = fixture();
      f.operations.probe = async (url, options) => {
        f.calls.probes.push({ url, signal: options.signal });
        if (boundary === "probe" && f.calls.probes.length === 400) f.child.exit(terminal === "numeric" ? 7 : null, terminal === "signal" ? "SIGTERM" : null);
        return { status: 503 };
      };
      if (boundary === "last-wait") f.clock.sleep = async ms => { f.clock.waits.push(ms); f.clock.advance(ms); if (f.calls.probes.length === 400) f.child.exit(terminal === "numeric" ? 7 : null, terminal === "signal" ? "SIGTERM" : null); };
      const error = await failure(begin(f));
      expect(error.code).toBe("EXITED_BEFORE_READY"); expect(f.calls.probes).toHaveLength(400); expect(f.child.signals).toEqual([]);
      expect(f.clock.waits).toEqual(Array(boundary === "probe" ? 399 : 400).fill(25));
    });
  }
}

test("Team failed creation is distinct from a live-child error and never sends an absent-child signal", async () => {
  const f = fixture(); f.child.pid = undefined;
  f.operations.probe = async () => { f.child.emit("error", { code: "ENOENT", message: "PRIVATE_SPAWN" }); throwAdversarial({ code: "ECONNREFUSED" }); };
  const error = await failure(begin(f));
  expect(error.code).toBe("SPAWN_FAILED"); expect(f.child.signals).toEqual([]); expect(f.calls.remove).toEqual([f.profile]); expect(exposed(error)).not.toContain("PRIVATE_");
});

test("Team a live-child error is not termination and cannot authorize profile removal", async () => {
  const f = fixture(); let probes = 0; let removedWhileLive = false;
  f.operations.probe = async () => { probes++; if (probes === 1) { f.child.emit("error", { code: "EPIPE", message: "PRIVATE_LIVE_ERROR" }); return { status: 503 }; } return { status: 200 }; };
  f.operations.removeDirectory = value => { removedWhileLive ||= f.child.exitCode === null && f.child.signalCode === null; f.calls.remove.push(value); };
  const result = await outcome(begin(f));
  try {
    expect(removedWhileLive).toBe(false); expect(result.error).toBeUndefined(); expect(probes).toBe(2);
    await result.value.close(); expect(removedWhileLive).toBe(false); expect(f.child.signals).toEqual(["SIGTERM"]);
  } finally { f.child.exit(); if (result.value) await result.value.close(); }
});

for (const status of [201, 503] as const) {
  test(`Team actual HTTP${status} never counts as ready and keeps400/25 boundaries`, async () => {
    const f = fixture(); let requests = 0;
    const server = createServer((_request, response) => { requests++; response.writeHead(status); response.end("PRIVATE_RESPONSE_BODY"); });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port;
      f.operations.reservePort = async () => ({ port, release: async () => {} });
      f.operations.probe = (url, options) => { f.calls.probes.push({ url, signal: options.signal }); return fetch(url, options); };
      const error = await failure(begin(f));
      expect(requests).toBe(400); expect(f.clock.waits).toEqual(Array(400).fill(25));
      expect(error.code).toBe("SESSION_NOT_READY"); expect(error.diagnostic?.probe).toEqual({ observation: "NON_200_HTTP", status, code: "NONE" });
      expect(exposed(error)).not.toContain("PRIVATE_RESPONSE_BODY");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

test("Team actual200 session response succeeds only for a live child", async () => {
  const f = fixture(); const server = createServer((_request, response) => { response.writeHead(200); response.end("{}"); });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port;
    f.operations.reservePort = async () => ({ port, release: async () => {} }); f.operations.probe = (url, options) => fetch(url, options);
    const handle = await begin(f); expect(f.child.exitCode).toBeNull(); expect(f.clock.waits).toEqual([]); await handle.close();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Team probe receives a real500ms AbortSignal and preserves the25ms failed wait", async () => {
  const f = fixture(); let probes = 0; let observedAbort = false;
  f.operations.probe = async (_url, options) => {
    probes++; expect(options.signal).toBeInstanceOf(AbortSignal);
    if (probes === 1) { await new Promise<void>(resolve => options.signal.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true })); throw Object.assign(new Error("PRIVATE_ABORT"), { code: "ABORT_ERR" }); }
    return { status: 200 };
  };
  const handle = await begin(f); try { expect(observedAbort).toBe(true); expect(probes).toBe(2); expect(f.clock.waits).toEqual([25]); } finally { await handle.close(); }
});

test("Team transport exhaustion keeps400 requests,400 waits and a bounded safe code", async () => {
  const f = fixture();
  f.operations.probe = async (url, options) => { f.calls.probes.push({ url, signal: options.signal }); throwAdversarial({ cause: { code: "ECONNRESET", message: "PRIVATE_TRANSPORT" } }); };
  const error = await failure(begin(f));
  expect(f.calls.probes).toHaveLength(400); expect(f.clock.waits).toEqual(Array(400).fill(25));
  expect(error.code).toBe("SESSION_NOT_READY"); expect(error.diagnostic?.metrics?.attempts).toBe(400);
  expect(error.diagnostic?.probe).toEqual({ observation: "TRANSPORT_ERROR", status: null, code: "ECONNRESET" });
});

test("Team concurrent and repeated close share one promise, signal sequence and deletion", async () => {
  const f = fixture(); const handle = await begin(f);
  const first = handle.close(); const second = handle.close();
  await Promise.allSettled([first, second]);
  expect(second).toBe(first); expect(handle.close()).toBe(first); expect(f.child.signals).toEqual(["SIGTERM"]); expect(f.calls.remove).toEqual([f.profile]);
});

for (const delivery of ["true", "false", "throw", "error"] as const) {
  test(`Team ${delivery} signal delivery requires actual terminal confirmation by2000+2500`, async () => {
    const f = fixture();
    f.child.kill = signal => { f.child.signals.push(signal!); if (delivery === "throw") throw new Error("PRIVATE_KILL_PATH"); if (delivery === "error") f.child.emit("error", { code: "EPERM" }); return delivery !== "false"; };
    const handle = await begin(f); const first = handle.close(); let state = "PENDING"; let error: any;
    void first.then(() => { state = "RESOLVED"; }, caught => { state = "REJECTED"; error = caught; });
    try {
      expect(f.child.signals).toEqual(["SIGTERM"]); f.clock.advance(1999); await flush(); expect(state).toBe("PENDING");
      f.clock.advance(1); expect(f.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      f.clock.advance(2499); await flush(); expect(state).toBe("PENDING"); f.clock.advance(1); await flush(); expect(state).toBe("REJECTED");
      expect(error?.code).toBe("CLEANUP_UNCONFIRMED"); expect(f.calls.remove).toEqual([]); expect(handle.close()).toBe(first); expect(f.clock.errors).toEqual([]);
      f.child.stdout.write("PRIVATE_LATE_OUTPUT"); expect(handle.logs()).toContain("PRIVATE_LATE_OUTPUT");
      f.child.exit(null, "SIGKILL"); await flush(); expect(f.calls.remove).toEqual([]); expect(f.publications).toHaveLength(1);
      expect(exposed(error) + f.publications.join("")).not.toContain("PRIVATE_");
    } finally { f.child.exit(); await Promise.allSettled([first]); }
  });
}

test("Team startup failure remains primary when cleanup cannot confirm terminal state", async () => {
  const f = fixture(); f.child.kill = signal => { f.child.signals.push(signal!); return false; };
  f.operations.probe = async (url, options) => { f.calls.probes.push({ url, signal: options.signal }); throwAdversarial({ code: "ECONNREFUSED" }); };
  const pending = begin(f); let state = "PENDING"; let error: any;
  void pending.then(() => { state = "RESOLVED"; }, caught => { state = "REJECTED"; error = caught; });
  try {
    for (let i = 0; i < 5000 && !f.clock.timers.size; i++) await Promise.resolve(); expect(f.calls.probes).toHaveLength(400); expect(f.clock.timers.size).toBeGreaterThan(0);
    f.clock.advance(4500); await flush(); expect(state).toBe("REJECTED");
    expect(error?.code).toBe("SESSION_NOT_READY"); expect(error?.diagnostic?.secondaryCleanupFailure).toBe("CLEANUP_UNCONFIRMED"); expect(f.calls.remove).toEqual([]);
  } finally { f.child.exit(); await Promise.allSettled([pending]); }
});

test("Team cleanup rejection is cached and public errors exclude private tail, paths and causes", async () => {
  const f = fixture(); const canary = `PRIVATE_TAIL_${crypto.randomUUID()}`;
  f.operations.probe = async () => { f.child.stdout.write(canary); return { status: 200 }; };
  f.operations.removeDirectory = value => { f.calls.remove.push(value); throw Object.assign(new Error(canary), { cause: new Error(canary) }); };
  const handle = await begin(f); const first = handle.close(); const error = await failure(first);
  expect(exposed(error) + f.publications.join("")).not.toContain(canary); expect(error.code).toBe("PROFILE_REMOVE_FAILED");
  expect(handle.close()).toBe(first); expect(await failure(handle.close())).toBe(error); expect(f.calls.remove).toEqual([f.profile]); expect(f.publications).toHaveLength(1);
});

test("Team startup reason survives profile-removal failure and logger throwing", async () => {
  const f = fixture(); let publications = 0;
  f.operations.probe = async () => { f.child.stderr.write("PRIVATE_STARTUP_OUTPUT"); return { status: 503 }; };
  f.operations.removeDirectory = () => { throw new Error("PRIVATE_PROFILE_PATH"); };
  const error = await failure(begin(f, () => { publications++; throw new Error("PRIVATE_LOGGER"); }));
  expect(exposed(error)).not.toContain("PRIVATE_"); expect(error.code).toBe("SESSION_NOT_READY"); expect(error.diagnostic?.secondaryCleanupFailure).toBe("PROFILE_REMOVE_FAILED"); expect(publications).toBe(1);
});

test("Team receipt is latched before a reentrant throwing sink and preserves the cached failure", async () => {
  const f = fixture(); let reentrant: Promise<void> | undefined;
  f.operations.removeDirectory = value => { f.calls.remove.push(value); throw new Error("PRIVATE_REMOVAL"); };
  const handle: Awaited<ReturnType<typeof begin>> = await begin(f, value => { f.publications.push(value); reentrant = handle.close(); void reentrant.catch(() => {}); throw new Error("PRIVATE_LOGGER"); });
  const first = handle.close(); const error = await failure(first);
  expect(f.publications).toHaveLength(1); expect(reentrant).toBe(first); expect(handle.close()).toBe(first);
  expect(error.code).toBe("PROFILE_REMOVE_FAILED"); expect(exposed(error) + f.publications.join("")).not.toContain("PRIVATE_"); expect(f.calls.remove).toEqual([f.profile]);
});

test("Team private interleaved32768-character tail stays exact and only owned capture listeners detach", async () => {
  const f = fixture(); const chunks = [Buffer.from("prefix".repeat(6000)), Buffer.from([0xe2]), Buffer.from([0x82, 0xac]), Buffer.from("SYNTHETIC_MARKER_A"), Buffer.from("SYNTHETIC_MARKER_B")];
  let expected = ""; const external = () => {}; f.child.stdout.on("data", external);
  f.operations.probe = async () => { for (let i = 0; i < chunks.length; i++) { expected = (expected + chunks[i].toString()).slice(-32768); (i % 2 ? f.child.stderr : f.child.stdout).write(chunks[i]); } return { status: 200 }; };
  const handle = await begin(f); expect(handle.logs()).toBe(expected); expect(handle.logs()).toHaveLength(32768); expect(handle.logs()).toContain("SYNTHETIC_MARKER_B");
  await handle.close(); expect(f.child.stdout.listenerCount("data")).toBe(1); expect(f.child.stderr.listenerCount("data")).toBe(0); expect(f.publications).toEqual([]);
});

test("Team public hashes cover all bytes while tail/parser and hostile-error canaries stay private", async () => {
  const f = fixture(); const canary = `PRIVATE_HASH_PAYLOAD_${crypto.randomUUID()}`; const large = Buffer.from(canary.repeat(40000)); let reads = 0;
  const hostile = Object.defineProperties({}, { code: { get() { reads++; return canary; } }, cause: { get() { reads++; throw new Error(canary); } } });
  f.operations.probe = async () => { f.child.stdout.write(large); f.child.stderr.write(large); f.child.stdout.write("SYNTHETIC_METADATA:present"); for (let i = 0; i < 100; i++) f.child.emit("error", hostile); return { status: 200 }; };
  f.operations.removeDirectory = () => { throw new Error(canary); };
  const handle = await begin(f); expect(handle.logs()).toContain("SYNTHETIC_METADATA:present"); const error = await failure(handle.close());
  try {
    expect(exposed(error) + f.publications.join("")).not.toContain(canary); expect(reads).toBe(0);
    const d = error.diagnostic;
    expect(d?.streams?.stdout?.bytes).toBe(large.byteLength + Buffer.byteLength("SYNTHETIC_METADATA:present"));
    expect(d?.streams?.stdout?.sha256).toBe(createHash("sha256").update(large).update("SYNTHETIC_METADATA:present").digest("hex"));
    expect(d?.streams?.stderr?.sha256).toBe(createHash("sha256").update(large).digest("hex"));
    expect(d?.events?.length).toBeLessThanOrEqual(32); expect(d?.droppedEvents).toBeGreaterThan(0); expect(Buffer.byteLength(f.publications[0] ?? "", "utf8")).toBeLessThanOrEqual(16384);
  } finally { f.child.exit(); }
});

test("Team a real owned child announces synthetic private metadata and leaves its control child/data untouched", async () => {
  const f = fixture(); const directory = mkdtempSync(path.join(tmpdir(), "rp-team-owned-real-")); const profile = path.join(directory, "owned"); const unrelated = path.join(directory, "unrelated");
  let child: ReturnType<typeof spawn> | undefined; let control: ReturnType<typeof spawn> | undefined; let controlOwner: ReturnType<typeof observeOwnedChild> | undefined;
  let handle: Awaited<ReturnType<typeof begin>> | undefined; const closing: Promise<void>[] = []; let removals = 0; let expectedTail = "";
  try {
    mkdirSync(profile); mkdirSync(unrelated); writeFileSync(path.join(unrelated, "marker"), "untouched"); f.operations.makeDirectory = () => profile;
    f.operations.removeDirectory = value => { expect(value).toBe(profile); expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true); removals++; rmSync(profile, { recursive: true, force: true }); };
    const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    control = spawn(process.execPath, ["--no-env-file", "-e", "setInterval(()=>{},1000)"], { env, stdio: ["ignore", "pipe", "pipe"] });
    controlOwner = observeOwnedChild(control, () => {}, { clock: ownedClock, termGraceMs: 2000, confirmationMs: 2500 });
    f.operations.spawn = (_command, _args, options) => {
      const marker = `SYNTHETIC_METADATA:${JSON.stringify({ setupCode: options.env?.RUNPHANTOM_TEAM_BOOTSTRAP_CODE })}\n`;
      const script = `const chunk="SYNTHETIC_REAL_BYTES".repeat(40000)+${JSON.stringify(marker)};process.stdout.write(chunk);process.stderr.write(chunk);setInterval(()=>{},1000);`;
      child = spawn(process.execPath, ["--no-env-file", "-e", script], { env, cwd: profile, stdio: ["ignore", "pipe", "pipe"] });
      const capture = (chunk: Buffer) => { expectedTail = (expectedTail + chunk.toString()).slice(-32768); };
      child.stdout!.on("data", capture); child.stderr!.on("data", capture); return child;
    };
    f.operations.probe = async () => { const deadline = performance.now() + 3000; while (!expectedTail.includes("SYNTHETIC_METADATA:") && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); return { status: 200 }; };
    handle = await begin(f); expect(child?.exitCode).toBeNull(); expect(child?.signalCode).toBeNull(); expect(handle.logs()).toBe(expectedTail); expect(handle.logs()).toContain(handle.setupCode);
    closing.push(handle.close(), handle.close()); await Promise.allSettled(closing);
    expect(closing[1]).toBe(closing[0]); expect(removals).toBe(1); expect(existsSync(profile)).toBe(false);
    expect(control.exitCode).toBeNull(); expect(control.signalCode).toBeNull(); expect(readFileSync(path.join(unrelated, "marker"), "utf8")).toBe("untouched");
  } finally {
    if (handle) closing.push(handle.close());
    await Promise.allSettled([...closing, controlOwner?.close()]);
    if (child && child.exitCode === null && child.signalCode === null) await observeOwnedChild(child, () => {}, { clock: ownedClock, termGraceMs: 2000, confirmationMs: 2500 }).close();
    if (child) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    if (control) expect(control.exitCode !== null || control.signalCode !== null).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
