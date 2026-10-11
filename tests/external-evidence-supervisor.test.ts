import { expect, test } from "bun:test";
import { EvidenceSupervisor, EvidenceSupervisorError, getEvidenceSupervisor, spawnEvidenceWorker, type ReaderOperation } from "../src/evaluations/evidence-supervisor";
import { parseExternalEvidence } from "../src/evaluations/external-evidence";

const xml = '<testsuite><testcase name="one"/></testsuite>';
const request = (jobId: string, extra: Partial<ReaderOperation> = {}): ReaderOperation => ({ jobId, publicationToken: `token-${jobId}`, scopeGeneration: 1,
  sources: [{ sourceId: "one", dialect: "junit-xml/v1", bytes: new TextEncoder().encode(xml) }], ...extra });
const fixtureProcess = (source: string) => Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", source], { env: { LANG: "C.UTF-8" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
async function refused(result: Promise<unknown>, code: string) {
  try { await result; throw new Error("unexpected_success"); } catch (error) {
    expect(error).toBeInstanceOf(EvidenceSupervisorError);
    expect((error as EvidenceSupervisorError).code).toBe(code);
  }
}
test("real source workers preserve operation fences and independently malformed observations", async () => {
  const supervisor = new EvidenceSupervisor();
  try {
    const result = await supervisor.submit(request("normal", { sources: [request("x").sources[0], { sourceId: "broken", dialect: "junit-xml/v1", bytes: new TextEncoder().encode("<testsuite>") }] })).result;
    expect(result.sources.map(source => source.reportOutcome)).toEqual(["reports_pass", "unknown"]);
    expect(result.sources[1].parseState).toBe("unparsed");
    expect(result.publicationToken).toBe("token-normal");
    expect(result.scopeGeneration).toBe(1);
    expect(result.workers).toHaveLength(2);
    expect(result.cpuMs).toBeNull(); expect(result.rssBytes).toBeNull();
    for (const worker of result.workers) expect(() => process.kill(worker.pid, 0)).toThrow();
    expect(supervisor.state).toEqual({ active: 0, queued: 0, closed: false });
  } finally { await supervisor.shutdown(); }
});
test("two callers share two active workers and eight queued imports; cancellation reaps and recovers", async () => {
  const pids: number[] = []; let blocked = true;
  const supervisor = new EvidenceSupervisor({ workerFactory: () => {
    const child = blocked ? fixtureProcess("setInterval(() => {}, 1000)") : spawnEvidenceWorker(); pids.push(child.pid); return child;
  } });
  const handles = Array.from({ length: 10 }, (_, index) => supervisor.submit(request(`client-${index % 2}-job-${index}`)));
  const outcomes = handles.map(handle => handle.result.catch(error => error));
  try {
    expect(supervisor.state).toEqual({ active: 2, queued: 8, closed: false });
    expect(() => supervisor.submit(request("overflow"))).toThrow("queue_full");
    for (const handle of handles) handle.cancel();
    for (const outcome of await Promise.all(outcomes)) expect(outcome.code).toBe("cancelled");
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(supervisor.state.active).toBe(0); expect(supervisor.state.queued).toBe(0);
    blocked = false;
    expect((await supervisor.submit(request("recovered")).result).sources[0].reportOutcome).toBe("reports_pass");
  } finally { await supervisor.shutdown(); }
});
test("source timeout kills the actual process and rejects before publishing its result", async () => {
  let pid = 0;
  const supervisor = new EvidenceSupervisor({ maxSourceMs: 100, workerFactory: () => { const child = fixtureProcess("while(true) {} "); pid = child.pid; return child; } });
  try {
    await refused(supervisor.submit(request("timeout")).result, "source_timeout");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(supervisor.state.active).toBe(0);
  } finally { await supervisor.shutdown(); }
});
test("a blocked input pipe retains the timeout reason while its worker is reaped", async () => {
  let pid = 0;
  const supervisor = new EvidenceSupervisor({ maxSourceMs: 100, workerFactory: () => { const child = fixtureProcess("while(true) {} "); pid = child.pid; return child; } });
  try {
    const input = request("blocked-input", { sources: [{ sourceId: "large", dialect: "junit-xml/v1", bytes: new Uint8Array(2 * 1024 * 1024).fill(32) }] });
    await refused(supervisor.submit(input).result, "source_timeout");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await supervisor.shutdown(); }
});
test("import deadline includes queue wait and leaves no active process after shutdown", async () => {
  const pids: number[] = [];
  const supervisor = new EvidenceSupervisor({ maxImportMs: 100, workerFactory: () => { const child = fixtureProcess("setInterval(() => {}, 1000)"); pids.push(child.pid); return child; } });
  const handles = ["a", "b", "queued"].map(id => supervisor.submit(request(id)));
  const results = handles.map(handle => handle.result.catch(error => error));
  const outcomes = await Promise.all(results);
  for (const error of outcomes) expect(error.code).toBe("import_timeout");
  await supervisor.shutdown();
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  expect(supervisor.state).toEqual({ active: 0, queued: 0, closed: true });
  expect(() => supervisor.submit(request("closed"))).toThrow("shutdown");
});
test("a stale token or scope generation cannot return accepted worker output", async () => {
  let current = true;
  const supervisor = new EvidenceSupervisor({ workerFactory: () => { current = false; return spawnEvidenceWorker(); } });
  try { await refused(supervisor.submit(request("stale", { isCurrent: () => current })).result, "stale_publication"); }
  finally { await supervisor.shutdown(); }
});
test("wrong response identity and excessive worker output are killed and refused", async () => {
  const normalized = parseExternalEvidence(new TextEncoder().encode(xml), "junit-xml/v1", "one");
  for (const source of [`console.log(${JSON.stringify(JSON.stringify({ version: 1, id: "wrong", normalized }))})`, 'process.stdout.write("x".repeat(5*1024*1024)); setInterval(() => {},1000)']) {
    let pid = 0;
    const supervisor = new EvidenceSupervisor({ workerFactory: () => { const child = fixtureProcess(source); pid = child.pid; return child; } });
    try { await refused(supervisor.submit(request("invalid")).result, "worker_protocol"); expect(() => process.kill(pid, 0)).toThrow(); }
    finally { await supervisor.shutdown(); }
  }
});
test("byte admission copies mutable input and rejects source/import count excess", async () => {
  const supervisor = new EvidenceSupervisor();
  try {
    const input = request("frozen"), submitted = supervisor.submit(input);
    input.sources[0].bytes.fill(0);
    expect((await submitted.result).sources[0].reportOutcome).toBe("reports_pass");
    expect(() => supervisor.submit(request("oversize", { sources: [{ sourceId: "x", dialect: "junit-xml/v1", bytes: new Uint8Array(2 * 1024 * 1024 + 1) }] }))).toThrow("input_limit");
    expect(() => supervisor.submit(request("many", { sources: Array.from({ length: 33 }, (_, index) => ({ sourceId: `s${index}`, dialect: "junit-xml/v1", bytes: new Uint8Array() })) }))).toThrow("input_limit");
  } finally { await supervisor.shutdown(); }
});
test("daemon supervisor identity is shared, independent of caller or database scope", () => {
  expect(getEvidenceSupervisor()).toBe(getEvidenceSupervisor());
});
test("hidden oversized byte length is rejected before caller copy hooks or worker admission", async () => {
  let reads = 0, copies = 0, launches = 0;
  const bytes = new Uint8Array(2 * 1024 * 1024 + 1);
  Object.defineProperty(bytes, "byteLength", { get() { reads++; return 1; } });
  Object.defineProperty(bytes, "slice", { value() { copies++; return new TextEncoder().encode(xml); } });
  const supervisor = new EvidenceSupervisor({ workerFactory: () => { launches++; throw new Error("must not start"); } });
  try {
    expect(() => { const handle = supervisor.submit(request("hidden-length", { sources: [{ sourceId: "one", dialect: "junit-xml/v1", bytes }] }));
      void handle.result.catch(() => {}); handle.cancel(); }).toThrow("input_limit");
    expect(reads).toBe(0); expect(copies).toBe(0); expect(launches).toBe(0);
    expect(supervisor.state).toEqual({ active: 0, queued: 0, closed: false });
  } finally { await supervisor.shutdown(); }
});
test("actual cumulative bytes are bounded before copying despite forged source lengths", async () => {
  let reads = 0, copies = 0, launches = 0;
  const sources = Array.from({ length: 5 }, (_, index) => {
    const bytes = new Uint8Array(2 * 1024 * 1024);
    Object.defineProperty(bytes, "byteLength", { get() { reads++; return 0; } });
    Object.defineProperty(bytes, "slice", { value() { copies++; return new Uint8Array(); } });
    return { sourceId: `source-${index}`, dialect: "junit-xml/v1", bytes };
  });
  const supervisor = new EvidenceSupervisor({ workerFactory: () => { launches++; throw new Error("must not start"); } });
  try {
    expect(() => { const handle = supervisor.submit(request("aggregate-bytes", { sources })); void handle.result.catch(() => {}); handle.cancel(); }).toThrow("input_limit");
    expect(reads).toBe(0); expect(copies).toBe(0); expect(launches).toBe(0);
  } finally { await supervisor.shutdown(); }
});
test("counterfeit and proxy byte arrays cannot invoke traps or enter the queue", async () => {
  let traps = 0;
  const fake = Object.create(Uint8Array.prototype);
  Object.defineProperty(fake, "byteLength", { get() { traps++; return 1; } });
  Object.defineProperty(fake, "slice", { value() { traps++; return new Uint8Array(); } });
  const proxy = new Proxy(new Uint8Array(1), { get() { traps++; throw new Error("caller trap"); }, getPrototypeOf() { traps++; throw new Error("caller trap"); } });
  const supervisor = new EvidenceSupervisor();
  try {
    for (const bytes of [fake, proxy, new Uint16Array(1)]) {
      expect(() => { const handle = supervisor.submit(request("invalid-bytes", { sources: [{ sourceId: "one", dialect: "junit-xml/v1", bytes }] }));
        void handle.result.catch(() => {}); handle.cancel(); }).toThrow("input_limit");
    }
    expect(traps).toBe(0); expect(supervisor.state.active).toBe(0);
  } finally { await supervisor.shutdown(); }
});
test("genuine bytes with poisoned methods and species still reach real workers without caller hooks", async () => {
  let reads = 0, copies = 0, species = 0;
  class HostileBytes extends Uint8Array { static get [Symbol.species](): Uint8ArrayConstructor { species++; throw new Error("caller species"); } }
  const raw = new TextEncoder().encode(xml), first = raw.slice();
  Object.defineProperty(first, "slice", { value() { copies++; throw new Error("caller slice"); } });
  const inputs = [first, new HostileBytes(raw)];
  for (const bytes of inputs) Object.defineProperty(bytes, "byteLength", { get() { reads++; return 0; } });
  const supervisor = new EvidenceSupervisor();
  try {
    for (const bytes of inputs) {
      const result = await supervisor.submit(request("genuine-bytes", { sources: [{ sourceId: "one", dialect: "junit-xml/v1", bytes }] })).result;
      expect(result.sources[0].reportOutcome).toBe("reports_pass");
      expect(() => process.kill(result.workers[0].pid, 0)).toThrow();
    }
    expect(reads).toBe(0); expect(copies).toBe(0); expect(species).toBe(0);
  } finally { await supervisor.shutdown(); }
});
test("queued Buffer reports retain an owned snapshot after caller mutation", async () => {
  let blocked = true;
  const supervisor = new EvidenceSupervisor({ workerFactory: () => blocked ? fixtureProcess("setInterval(() => {}, 1000)") : spawnEvidenceWorker() });
  const blockers = [supervisor.submit(request("block-one")), supervisor.submit(request("block-two"))];
  const stopped = blockers.map(handle => handle.result.catch(error => error));
  const bytes = Buffer.from(xml), queued = supervisor.submit(request("buffer", { sources: [{ sourceId: "one", dialect: "junit-xml/v1", bytes }] }));
  try {
    bytes.fill(0); blocked = false;
    for (const handle of blockers) handle.cancel();
    await Promise.all(stopped);
    const result = await queued.result;
    expect(result.sources[0].reportOutcome).toBe("reports_pass");
    expect(() => process.kill(result.workers[0].pid, 0)).toThrow();
  } finally { queued.cancel(); await supervisor.shutdown(); }
});
test("valid source workers cannot multiply the whole import's normalized-byte or leaf budget", async () => {
  const sourceBytes = Buffer.byteLength(JSON.stringify(parseExternalEvidence(new TextEncoder().encode(xml), "junit-xml/v1", "one")));
  for (const limits of [{ maxNormalizedBytes: sourceBytes + 128 }, { maxLeaves: 1 }]) {
    const pids: number[] = [];
    const supervisor = new EvidenceSupervisor({ limits, workerFactory: () => { const child = spawnEvidenceWorker(); pids.push(child.pid); return child; } });
    try {
      await refused(supervisor.submit(request("aggregate", { sources: ["one", "two"].map(sourceId =>
        ({ sourceId, dialect: "junit-xml/v1", bytes: new TextEncoder().encode(xml) })) })).result, "input_limit");
      expect(pids).toHaveLength(2);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      expect(supervisor.state.active).toBe(0);
    } finally { await supervisor.shutdown(); }
  }
});
test("shutdown cancels live and queued work and waits for actual owned process exit", async () => {
  const pids: number[] = [];
  const supervisor = new EvidenceSupervisor({ workerFactory: () => { const child = fixtureProcess("while(true) {} "); pids.push(child.pid); return child; } });
  const handles = ["one", "two", "queued"].map(id => supervisor.submit(request(id)));
  const outcomes = handles.map(handle => handle.result.catch(error => error));
  await supervisor.shutdown();
  for (const result of await Promise.all(outcomes)) expect(result.code).toBe("shutdown");
  expect(pids).toHaveLength(2);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  expect(supervisor.state).toEqual({ active: 0, queued: 0, closed: true });
});
