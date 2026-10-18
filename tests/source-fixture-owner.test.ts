import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import type { OwnedChild, OwnedClock } from "./helpers/owned-child";
import { createSourceFixtureOwner, observeSourceRequest, SourceFixtureError, spawnSourceFixture } from "../app/tests-e2e/source-fixture-owner";

class Clock implements OwnedClock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; run: () => void }>();
  now = () => this.time;
  setTimeout = (run: () => void, ms: number) => {
    const id = ++this.next; this.timers.set(id, { at: this.time + ms, run }); return id;
  };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  sleep = async (ms: number) => { this.advance(ms); };
  advance(ms: number) {
    const end = this.time + ms;
    while (true) {
      const entry = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      this.time = entry[1].at; this.timers.delete(entry[0]); entry[1].run();
    }
    this.time = end;
  }
}

class Child extends EventEmitter implements OwnedChild {
  pid: number | undefined = 123;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout: PassThrough | null = new PassThrough();
  stderr: PassThrough | null = new PassThrough();
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM") { this.signals.push(signal); return true; }
  exit() { this.exitCode = 0; this.emit("exit", 0, null); this.emit("close", 0, null); }
  dispose() { this.stdout?.destroy(); this.stderr?.destroy(); }
}

test("KILL without terminal evidence cannot remove the captured profile", async () => {
  const clock = new Clock(), child = new Child(); let removed = 0;
  const owner = createSourceFixtureOwner(child, () => { removed++; }, { clock, emit: () => {} });
  const closing = owner.close(); closing.catch(() => {});
  try {
    clock.advance(2500); await Promise.resolve(); await Promise.resolve();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(removed).toBe(0);
  } finally {
    child.exit(); clock.advance(5000); await closing.catch(() => {}); child.dispose();
  }
});

test("normally resolved fixture use observes actual failed status afterward", async () => {
  const clock = new Clock(), child = new Child(), receipts: string[] = [], order: string[] = [];
  child.exitCode = 0;
  const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => receipts.push(text) });
  try {
    await owner.run({ handle: {}, ready: async () => {}, use: async () => { order.push("use-resolved"); },
      afterUseStatus: () => { order.push("status"); return { actual: "failed", expected: "passed" }; } });
    expect(order).toEqual(["use-resolved", "status"]);
    expect(receipts).toHaveLength(1);
  } finally { child.exit(); child.dispose(); }
});

test("an unregistered operation remains one transparent call and the same promise", async () => {
  const value = {}, promise = Promise.resolve(value); let calls = 0;
  const result = observeSourceRequest(undefined, "DETAIL_COMPLETION", () => { calls++; return promise; });
  expect(result).toBe(promise); expect(await result).toBe(value); expect(calls).toBe(1);
});

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ fulfilled: true as const, value }), error => ({ fulfilled: false as const, error }));
const receipt = (lines: string[]) => {
  expect(lines).toHaveLength(1); expect(lines[0].startsWith("SOURCE_FIXTURE_V1 ")).toBe(true);
  expect(Buffer.byteLength(lines[0] + "\n")).toBeLessThanOrEqual(8192);
  return JSON.parse(lines[0].slice("SOURCE_FIXTURE_V1 ".length));
};
const passed = () => ({ actual: "passed", expected: "passed" });
function throwAdversarial(value: unknown): never {
  throw value;
}
async function rejectAdversarial(value: unknown): Promise<never> {
  return throwAdversarial(value);
}

test("unselected matched use is quiet while an observed successful operation emits actual state", async () => {
  for (const selected of [false, true]) {
    const child = new Child(), clock = new Clock(), lines: string[] = [], handle = {}; child.exitCode = 0;
    const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => lines.push(text) });
    try {
      const value = {};
      await owner.run({ handle, ready: async () => {}, afterUseStatus: passed, use: async () => {
        if (selected) expect(await observeSourceRequest(handle, "DOCUMENT_LOAD", () => Promise.resolve(value))).toBe(value);
      } });
      if (selected) {
        const value = receipt(lines); expect(value.primary.kind).toBe("NONE");
        expect(value.afterClose.lifecycle.cleanup).toBe("REAPED"); expect(value.requests.DOCUMENT_LOAD.fulfilled).toBe(1);
      } else expect(lines).toEqual([]);
    } finally { child.exit(); child.dispose(); }
  }
});

