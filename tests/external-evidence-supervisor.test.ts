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
