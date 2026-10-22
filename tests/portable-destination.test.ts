import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { observePortableProcess, startPortableDestination, withPortableDestination, type PortableChild, type PortableClock, type PortableDependencies } from "../app/tests-e2e/portable-destination";

class Clock implements PortableClock {
  time = 0;
  timers = new Map<number, { at: number; run: () => void }>();
  next = 0;
  now = () => this.time;
  setTimeout = (run: () => void, ms: number) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + ms, run });
    return id;
  };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  sleep = async (ms: number) => { this.advance(ms); };
  advance(ms: number) {
    const end = this.time + ms;
    while (true) {
      const pending = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending) break;
      this.time = pending[1].at;
      this.timers.delete(pending[0]);
      pending[1].run();
    }
    this.time = end;
  }
}

class Child extends EventEmitter implements PortableChild {
  pid: number | undefined = 123;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM") { this.signals.push(signal); return true; }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.exitCode = code; this.signalCode = signal;
    this.emit("exit", code, signal); this.emit("close", code, signal);
  }
}

test("an already signal-exited destination closes without signalling or waiting for another exit", async () => {
  const child = new Child();
  child.signalCode = "SIGTERM";
  const clock = new Clock();
  let removals = 0;
  const owner = observePortableProcess(child, () => { removals++; }, clock);
  const closing = owner.close();
  void closing.catch(() => {});
  expect(child.signals).toEqual([]);
  await closing;
  expect(removals).toBe(1);
  expect(clock.timers.size).toBe(0);
});

test("signal delivery never substitutes for exit confirmation and retains the profile after 2500 + 2500 ms", async () => {
  const child = new Child(); const clock = new Clock(); let removals = 0;
  const owner = observePortableProcess(child, () => { removals++; }, clock);
  let result = "PENDING";
  const closing = owner.close().then(() => { result = "RESOLVED"; }, () => { result = "REJECTED"; });
  expect(child.signals).toEqual(["SIGTERM"]);
  clock.advance(2499); expect(child.signals).toEqual(["SIGTERM"]);
  clock.advance(1); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  clock.advance(2499); await Promise.resolve(); expect(result).toBe("PENDING");
  clock.advance(1); await Promise.resolve(); await Promise.resolve();
  expect(result).toBe("REJECTED");
  await closing;
  expect(removals).toBe(0);
  child.exit(); await Promise.resolve(); expect(removals).toBe(0);
  expect(clock.timers.size).toBe(0);
});

test("concurrent close has one shared promise, shutdown sequence and profile deletion", async () => {
  const child = new Child(); const clock = new Clock(); let removals = 0;
  const owner = observePortableProcess(child, () => { removals++; }, clock);
  const first = owner.close(); const second = owner.close();
  expect(second).toBe(first);
  child.exit(0);
  await first;
  expect(owner.close()).toBe(first);
  expect(child.signals).toEqual(["SIGTERM"]); expect(removals).toBe(1); expect(clock.timers.size).toBe(0);
});