test("framework body failure remains primary when normally resolved use has unconfirmed cleanup", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = [];
  const owner = createSourceFixtureOwner(child, () => { throw new Error("must not remove"); }, { clock, emit: text => lines.push(text) });
  const running = outcome(owner.run({ handle: {}, ready: async () => {}, use: async () => {},
    afterUseStatus: () => ({ actual: "failed", expected: "passed" }) }));
  try {
    await flush(); clock.advance(5000); const result = await running;
    expect(result.fulfilled).toBe(true);
    const value = receipt(lines); expect(value.primary.kind).toBe("FRAMEWORK_BODY");
    expect(value.afterClose.cleanupFailure).toBe("CLEANUP_UNCONFIRMED"); expect(clock.timers.size).toBe(0);
  } finally { child.exit(); child.dispose(); }
});

for (const primary of [undefined, 0, false, "", null, NaN, { private: "PRIMARY_CANARY" }]) {
  test(`use preserves a ${typeof primary} primary value over unknown cleanup`, async () => {
    const child = new Child(), clock = new Clock(), lines: string[] = [];
    const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => lines.push(text) });
    const running = outcome(owner.run({ handle: {}, ready: async () => {}, use: async () => { throwAdversarial(primary); }, afterUseStatus: passed }));
    try {
      await flush(); clock.advance(5000); const result = await running;
      expect(result.fulfilled).toBe(false); if (!result.fulfilled) expect(result.error).toBe(primary);
      expect(receipt(lines).primary.kind).toBe("USE_THROW"); expect(lines[0]).not.toContain("PRIMARY_CANARY");
    } finally { child.exit(); child.dispose(); }
  });
}

test("setup failure is fixed and safe while secondary unknown cleanup remains visible", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = [];
  const hostile = Object.defineProperties({}, { code: { get() { throw new Error("GETTER_CANARY"); } },
    message: { get() { throw new Error("MESSAGE_CANARY"); } } });
  let useCalls = 0;
  const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => lines.push(text) });
  const running = outcome(owner.run({ handle: {}, ready: async () => { throwAdversarial(hostile); }, use: async () => { useCalls++; }, afterUseStatus: passed }));
  try {
    await flush(); clock.advance(5000); const result = await running;
    expect(result.fulfilled).toBe(false);
    if (!result.fulfilled) { expect(result.error).toBeInstanceOf(SourceFixtureError); expect(result.error.stack).toBe("SourceFixtureError: READINESS_FAILED"); }
    const value = receipt(lines); expect(value.use.result).toBe("NOT_REACHED"); expect(value.primary.kind).toBe("SETUP");
    expect(value.afterClose.cleanupFailure).toBe("CLEANUP_UNCONFIRMED"); expect(useCalls).toBe(0); expect(lines[0]).not.toContain("CANARY");
  } finally { child.exit(); child.dispose(); }
});

test("matched status cannot hide cleanup-only failure or mutate expected failure status", async () => {
  for (const actual of ["passed", "failed", "skipped"]) {
    const child = new Child(), clock = new Clock(), lines: string[] = []; child.exitCode = 0;
    const statuses = { actual, expected: actual };
    const owner = createSourceFixtureOwner(child, () => { throw new Error("REMOVER_CANARY"); }, { clock, emit: text => lines.push(text) });
    try {
      const result = await outcome(owner.run({ handle: {}, ready: async () => {}, use: async () => {}, afterUseStatus: () => statuses }));
      expect(result.fulfilled).toBe(false); if (!result.fulfilled) expect(result.error.code).toBe("PROFILE_REMOVE_FAILED");
      const value = receipt(lines); expect(value.primary.kind).toBe("CLEANUP"); expect(statuses).toEqual({ actual, expected: actual });
      expect(lines[0]).not.toContain("REMOVER_CANARY");
    } finally { child.exit(); child.dispose(); }
  }
});

