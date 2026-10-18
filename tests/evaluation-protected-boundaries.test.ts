import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { DatasetRevision, Experiment, Rule, Snapshot } from "../src/evaluations/protocol";
import type { EvaluationReport } from "../src/evaluations/report";

let directory: string, base: string, daemon: ChildProcess;
let traceNumber = 0;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 25));
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function startDaemon() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("RUNPHANTOM_") && key !== "ANTHROPIC_API_KEY" && key !== "OPENAI_API_KEY"));
  daemon = spawn("bun", ["src/index.ts", "serve"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...inherited, HOME: directory, USERPROFILE: directory, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "",
      RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_DB_PATH: path.join(directory, "evidence.db"),
      RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json"), RUNPHANTOM_CLAUDE_CLI_CHAT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  daemon.stderr?.on("data", data => { errors = (errors + String(data)).slice(-4000); });
  for (let i = 0; i < 200; i++) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error(`Daemon exited: ${errors}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* Wait for this isolated listener. */ }
    await pause();
  }
  throw new Error(`Daemon did not become healthy: ${errors}`);
}
async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  const closed = once(daemon, "close");
  daemon.kill("SIGTERM");
  const deadline = setTimeout(() => daemon.kill("SIGKILL"), 2500);
  try { await closed; } finally { clearTimeout(deadline); }
}
beforeAll(async () => { directory = mkdtempSync(path.join(tmpdir(), "rp-protected-http-")); await startDaemon(); }, 10_000);
afterAll(async () => { await stopDaemon(); rmSync(directory, { recursive: true, force: true }); });

async function request(route: string, data?: unknown, method = data === undefined ? "GET" : "POST") {
  return fetch(base + route, { method, headers: { "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
}
type CapturedTrace = ReturnType<typeof trace>;
function trace(input = "Question", output = "Answer", tools: Array<[string, number, number]> = [], orphan = false) {
  const id = (++traceNumber).toString(16).padStart(32, "0");
  const root = "0000000000000001";
  const timestamp = (ms: number) => String((1_780_000_000_000n + BigInt(ms)) * 1_000_000n);
  const text = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const span = (slot: number, name: string, begin: number, end: number, attributes: ReturnType<typeof text>[], parentSpanId?: string) => ({
    traceId: id, spanId: slot.toString(16).padStart(16, "0"), parentSpanId, name, kind: 1,
    startTimeUnixNano: timestamp(begin), endTimeUnixNano: timestamp(end), status: { code: 1 }, attributes,
  });
  const spans = [span(1, "Protected boundary", 0, 100, [text("runphantom.span.kind", "agent_root"),
    text("runphantom.input", input), text("runphantom.output", output)]),
  ...tools.map(([name, begin, end], i) => span(i + 2, name, begin, end,
    [text("ai.operationId", "ai.toolCall"), text("ai.toolCall.name", name)], orphan ? "fffffffffffffff0" : root))];
  return { id, body: { resourceSpans: [{ scopeSpans: [{ spans }] }] } };
}
async function ingest(captured: CapturedTrace) {
  expect((await request("/v1/traces", captured.body)).status).toBe(200);
  return captured.id;
}
async function dataset(runId: string, rules: Rule[], name = "Protected case") {
  const created = await request("/api/evaluations/datasets", { name }); expect(created.status).toBe(201);
  const initial = await created.json() as DatasetRevision;
  const updated = await request(`/api/evaluations/datasets/${initial.datasetId}`, {
    expectedVersion: initial.version, cases: [{ name, sourceRunId: runId, rules }],
  }, "PUT");
  expect(updated.status).toBe(201); return updated.json() as Promise<DatasetRevision>;
}
async function evaluate(revision: DatasetRevision, runId: string) {
  const started = await request("/api/evaluations/experiments", { datasetId: revision.datasetId, version: revision.version,
    name: "Protected experiment", assignments: [{ caseId: revision.cases[0].id, runId }] });
  expect(started.status).toBe(202);
  const initial = await started.json() as Experiment;
  for (let i = 0; i < 200; i++) {
    const response = await request(`/api/evaluations/experiments/${initial.id}`); expect(response.status).toBe(200);
    const current = await response.json() as Experiment;
    if (current.status === "completed") return current;
    await pause();
  }
  throw new Error("Experiment did not complete");
}
async function report(experiment: Experiment) {
  const response = await request(`/api/evaluations/experiments/${experiment.id}/report`);
  expect(response.status).toBe(200); return response.json() as Promise<EvaluationReport>;
}

test("R01/R02: actual OTLP graphs and repeated tool intervals retain unknown denominators and strict controls in reports", async () => {
  const good = await ingest(trace("Question", "Answer", [["lookup", 10, 20], ["lookup", 20, 25], ["save", 30, 40]]));
  const incomplete = await ingest(trace("Question", "Answer", [["lookup", 10, 20]], true));
  const overlap = await ingest(trace("Question", "Answer", [["lookup", 10, 35], ["lookup", 20, 40], ["save", 30, 50]]));
  const missingOccurrence = await ingest(trace("Question", "Answer", [["lookup", 10, 20], ["save", 30, 40]]));
  const revision = await dataset(good, [{ kind: "output", operation: "equals", value: "Answer" },
    { kind: "tools", operation: "sequence", names: ["lookup", "lookup", "save"] }]);
  for (const [runId, verdict] of [[good, "pass"], [incomplete, "inconclusive"], [overlap, "inconclusive"], [missingOccurrence, "fail"]] as const) {
    const done = await evaluate(revision, runId), exported = await report(done);
    expect(done.verdict).toBe(verdict);
    expect(exported.summary).toEqual({ total: 1, pass: Number(verdict === "pass"), fail: Number(verdict === "fail"),
      inconclusive: Number(verdict === "inconclusive"), passRate: Number(verdict === "pass") });
    expect(exported.gate.pass).toBe(verdict === "pass");
    if (runId === incomplete) {
      expect(done.results[0].snapshot.warnings).toContain("Trace ancestry is missing, duplicated, orphaned or cyclic.");
      expect(done.results[0].checks.every(check => check.status === "inconclusive" && check.score === null)).toBe(true);
    }
    if (runId === overlap) expect(done.results[0].checks[1].reason).toContain("overlap");
    expect(exported.cases[0].checks.every(check => check.evaluatorVersion === "code:2")).toBe(true);
  }
}, 15_000);

test("R03: captured numeric text and exact string IDs stay distinct through API equality and evaluator-version export", async () => {
  for (const [token, rounded] of [["9007199254740993", 9007199254740992], ["1e-400", 0], ["1e400", null]] as const) {
    const textOutput = JSON.stringify({ id: token }), numericOutput = `{"id":${token}}`;
    const textId = await ingest(trace("Question", textOutput)), numericId = await ingest(trace("Question", numericOutput));
    const revision = await dataset(textId, [{ kind: "output", operation: "equals", value: textOutput },
      { kind: "jsonPath", path: "id", equals: token }], `Exact string ${token}`);
    const exact = await evaluate(revision, textId); expect(exact.verdict).toBe("pass");
    expect(exact.results[0].checks.map(check => [check.actual, check.score])).toEqual([[textOutput, 1], [token, 1]]);
    const textRule = await dataset(numericId, [{ kind: "output", operation: "equals", value: numericOutput },
      { kind: "json" }, { kind: "jsonPath", path: "id", equals: rounded }], `Captured numeric ${token}`);
    const lossy = await evaluate(textRule, numericId);
    expect(lossy.results[0].checks.map(check => check.status)).toEqual(["pass", "pass", "inconclusive"]);
    expect(lossy.results[0].snapshot.output.value).toBe(numericOutput);
    expect(lossy.results[0].checks[2]).toMatchObject({ score: null, evaluatorVersion: "code:2" });
    expect((await report(lossy)).cases[0].checks[2]).toMatchObject({ status: "inconclusive", evaluatorVersion: "code:2" });
    if (token === "9007199254740993") {
      const historical = await evaluate(textRule, numericId);
      await stopDaemon();
      const db = new Database(path.join(directory, "evidence.db"));
      try {
        // Only the persisted version marker changes in this historical compatibility fixture.
        db.query("UPDATE evaluation_experiments SET data=json_set(data, '$.results[0].checks[0].evaluatorVersion', 'code:1') WHERE id=?").run(historical.id);
      } finally { db.close(); }
      await startDaemon();
      const older = await report(historical), oldDigest = digest(JSON.stringify(older));
      expect(older.cases[0].checks[0].evaluatorVersion).toBe("code:1");
      const compared = await request(`/api/evaluations/compare?baseline=${historical.id}&candidate=${lossy.id}`);
      expect(compared.status).toBe(409);
      expect(await compared.json()).toEqual({ error: "Comparison requires completed experiments with identical dataset revisions and evaluator versions" });
      expect(digest(JSON.stringify(await report(historical)))).toBe(oldDigest);
      expect((await report(lossy)).cases[0].checks[0].evaluatorVersion).toBe("code:2");
    }
  }
}, 15_000);

test("R04/R05: multimodal loss and complete text controls retain frozen identities and report digests after source edits and actual daemon restart", async () => {
  const prompt = (image: string) => JSON.stringify([{ role: "user", content: [{ type: "text", text: "Describe this" }, { type: "image", image }] }]);
  const sourceTrace = trace(prompt("cat.png")), candidateTrace = trace(prompt("dog.png"));
  await ingest(sourceTrace); await ingest(candidateTrace);
  const images = await dataset(sourceTrace.id, [{ kind: "output", operation: "equals", value: "Answer" }], "Unavailable image identity");
  const unknown = await evaluate(images, candidateTrace.id);
  expect(images.cases[0].input).toBeNull();
  expect(unknown.results[0]).toMatchObject({ inputMatch: "unavailable", status: "inconclusive", snapshot: { input: null } });
  expect(unknown.results[0].checks[0]).toMatchObject({ score: null, evaluatorVersion: "code:2" });
  const textTrace = trace("Describe this"), textId = await ingest(textTrace);
  const identicalTextTrace = trace("Describe this"), identicalText = await ingest(identicalTextTrace);
  const textRevision = await dataset(textId, [{ kind: "output", operation: "equals", value: "Answer" }], "Text positive control");
  const passed = await evaluate(textRevision, identicalText);
  expect(passed.results[0]).toMatchObject({ inputMatch: "match", status: "pass", snapshot: { input: "Describe this", output: { value: "Answer" } } });
  expect(passed.results[0].checks[0].score).toBe(1);
  const frozen = [unknown, passed];
  const hashes = await Promise.all(frozen.map(async item => digest(JSON.stringify(await report(item)))));
  for (const captured of [sourceTrace, candidateTrace, textTrace, identicalTextTrace]) {
    captured.body.resourceSpans[0].scopeSpans[0].spans[0].attributes = [
      { key: "runphantom.span.kind", value: { stringValue: "agent_root" } },
      { key: "runphantom.input", value: { stringValue: "Describe this" } },
      { key: "runphantom.output", value: { stringValue: "Changed later" } },
    ];
    await ingest(captured);
  }
  const latest = await request(`/api/evaluations/runs/${candidateTrace.id}/snapshot`);
  expect((await latest.json() as Snapshot).input).toBe("Describe this");
  const changed = await request(`/api/evaluations/datasets/${textRevision.datasetId}`, { expectedVersion: textRevision.version,
    cases: [{ id: textRevision.cases[0].id, name: "Edited later", input: "Describe this", rules: [{ kind: "output", operation: "equals", value: "Changed later" }] }] }, "PUT");
  expect(changed.status).toBe(201);
  const newRevision = await changed.json() as DatasetRevision, newer = await evaluate(newRevision, textId);
  expect(newer).toMatchObject({ datasetVersion: textRevision.version + 1, datasetHash: newRevision.hash, verdict: "pass" });
  expect(newer.results[0]).toMatchObject({ caseName: "Edited later", snapshot: { output: { value: "Changed later" } } });
  for (let i = 0; i < frozen.length; i++) expect(digest(JSON.stringify(await report(frozen[i])))).toBe(hashes[i]);
  await stopDaemon(); await startDaemon();
  for (let i = 0; i < frozen.length; i++) {
    const fetched = await request(`/api/evaluations/experiments/${frozen[i].id}`);
    expect(await fetched.json()).toEqual(frozen[i]);
    expect(digest(JSON.stringify(await report(frozen[i])))).toBe(hashes[i]);
  }
  const oldRevision = await request(`/api/evaluations/datasets/${textRevision.datasetId}?version=${textRevision.version}`);
  expect(oldRevision.status).toBe(200); expect(await oldRevision.json()).toEqual(textRevision);
}, 20_000);

test("R06: two actual HTTP clients reject valid stale edits without publishing an extra revision or bypassing rule validation", async () => {
  const source = await ingest(trace()), revision = await dataset(source, [{ kind: "output", operation: "equals", value: "Answer" }]);
  const endpoint = `/api/evaluations/datasets/${revision.datasetId}`;
  const clients = await Promise.all([request(endpoint), request(endpoint)]);
  const [a, b] = await Promise.all(clients.map(response => response.json() as Promise<DatasetRevision>));
  expect(a).toEqual(b);
  const edit = (read: DatasetRevision, name: string, rules: Rule[] = read.cases[0].rules) => ({ expectedVersion: read.version,
    cases: [{ id: read.cases[0].id, name, input: "Question", rules }] });
  const saved = await request(endpoint, edit(a, "Client A saved"), "PUT"); expect(saved.status).toBe(201);
  const accepted = await saved.json() as DatasetRevision;
  const stale = await request(endpoint, edit(b, "Client B stale"), "PUT"); expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "Dataset changed; reload before saving" });
  expect(await (await request(endpoint)).json()).toEqual(accepted);
  expect((await request(`${endpoint}?version=${accepted.version + 1}`)).status).toBe(404);
  for (const rules of [[], [{ kind: "output", operation: "contains", value: "" }] as Rule[]]) {
    expect((await request(endpoint, edit(accepted, "Invalid rules", rules), "PUT")).status).toBe(400);
    expect(await (await request(endpoint)).json()).toEqual(accepted);
  }
}, 10_000);