test("a live child error and failed signals require actual exit, rather than resolving cleanup", async () => {
  const child = new Child(); const clock = new Clock(); let removals = 0;
  child.kill = signal => { child.signals.push(signal!); throw new Error("PRIVATE_KILL_PATH"); };
  const owner = observePortableProcess(child, () => { removals++; }, clock);
  child.emit("spawn"); child.emit("error", new Error("PRIVATE_LIVE_ERROR"));
  let settled = false;
  const closing = owner.close().then(() => { settled = true; }, () => { settled = true; });
  clock.advance(2500); await Promise.resolve(); expect(settled).toBe(false);
  child.exit(null, "SIGKILL"); await closing;
  expect(removals).toBe(1); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("close during creation preserves deadlines and signals only after owned spawn", async () => {
  const child = new Child(); child.pid = undefined;
  const clock = new Clock(); let removals = 0;
  const owner = observePortableProcess(child, () => { removals++; }, clock);
  const closing = owner.close(); void closing.catch(() => {});
  expect(child.signals).toEqual([]);
  clock.advance(2500); expect(child.signals).toEqual([]);
  child.pid = 123; child.emit("spawn");
  expect(child.signals).toEqual(["SIGKILL"]);
  child.exit(null, "SIGKILL"); await closing; expect(removals).toBe(1);
});

test("failed creation without a child can clean up without sending a signal", async () => {
  const child = new Child(); child.pid = undefined;
  const clock = new Clock(); let removals = 0;
  const owner = observePortableProcess(child, () => { removals++; }, clock);
  child.emit("error", Object.assign(new Error("PRIVATE_SPAWN_ERROR"), { code: "ENOENT" }));
  await owner.close();
  expect(child.signals).toEqual([]); expect(removals).toBe(1); expect(clock.timers.size).toBe(0);
});

test("exit during listener installation is rechecked without a second exit", async () => {
  class RacingChild extends Child {
    override on(event: string | symbol, listener: (...args: any[]) => void) {
      const result = super.on(event, listener);
      if (event === "exit") this.exitCode = 7;
      return result;
    }
  }
  const child = new RacingChild(); const clock = new Clock(); let removals = 0;
  const owner = observePortableProcess(child, () => { removals++; }, clock);
  const closing = owner.close(); void closing.catch(() => {});
  expect(child.signals).toEqual([]); await closing; expect(removals).toBe(1);
});

test("a profile deletion failure is safe, terminal and never repeated", async () => {
  const child = new Child(); child.exitCode = 0;
  const clock = new Clock(); let removals = 0;
  const owner = observePortableProcess(child, () => { removals++; throw new Error("PRIVATE_PROFILE_PATH"); }, clock);
  const first = owner.close();
  const firstError = await failure(first);
  expect(firstError).toBeInstanceOf(Error);
  expect(firstError.message).toBe("PROFILE_REMOVE_FAILED");
  const repeatedError = await failure(owner.close());
  expect(repeatedError).toBeInstanceOf(Error);
  expect(repeatedError.message).toBe("PROFILE_REMOVE_FAILED");
  expect(removals).toBe(1);
});

test("oversized and repeated output is continuously hashed without publishing raw bytes", async () => {
  const child = new Child(); const clock = new Clock();
  const owner = observePortableProcess(child, () => {}, clock);
  const canary = `PRIVATE_SECRET_PAYLOAD_PATH_${crypto.randomUUID()}`;
  const chunk = Buffer.from(canary.repeat(40000));
  child.stdout.write(chunk);
  child.stderr.write(Buffer.from(canary));
  const first = owner.snapshot();
  expect(first.streams.stdout.bytes).toBe(chunk.byteLength);
  expect(first.streams.stdout.sha256).toBe(createHash("sha256").update(chunk).digest("hex"));
  expect(first.streams.stdout.phase).toBe("ACTIVE");
  child.stdout.write(chunk); child.stdout.end(); child.stderr.end();
  const final = owner.snapshot();
  expect(final.streams.stdout.bytes).toBe(chunk.byteLength * 2);
  expect(final.streams.stdout.sha256).toBe(createHash("sha256").update(chunk).update(chunk).digest("hex"));
  expect(JSON.stringify(final)).not.toContain(canary);
  child.exit(); await owner.close();
});

test("repeated unknown and getter-bearing errors stay capped and never execute getters", async () => {
  const child = new Child(); const clock = new Clock();
  const owner = observePortableProcess(child, () => {}, clock);
  let reads = 0;
  const error = Object.defineProperties({}, {
    code: { get() { reads++; return "PRIVATE_CODE"; } },
    cause: { get() { reads++; throw new Error("PRIVATE_CAUSE"); } },
  });
  for (let i = 0; i < 100; i++) child.emit("error", error);
  child.emit("error", { code: "PRIVATE_UNKNOWN_CODE", message: "PRIVATE_MESSAGE", stack: "PRIVATE_PATH" });
  const diagnostic = owner.snapshot(); const publicText = JSON.stringify(diagnostic);
  expect(reads).toBe(0); expect(diagnostic.events).toHaveLength(32);
  expect(diagnostic.droppedEvents).toBeGreaterThan(0); expect(diagnostic.truncation).toBe("EVENTS_DROPPED");
  expect(Buffer.byteLength(publicText, "utf8")).toBeLessThanOrEqual(16384);
  expect(publicText).not.toContain("PRIVATE_");
  child.exit(); await owner.close();
});

function fixture() {
  const child = new Child(); const clock = new Clock();
  const calls = { remove: 0, release: 0, spawn: 0, health: 0, waits: [] as number[] };
  child.kill = signal => { child.signals.push(signal!); child.exit(null, signal!); return true; };
  clock.sleep = async ms => { calls.waits.push(ms); clock.advance(ms); };
  const deps: PortableDependencies = {
    clock,
    makeDirectory: () => "PRIVATE_OWNED_PROFILE",
    removeDirectory: directory => { expect(directory).toBe("PRIVATE_OWNED_PROFILE"); calls.remove++; },
    reservePort: async () => ({ port: 12345, release: async () => { calls.release++; } }),
    spawn: () => { calls.spawn++; return child; },
    health: async () => { calls.health++; return { ok: true, status: 200 }; },
  };
  return { child, clock, calls, deps };
}
function throwAdversarial(value: unknown): never {
  throw value;
}
function exposed(error: any) {
  return JSON.stringify({ name: error?.name, message: error?.message, stack: error?.stack, cause: error?.cause, code: error?.code, diagnostic: error?.diagnostic });
}
async function failure(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return error as any; }
  throw new Error("Expected failure");
}

for (const stage of ["directory", "reservation", "release", "spawn"] as const) {
  test(`${stage} setup failure is safely classified and only owned state is removed`, async () => {
    const f = fixture(); const canary = `PRIVATE_${stage}_${crypto.randomUUID()}`;
    const fail = () => { throw Object.assign(new Error(canary), { code: "PRIVATE_UNKNOWN", cause: new Error(canary) }); };
    if (stage === "directory") f.deps.makeDirectory = fail;
    if (stage === "reservation") f.deps.reservePort = async () => fail();
    if (stage === "release") f.deps.reservePort = async () => ({ port: 12345, release: async () => { f.calls.release++; fail(); } });
    if (stage === "spawn") f.deps.spawn = fail;
    const error = await failure(startPortableDestination("PRIVATE_REPO", f.deps));
    expect(error.code).toBe(stage === "directory" ? "SETUP_FAILED" : stage === "spawn" ? "SPAWN_FAILED" : "RESERVATION_FAILED");
    expect(exposed(error)).not.toContain(canary); expect(exposed(error)).not.toContain("PRIVATE_");
    expect(f.calls.remove).toBe(stage === "directory" || stage === "release" ? 0 : 1); expect(f.calls.health).toBe(0);
    if (stage === "release") {
      expect(error.diagnostic.secondaryCleanupFailure).toBe("CLEANUP_FAILED");
      expect(error.diagnostic.lifecycle.cleanup).toBe("FAILED");
    }
  });
}

for (const terminal of ["exit", "signal", "spawn-failure"] as const) {
  test(`${terminal} before readiness fails safely without fabricated health success`, async () => {
    const f = fixture();
    if (terminal === "exit") f.child.exitCode = 17;
    if (terminal === "signal") f.child.signalCode = "SIGABRT";
    if (terminal === "spawn-failure") {
      f.child.pid = undefined;
      f.deps.health = async () => { f.calls.health++; f.child.emit("error", { code: "ENOENT", message: "PRIVATE_ERROR" }); throwAdversarial({ code: "ECONNREFUSED" }); };
    }
    const error = await failure(startPortableDestination("PRIVATE_REPO", f.deps));
    expect(error.code).toBe(terminal === "spawn-failure" ? "SPAWN_FAILED" : "EXITED_BEFORE_READY");
    expect(exposed(error)).not.toContain("PRIVATE_"); expect(f.calls.remove).toBe(1);
    expect(f.calls.health).toBe(terminal === "spawn-failure" ? 1 : 0); expect(f.child.signals).toEqual([]);
  });
}

test("transport failures keep 200 actual attempts and 50ms waits with safe last observations", async () => {
  const f = fixture();
  f.deps.health = async () => { f.calls.health++; throwAdversarial({ cause: { code: "ECONNRESET", message: "PRIVATE_BODY" }, message: "PRIVATE_URL" }); };
  const error = await failure(startPortableDestination("PRIVATE_REPO", f.deps));
  expect(error.code).toBe("HEALTH_NOT_READY"); expect(f.calls.health).toBe(200);
  expect(f.calls.waits).toEqual(Array(200).fill(50));
  expect(error.diagnostic.health).toEqual({ observation: "TRANSPORT_ERROR", status: null, code: "ECONNRESET" });
  expect(error.diagnostic.metrics.attempts).toBe(200); expect(exposed(error)).not.toContain("PRIVATE_");
});

test("only actual OK health succeeds after failed observations and a live-child error is not an exit", async () => {
  const f = fixture();
  f.deps.health = async () => {
    f.calls.health++;
    if (f.calls.health === 1) throwAdversarial({ code: "ECONNREFUSED" });
    if (f.calls.health === 2) return { ok: false, status: 503 };
    f.child.emit("error", { code: "EPIPE", message: "PRIVATE_LIVE_ERROR" });
    return { ok: true, status: 200 };
  };
  const target = await startPortableDestination("PRIVATE_REPO", f.deps);
  expect(f.calls.health).toBe(3); expect(f.calls.waits).toEqual([50, 50]);
  expect(target.snapshot().health).toEqual({ observation: "OK_HTTP", status: 200, code: "NONE" });
  expect(target.snapshot().primaryFailure).toBe("NONE"); await target.close();
});

test("matching owned close observation confirms cleanup even without populated terminal fields", async () => {
  const child = new Child(); const clock = new Clock(); let removed = 0;
  const owner = observePortableProcess(child, () => { removed++; }, clock);
  const closing = owner.close(); child.emit("close", null, "SIGTERM"); await closing;
  expect(removed).toBe(1); expect(owner.snapshot().lifecycle.terminal).toBe("CLOSE_EVENT"); expect(clock.timers.size).toBe(0);
});

test("unresolved creation never signals an absent process and fails boundedly", async () => {
  const child = new Child(); child.pid = undefined; const clock = new Clock(); let removed = 0;
  const owner = observePortableProcess(child, () => { removed++; }, clock);
  const pending = failure(owner.close()); clock.advance(5000);
  expect((await pending).code).toBe("CLEANUP_UNCONFIRMED"); expect(child.signals).toEqual([]); expect(removed).toBe(0);
  child.emit("close");
});

test("actual non-OK HTTP is observed 200 times and never substituted with ready", async () => {
  const f = fixture(); let received = 0;
  const server = createServer((_request, response) => { received++; response.writeHead(503); response.end("PRIVATE_HTTP_BODY"); });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    f.deps.reservePort = async () => ({ port, release: async () => {} });
    f.deps.health = url => fetch(url);
    const error = await failure(startPortableDestination("PRIVATE_REPO", f.deps));
    expect(received).toBe(200); expect(f.calls.waits).toEqual(Array(200).fill(50));
    expect(error.code).toBe("HEALTH_NOT_READY");
    expect(error.diagnostic.health).toEqual({ observation: "NON_OK_HTTP", status: 503, code: "NONE" });
    expect(exposed(error)).not.toContain("PRIVATE_");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("product failure remains primary over cleanup failure without publishing caught errors", async () => {
  const f = fixture(); const attachments: string[] = [];
  f.deps.removeDirectory = () => { f.calls.remove++; throw new Error("PRIVATE_CLEANUP_PATH"); };
  const error = await failure(withPortableDestination("PRIVATE_REPO", async () => { throw new Error("PRIVATE_PRODUCT_PAYLOAD"); }, async diagnostic => { attachments.push(diagnostic); }, f.deps));
  expect(error.code).toBe("PRODUCT_FAILURE");
  expect(error.diagnostic.secondaryCleanupFailure).toBe("PROFILE_REMOVE_FAILED");
  expect(attachments).toHaveLength(1);
  expect(exposed(error) + attachments.join("")).not.toContain("PRIVATE_");
});

test("cleanup-only failure and attachment failure both fail safely", async () => {
  const f = fixture();
  f.deps.removeDirectory = () => { throw new Error("PRIVATE_CLEANUP_PATH"); };
  const cleanup = await failure(withPortableDestination("PRIVATE_REPO", async () => {}, async () => {}, f.deps));
  expect(cleanup.code).toBe("PROFILE_REMOVE_FAILED"); expect(exposed(cleanup)).not.toContain("PRIVATE_");
  const g = fixture();
  const attachment = await failure(withPortableDestination("PRIVATE_REPO", async () => {}, async () => { throw new Error("PRIVATE_ATTACHMENT_PATH"); }, g.deps));
  expect(attachment.code).toBe("SETUP_FAILED"); expect(exposed(attachment)).not.toContain("PRIVATE_");
});

for (const delivery of ["false", "throw", "error", "true"] as const) {
  test(`${delivery} signal result without termination retains ownership and drains until actual close`, async () => {
    const child = new Child(); const clock = new Clock(); let removed = 0;
    const externalExit = () => {}; const externalError = () => {};
    child.on("exit", externalExit); child.on("error", externalError);
    child.kill = signal => {
      child.signals.push(signal!);
      if (delivery === "throw") throwAdversarial({ code: "EPERM", message: "PRIVATE_KILL" });
      if (delivery === "error") child.emit("error", { code: "EACCES", message: "PRIVATE_KILL" });
      return delivery !== "false";
    };
    const owner = observePortableProcess(child, () => { removed++; }, clock);
    const pending = failure(owner.close()); clock.advance(5000);
    const error = await pending;
    expect(error.code).toBe("CLEANUP_UNCONFIRMED"); expect(removed).toBe(0);
    expect(child.listenerCount("spawn")).toBe(0); expect(child.listenerCount("exit")).toBe(1);
    expect(child.listenerCount("error")).toBe(2);
    child.stdout.write("PRIVATE_LATE_BYTES"); expect(owner.snapshot().streams.stdout.bytes).toBe(18);
    child.emit("error", { code: "PRIVATE_LATE_ERROR" });
    child.exit(null, "SIGKILL");
    expect(child.listenerCount("error")).toBe(1); expect(child.listenerCount("close")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(removed).toBe(0); expect(exposed(error)).not.toContain("PRIVATE_");
  });
}

test("startup failure stays primary when cleanup cannot confirm termination", async () => {
  const f = fixture(); const attachments: string[] = [];
  f.child.kill = signal => { f.child.signals.push(signal!); return false; };
  f.deps.health = async () => { f.calls.health++; throwAdversarial({ code: "ECONNREFUSED" }); };
  const pending = failure(withPortableDestination("PRIVATE_REPO", async () => { throw new Error("Must not run product"); }, async diagnostic => { attachments.push(diagnostic); }, f.deps));
  for (let i = 0; i < 1000; i++) await Promise.resolve();
  expect(f.calls.health).toBe(200); f.clock.advance(5000);
  const error = await pending;
  expect(error.code).toBe("HEALTH_NOT_READY"); expect(error.diagnostic.secondaryCleanupFailure).toBe("CLEANUP_UNCONFIRMED");
  expect(f.calls.remove).toBe(0); expect(attachments).toHaveLength(1); expect(exposed(error) + attachments.join("")).not.toContain("PRIVATE_");
  f.child.exit();
});

test("safe projections bound nonfinite timing, unknown signals and one-level error causes", async () => {
  const child = new Child(); const clock = new Clock();
  const owner = observePortableProcess(child, () => {}, clock);
  clock.time = Infinity;
  child.emit("error", { cause: { cause: { code: "ECONNRESET", message: "PRIVATE_DEEP" } } });
  child.exitCode = Infinity; child.signalCode = "PRIVATE_SIGNAL" as NodeJS.Signals;
  await owner.close();
  const diagnostic = owner.snapshot();
  expect(diagnostic.metrics.elapsedMs).toBe(0);
  expect(diagnostic.lifecycle.signal).toBe("OTHER"); expect(diagnostic.lifecycle.exitClass).toBe("OTHER");
  expect(diagnostic.events.find(event => event.event === "CHILD_ERROR")?.code).toBe("OTHER");
  expect(owner.serialize()).not.toContain("PRIVATE_"); expect(Buffer.byteLength(owner.serialize(), "utf8")).toBeLessThanOrEqual(16384);
});

test("a real owned synthetic child is reaped before profile removal while a control child and unrelated data survive", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rp-portable-owner-test-"));
  const directory = path.join(root, "owned"); const unrelated = path.join(root, "unrelated");
  let child: ReturnType<typeof spawn> | undefined; let control: ReturnType<typeof spawn> | undefined;
  let owner: ReturnType<typeof observePortableProcess> | undefined; let controlOwner: ReturnType<typeof observePortableProcess> | undefined;
  try {
    const { mkdirSync } = await import("node:fs"); mkdirSync(directory); mkdirSync(unrelated);
    writeFileSync(path.join(unrelated, "marker"), "untouched");
    const canary = `PRIVATE_REAL_OUTPUT_${crypto.randomUUID()}`; const chunk = canary.repeat(40000);
    const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    child = spawn(process.execPath, ["--no-env-file", "-e", `const chunk=${JSON.stringify(canary)}.repeat(40000);process.stdout.write(chunk);process.stderr.write(chunk);setInterval(()=>{},1000);`], { env, stdio: ["ignore", "pipe", "pipe"] });
    const ownedChild = child; let removals = 0; let exitObserved = false;
    child.once("exit", () => { exitObserved = true; });
    owner = observePortableProcess(child, () => {
      expect(exitObserved || ownedChild.exitCode !== null || ownedChild.signalCode !== null).toBe(true);
      removals++; rmSync(directory, { recursive: true, force: true });
    });
    control = spawn(process.execPath, ["--no-env-file", "-e", "setInterval(()=>{},1000)"], { env, stdio: ["ignore", "pipe", "pipe"] });
    controlOwner = observePortableProcess(control, () => {});
    const deadline = performance.now() + 3000;
    while ((owner.snapshot().streams.stdout.bytes !== Buffer.byteLength(chunk) || owner.snapshot().streams.stderr.bytes !== Buffer.byteLength(chunk)) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull(); expect(existsSync(directory)).toBe(true);
    expect(owner.snapshot().streams.stdout.bytes).toBe(Buffer.byteLength(chunk));
    expect(owner.snapshot().streams.stderr.sha256).toBe(createHash("sha256").update(chunk).digest("hex"));
    const first = owner.close(); expect(owner.close()).toBe(first); await first;
    expect(owner.close()).toBe(first); expect(removals).toBe(1); expect(existsSync(directory)).toBe(false);
    expect(control.exitCode).toBeNull(); expect(control.signalCode).toBeNull();
    expect(control.pid).toBeGreaterThan(0);
    expect(readFileSync(path.join(unrelated, "marker"), "utf8")).toBe("untouched");
    expect(owner.serialize()).not.toContain(canary);
  } finally {
    await Promise.allSettled([owner?.close(), controlOwner?.close()]);
    if (child) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    if (control) expect(control.exitCode !== null || control.signalCode !== null).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
});