test("unknown or getter-bearing status remains unknown and cannot suppress cleanup failure", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = []; child.exitCode = 0;
  let getters = 0;
  const owner = createSourceFixtureOwner(child, () => { throw new Error("CLEANUP_CANARY"); }, { clock, emit: text => lines.push(text) });
  try {
    const result = await outcome(owner.run({ handle: {}, ready: async () => {}, use: async () => {},
      afterUseStatus: () => Object.defineProperty({ expected: "passed", actual: "" }, "actual", { get() { getters++; return "STATUS_CANARY"; } }) }));
    expect(result.fulfilled).toBe(false); expect(getters).toBe(0);
    const value = receipt(lines); expect(value.use.actual).toBe("UNKNOWN"); expect(value.primary.kind).toBe("CLEANUP"); expect(lines[0]).not.toContain("CANARY");
  } finally { child.exit(); child.dispose(); }
});

test("direct close is cached through remover and throwing sink reentry", async () => {
  const child = new Child(), clock = new Clock(), primary = {}, handle = {}; child.exitCode = 0;
  let removals = 0, removerClose: Promise<void> | undefined, sinkClose: Promise<void> | undefined;
  const owner: ReturnType<typeof createSourceFixtureOwner> = createSourceFixtureOwner(child, () => { removals++; removerClose = owner.close(); }, { clock,
    emit: () => { sinkClose = owner.close(); throw new Error("SINK_CANARY"); } });
  try {
    const result = await outcome(owner.run({ handle, ready: async () => {}, use: async () => { throwAdversarial(primary); }, afterUseStatus: passed }));
    expect(result.fulfilled).toBe(false); if (!result.fulfilled) expect(result.error).toBe(primary);
    expect(removerClose).toBe(owner.close()); expect(sinkClose).toBe(owner.close()); expect(removals).toBe(1);
  } finally { child.exit(); child.dispose(); }
});

test("actual terminal evidence during TERM or confirmation permits one captured removal", async () => {
  for (const elapsed of [1000, 3000]) {
    const child = new Child(), clock = new Clock(); let removed = 0;
    const owner = createSourceFixtureOwner(child, () => { removed++; }, { clock, emit: () => {} });
    const closing = owner.close();
    try {
      clock.advance(elapsed); expect(removed).toBe(0); child.exit(); await closing;
      expect(removed).toBe(1); expect(owner.close()).toBe(closing); expect(clock.timers.size).toBe(0);
      expect(child.signals).toEqual(elapsed < 2500 ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
    } finally { child.dispose(); }
  }
});

test("false or throwing signal delivery never substitutes for actual terminal evidence", async () => {
  for (const throws of [false, true]) {
    const child = new Child(), clock = new Clock(); let removed = 0;
    child.kill = signal => { child.signals.push(signal ?? "SIGTERM"); if (throws) throwAdversarial({ code: "EPERM", private: "SIGNAL_CANARY" }); return false; };
    const owner = createSourceFixtureOwner(child, () => { removed++; }, { clock, emit: () => {} });
    const closing = outcome(owner.close());
    try {
      clock.advance(5000); expect((await closing).fulfilled).toBe(false); expect(removed).toBe(0);
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(clock.timers.size).toBe(0);
    } finally { child.exit(); child.dispose(); }
  }
});

test("safe setup primary survives successful confirmed cleanup without its original value", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = []; child.exitCode = 0; let removed = 0;
  const owner = createSourceFixtureOwner(child, () => { removed++; }, { clock, emit: text => lines.push(text) });
  try {
    const result = await outcome(owner.run({ handle: {}, ready: async () => { throwAdversarial({ private: "SETUP_CANARY" }); },
      use: async () => { throw new Error("must not use"); }, afterUseStatus: passed }));
    expect(result.fulfilled).toBe(false);
    if (!result.fulfilled) expect(result.error.stack).toBe("SourceFixtureError: READINESS_FAILED");
    expect(removed).toBe(1); expect(receipt(lines).afterClose.lifecycle.cleanup).toBe("REAPED"); expect(lines[0]).not.toContain("CANARY");
  } finally { child.exit(); child.dispose(); }
});

test("late actual terminal cannot remove a profile after unconfirmed close rejected", async () => {
  const child = new Child(), clock = new Clock(); let removed = 0;
  const owner = createSourceFixtureOwner(child, () => { removed++; }, { clock, emit: () => {} });
  const closing = owner.close(), observed = outcome(closing);
  try {
    clock.advance(5000); expect((await observed).fulfilled).toBe(false); expect(removed).toBe(0);
    child.exit(); expect(owner.close()).toBe(closing); expect(removed).toBe(0); expect(clock.timers.size).toBe(0);
  } finally { child.dispose(); }
});

test("a returned failed-spawn child permits only the core no-child removal path", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = []; child.pid = undefined;
  let removed = 0;
  const owner = createSourceFixtureOwner(child, () => { removed++; }, { clock, emit: text => lines.push(text) });
  try {
    child.emit("error", { code: "ENOENT", message: "SPAWN_CANARY" });
    const result = await outcome(owner.run({ handle: {}, ready: async () => { throw new SourceFixtureError("HEALTH_TIMEOUT"); },
      use: async () => {}, afterUseStatus: passed }));
    expect(result.fulfilled).toBe(false); expect(removed).toBe(1); expect(child.signals).toEqual([]);
    expect(receipt(lines).afterClose.lifecycle.terminal).toBe("NO_CHILD_CREATED"); expect(lines[0]).not.toContain("CANARY");
  } finally { child.dispose(); }
});

test("synchronous spawn throw reports no captured child without inspecting exotic values", () => {
  const lines: string[] = []; let calls = 0, getters = 0;
  const hostile = Object.defineProperties({}, { code: { get() { getters++; throwAdversarial("CODE_CANARY"); } },
    cause: { get() { getters++; throwAdversarial("CAUSE_CANARY"); } }, toString: { get() { getters++; throwAdversarial("TEXT_CANARY"); } } });
  expect(() => spawnSourceFixture(() => { calls++; throwAdversarial(hostile); }, text => lines.push(text))).toThrow("SPAWN_FAILED");
  expect(calls).toBe(1); expect(getters).toBe(0);
  const value = receipt(lines); expect(value.afterClose.availability).toBe("NOT_ATTACHED");
  expect(value.afterClose.streams.stdout.bytes).toBeNull(); expect(lines[0]).not.toContain("CANARY");
});

test("health observations retain only actual outcomes and never request readiness themselves", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = []; child.exitCode = 0;
  const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => lines.push(text) });
  try {
    await owner.run({ handle: {}, use: async () => {}, afterUseStatus: () => ({ actual: "failed", expected: "passed" }), ready: async () => {
      owner.healthAttempt(); owner.healthRejection({ cause: { code: "ECONNRESET" }, private: "HEALTH_CANARY" });
      owner.healthAttempt(); owner.healthResponse(false); owner.healthAttempt(); owner.healthResponse(true);
    } });
    expect(receipt(lines).health).toEqual({ attempts: 3, ok: 1, nonOk: 1, rejected: 1, lastResult: "OK", lastCode: "NONE" });
    expect(lines[0]).not.toContain("CANARY");
  } finally { child.exit(); child.dispose(); }
});

test("both registered operations preserve exact fulfilled and rejected values with one invocation", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = [], handle = {}; child.exitCode = 0;
  const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => lines.push(text) });
  try {
    await owner.run({ handle, ready: async () => {}, afterUseStatus: passed, use: async () => {
      for (const phase of ["DETAIL_COMPLETION", "DOCUMENT_LOAD"] as const) {
        const value = {}, rejection = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("PROXY_CANARY"); } }); let calls = 0;
        expect(await observeSourceRequest(handle, phase, () => { calls++; return Promise.resolve(value); })).toBe(value);
        const rejected = await outcome(observeSourceRequest(handle, phase, () => { calls++; return rejectAdversarial(rejection); }));
        expect(rejected.fulfilled).toBe(false); if (!rejected.fulfilled) expect(rejected.error).toBe(rejection);
        expect(calls).toBe(2);
      }
    } });
    const value = receipt(lines); expect(value.requests.DETAIL_COMPLETION).toMatchObject({ started: 2, fulfilled: 1, rejected: 1, pending: 0, lastCode: "OTHER" });
    expect(value.requests.DOCUMENT_LOAD.started).toBe(2); expect(lines[0]).not.toContain("CANARY");
  } finally { child.exit(); child.dispose(); }
});

test("pending operation completion after finalization cannot mutate or emit another receipt", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = [], handle = {}; child.exitCode = 0;
  let reject: (value: unknown) => void = () => {}; const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
  const rejection = {}; let observed: ReturnType<typeof outcome> | undefined;
  const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => lines.push(text) });
  try {
    await owner.run({ handle, ready: async () => {}, afterUseStatus: passed, use: async () => {
      observed = outcome(observeSourceRequest(handle, "DOCUMENT_LOAD", () => pending));
    } });
    expect(receipt(lines).requests.DOCUMENT_LOAD.pending).toBe(1); const frozen = lines[0];
    reject(rejection); const result = await observed!;
    expect(result.fulfilled).toBe(false); if (!result.fulfilled) expect(result.error).toBe(rejection);
    expect(lines).toEqual([frozen]);
  } finally { child.exit(); child.dispose(); }
});

test("actual UTF-8 stream prefix hashes remain ACTIVE while missing streams are unavailable", async () => {
  for (const missing of [false, true]) {
    const child = new Child(), clock = new Clock(), lines: string[] = []; child.exitCode = 0;
    if (missing) { child.stdout?.destroy(); child.stdout = null; }
    const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => lines.push(text) });
    try {
      const bytes = Buffer.from("STREAM_CANARY 🧪"); child.stdout?.write(bytes);
      await owner.run({ handle: {}, ready: async () => {}, use: async () => {}, afterUseStatus: () => ({ actual: "failed", expected: "passed" }) });
      const stream = receipt(lines).afterClose.streams.stdout;
      if (missing) expect(stream).toEqual({ availability: "UNAVAILABLE", bytes: null, sha256: null, phase: "UNAVAILABLE" });
      else expect(stream).toEqual({ availability: "ATTACHED", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), phase: "ACTIVE" });
      expect(lines[0]).not.toContain("STREAM_CANARY");
    } finally { child.exit(); child.dispose(); }
  }
});

test("actual close yields ended stream evidence rather than an invented output boundary", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = [];
  const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => lines.push(text) });
  try {
    const bytes = Buffer.from("ENDED_CANARY"); child.stdout!.write(bytes); child.exit();
    await owner.run({ handle: {}, ready: async () => {}, use: async () => {}, afterUseStatus: () => ({ actual: "failed", expected: "passed" }) });
    expect(receipt(lines).afterClose.streams.stdout).toEqual({ availability: "ATTACHED", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), phase: "ENDED" });
    expect(lines[0]).not.toContain("CANARY");
  } finally { child.dispose(); }
});

test("inherited object and array toJSON getters are outside the fresh public projection", () => {
  const lines: string[] = []; let getters = 0;
  const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
  let caught: unknown;
  try {
    const descriptor = { configurable: true, get() { getters++; throwAdversarial("JSON_CANARY"); } };
    Object.defineProperty(Object.prototype, "toJSON", descriptor); Object.defineProperty(Array.prototype, "toJSON", descriptor);
    try { spawnSourceFixture(() => { throwAdversarial({ code: "ENOENT" }); }, text => lines.push(text)); } catch (error) { caught = error; }
  } finally {
    if (objectDescriptor) Object.defineProperty(Object.prototype, "toJSON", objectDescriptor); else delete (Object.prototype as { toJSON?: unknown }).toJSON;
    if (arrayDescriptor) Object.defineProperty(Array.prototype, "toJSON", arrayDescriptor); else delete (Array.prototype as { toJSON?: unknown }).toJSON;
  }
  expect(caught).toBeInstanceOf(SourceFixtureError); expect(getters).toBe(0);
  expect(receipt(lines).afterClose.availability).toBe("NOT_ATTACHED"); expect(lines[0]).not.toContain("CANARY");
});

test("repeated hostile events and request failures stay within sixteen events and eight KiB", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = [], handle = {}; let getters = 0;
  const hostile = Object.defineProperties({}, { code: { get() { getters++; throwAdversarial("CODE_CANARY"); } },
    message: { get() { getters++; throwAdversarial("MESSAGE_CANARY"); } }, stack: { get() { getters++; throwAdversarial("STACK_CANARY"); } },
    toJSON: { get() { getters++; throwAdversarial("JSON_CANARY"); } }, toString: { get() { getters++; throwAdversarial("STRING_CANARY"); } } });
  const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => lines.push(text) });
  try {
    for (let i = 0; i < 128; i++) child.emit("error", hostile);
    child.exitCode = 0; clock.time = Number.MAX_SAFE_INTEGER;
    await owner.run({ handle, ready: async () => {}, afterUseStatus: passed, use: async () => {
      for (const phase of ["DETAIL_COMPLETION", "DOCUMENT_LOAD"] as const) {
        for (let i = 0; i < 128; i++) await outcome(observeSourceRequest(handle, phase, () => rejectAdversarial(hostile)));
      }
    } });
    const value = receipt(lines); expect(value.events.length).toBe(16); expect(value.droppedEvents).toBeGreaterThan(0);
    expect(value.requests.DETAIL_COMPLETION.rejected).toBe(128); expect(value.requests.DOCUMENT_LOAD.rejected).toBe(128);
    expect(getters).toBe(0); expect(lines[0]).not.toContain("CANARY");
  } finally { child.exit(); child.dispose(); }
});

test("a status callback exception still closes the owner and reports unknown without its text", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = []; child.exitCode = 0; let removed = 0;
  const owner = createSourceFixtureOwner(child, () => { removed++; }, { clock, emit: text => lines.push(text) });
  try {
    await owner.run({ handle: {}, ready: async () => {}, use: async () => {}, afterUseStatus: () => { return throwAdversarial({ private: "STATUS_CANARY" }); } });
    expect(removed).toBe(1); const value = receipt(lines);
    expect(value.use.actual).toBe("UNKNOWN"); expect(value.primary.kind).toBe("UNKNOWN_STATUS"); expect(lines[0]).not.toContain("CANARY");
  } finally { child.exit(); child.dispose(); }
});

test("unknown close drains until actual close and removes only its own listeners", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = []; let outsideErrors = 0, outsideData = 0, removed = 0;
  const outsideError = () => { outsideErrors++; }, outsideChunk = () => { outsideData++; };
  child.on("error", outsideError); child.stdout!.on("data", outsideChunk);
  const owner = createSourceFixtureOwner(child, () => { removed++; }, { clock, emit: text => lines.push(text) });
  const running = outcome(owner.run({ handle: {}, ready: async () => {}, use: async () => {}, afterUseStatus: passed }));
  try {
    await flush(); clock.advance(5000); expect((await running).fulfilled).toBe(false);
    const frozen = lines[0]; child.emit("error", { code: "ECONNRESET" }); child.stdout!.write("LATE_PRIVATE_CHUNK");
    expect(child.listenerCount("error")).toBe(2); expect(child.stdout!.listenerCount("data")).toBe(2);
    child.exit(); expect(child.listenerCount("error")).toBe(1); expect(child.stdout!.listenerCount("data")).toBe(1);
    expect(outsideErrors).toBe(1); expect(outsideData).toBe(1); expect(removed).toBe(0); expect(lines).toEqual([frozen]);
  } finally { child.off("error", outsideError); child.stdout?.off("data", outsideChunk); child.dispose(); }
});

test("synchronous operation throws and getter-bearing fulfilled values remain transparent", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = [], handle = {}; child.exitCode = 0;
  let getters = 0, calls = 0;
  const value = Object.defineProperties({}, { status: { get() { getters++; throwAdversarial("STATUS_CANARY"); } },
    toJSON: { get() { getters++; throwAdversarial("JSON_CANARY"); } } });
  const primary = {};
  const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => lines.push(text) });
  try {
    await owner.run({ handle, ready: async () => {}, afterUseStatus: passed, use: async () => {
      expect(await observeSourceRequest(handle, "DOCUMENT_LOAD", () => { calls++; return Promise.resolve(value); })).toBe(value);
      let caught = false;
      try { void observeSourceRequest(handle, "DETAIL_COMPLETION", () => { calls++; return throwAdversarial(primary); }); }
      catch (error) { caught = true; expect(error).toBe(primary); }
      expect(caught).toBe(true);
    } });
    expect(calls).toBe(2); expect(getters).toBe(0); const result = receipt(lines);
    expect(result.requests.DETAIL_COMPLETION.rejected).toBe(1); expect(lines[0]).not.toContain("CANARY");
  } finally { child.exit(); child.dispose(); }
});

test("only one own-data cause level supplies safe codes while cyclic and inherited fields stay inert", async () => {
  const child = new Child(), clock = new Clock(), lines: string[] = [], handle = {}; child.exitCode = 0;
  const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
  const cases = [Object.create({ code: "ECONNRESET" }), cyclic, { cause: { cause: { code: "ECONNRESET" } } }];
  const owner = createSourceFixtureOwner(child, () => {}, { clock, emit: text => lines.push(text) });
  try {
    await owner.run({ handle, ready: async () => {}, afterUseStatus: passed, use: async () => {
      for (const error of cases) await outcome(observeSourceRequest(handle, "DETAIL_COMPLETION", () => rejectAdversarial(error)));
      await outcome(observeSourceRequest(handle, "DOCUMENT_LOAD", () => rejectAdversarial({ cause: { code: "ECONNRESET" } })));
    } });
    const result = receipt(lines); expect(result.requests.DETAIL_COMPLETION.lastCode).toBe("OTHER");
    expect(result.requests.DOCUMENT_LOAD.lastCode).toBe("ECONNRESET");
  } finally { child.exit(); child.dispose(); }
});

test("diagnostic clock and logger exceptions cannot change an observed operation or confirmed removal", async () => {
  const child = new Child(), clock = new Clock(), handle = {}, value = {}; child.exitCode = 0; let removed = 0, calls = 0;
  const owner = createSourceFixtureOwner(child, () => { removed++; }, { clock, emit: () => { throw new Error("LOGGER_CANARY"); } });
  clock.now = () => { throw new Error("CLOCK_CANARY"); };
  try {
    await owner.run({ handle, ready: async () => {}, afterUseStatus: passed, use: async () => {
      expect(await observeSourceRequest(handle, "DOCUMENT_LOAD", () => { calls++; return Promise.resolve(value); })).toBe(value);
    } });
    expect(calls).toBe(1); expect(removed).toBe(1);
  } finally { child.exit(); child.dispose(); }
});
