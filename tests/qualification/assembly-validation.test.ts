import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FEATURES, CASE_OWNERS, createManifest, fullCells, HOSTS, requiredInvariants, type Artifact, type Cell, type Manifest, type Receipt, type IndependentReview } from "../../scripts/qualification/assembled-contracts";
import { aggregateAssembly, canonical, parseQualificationJson, readQualificationBytes, sha256, validateManifest, validateReceipt, verifyArtifact } from "../../scripts/qualification/assembled-validation";

async function rejects(operation: Promise<unknown>, message?: string): Promise<void> {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  if (message) expect((caught as Error).message).toContain(message);
}

const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
const source = { sha: "a".repeat(40), tree: "b".repeat(40) };
const manifestHash = "e".repeat(64);
const controlOutputHash = sha256(JSON.stringify({ actual: "known-control", count: 2 }));
const currentHost = { platform: process.platform, arch: process.arch } as Receipt["host"];
function completeManifest(): Manifest {
  const m = createManifest(source);
  m.features.forEach((f, i) => { f.head = (i + 1).toString(16).padStart(40, "0"); });
  m.cells.forEach(c => { c.expectedTests = [`actual/${c.id}`]; c.expectedOutputs = [{ id: "known-control-output", sha256: controlOutputHash }]; if (c.engine) c.enginePin = { version: "control", sha256: controlOutputHash }; });
  m.profiles.forEach(p => { p.runtimeVersion = "control-not-native-proof"; p.artifactSha256 = controlOutputHash; p.resourceSha256 = [controlOutputHash]; p.database = { engineVersion: "control", engineSourceId: "control-source-id", busyTimeout: 5000, journalMode: "wal", synchronous: 2, foreignKeys: 1 }; });
  return m;
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "phantom-assembly-control-")); directories.push(root);
  const put = async (name: string, body: string): Promise<Artifact> => {
    await writeFile(path.join(root, name), body); return { path: name, bytes: Buffer.byteLength(body), sha256: sha256(body) };
  };
  const output = await put("observed.json", JSON.stringify({ actual: "known-control", count: 2 }));
  const receipt = (cell: Cell): Receipt => ({ schema: "runphantom.assembly-receipt/v1", cellId: cell.id, stage: cell.stage,
    scope: "product", source, host: cell.host ?? currentHost, manifestSha256: manifestHash,
    execution: { command: [process.execPath, "actual-control.ts"], exitCode: 0, timedOut: false, signal: null,
      startedAt: "2026-10-18T00:00:00Z", finishedAt: "2026-10-18T00:00:01Z", log: output },
    expectedTests: cell.expectedTests!, tests: cell.expectedTests!.map(id => ({ id, status: "passed", attempt: 0 })),
    invariants: requiredInvariants(cell).map(id => ({ id, passed: true, artifact: output })),
    outputs: [{ id: "known-control-output", actual: output, expectedSha256: output.sha256 }],
    runtime: cell.stage === "component" ? null : { mode: cell.stage === "source" || cell.profile === "source-backend" ? "source" : "installed",
      runtimeVersion: "control-not-native-proof", artifact: output,
      database: { engineVersion: "control", engineSourceId: "control-source-id", busyTimeout: 5000, journalMode: "wal", synchronous: 2, foreignKeys: 1, observedByApplication: true },
      restart: { firstPid: 10, secondPid: 20, firstClosed: true, sameDatabase: true, before: output.sha256, after: output.sha256 },
      resources: [output], outsideCheckout: true, noSourceFallback: true,
      engine: cell.engine ? { name: cell.engine, version: "control", executable: output } : null },
    provider: cell.stage === "provider" ? { meteredLive: true, provider: "control-not-live", operationId: "control", usageKnown: true, usage: output, budget: output } : null,
    cleanup: { allOwnedClosed: true, profilesRemoved: true } });
  let count = 0;
  const submit = async (r: Receipt) => ({ receipt: r, artifact: await put(`receipt-${count++}.json`, JSON.stringify(r)) });
  return { root, output, put, receipt, submit };
}
test("canonical plan contains all50 IDs, all49 F45 prerequisites and all59 original/adoption contracts", () => {
  const m = createManifest(source);
  expect(FEATURES).toHaveLength(50); expect(new Set(FEATURES.map(f => f.id)).size).toBe(50);
  expect(m.features.find(f => f.id === "F45")!.dependencies).toHaveLength(49);
  expect(Object.keys(CASE_OWNERS)).toHaveLength(59); expect(HOSTS).toHaveLength(5);
  expect(fullCells().filter(c => c.engine)).toHaveLength(15);
  expect(validateManifest(m)).toBe(m);
});
test("feature omissions, duplicate IDs, weakened dependencies and reduced cell selection are refused", () => {
  for (const mutate of [(m: Manifest) => m.features.pop(), (m: Manifest) => { m.features[1].id = "F00"; },
    (m: Manifest) => { m.features.find(f => f.id === "F45")!.dependencies.pop(); }, (m: Manifest) => m.cells.pop(),
    (m: Manifest) => { m.cells[0].stage = "assembled"; }]) {
    const m = completeManifest(); mutate(m); expect(() => validateManifest(m)).toThrow();
  }
});
test("JSON rejects duplicate/escaped keys, lossy integers, underflow, nonfinite and oversized nesting", () => {
  for (const body of ['{"sha":1,"sha":2}', '{"sha":1,"sh\\u0061":2}', '{"n":9007199254740993}', '{"n":1e-999}', '{"n":1e999}', '['.repeat(65) + '0' + ']'.repeat(65)]) {
    expect(() => parseQualificationJson(Buffer.from(body))).toThrow();
  }
  expect(parseQualificationJson(Buffer.from('{"zero":0,"value":"9007199254740993"}'))).toEqual({ zero: 0, value: "9007199254740993" });
});
test("missing feature heads and unrun cells remain concrete blockers rather than passing by omission", async () => {
  const f = await fixture(), m = createManifest(source);
  const result = await aggregateAssembly(m, manifestHash, [], f.root, new Set());
  expect(result.verdict).toBe("BLOCKED"); expect(result.releaseQualified).toBe(false);
  expect(result.blockers.filter(b => b.code === "assembly_feature_not_in_candidate")).toHaveLength(50);
  expect(result.blockers.filter(b => b.code === "assembly_missing_cell")).toHaveLength(m.cells.length);
});
test("complete known-good synthetic records establish checks-only and cannot impersonate independent native/provider acceptance", async () => {
  const f = await fixture(), m = completeManifest();
  const submissions = await Promise.all(m.cells.map(c => f.submit(f.receipt(c))));
  const result = await aggregateAssembly(m, manifestHash, submissions, f.root, new Set(m.features.map(f => f.head!)));
  expect(result.checksComplete).toBe(true); expect(result.verdict).toBe("CHECKS_ONLY"); expect(result.releaseQualified).toBe(false);
  expect(result.blockers.every(b => b.code === "assembly_independent_review_required")).toBe(true);
});
for (const status of ["failed", "skipped", "uncollected"] as const) test(`actual ${status} node cannot fill a selected cell`, async () => {
  const f = await fixture(), m = completeManifest(), cell = m.cells[0], r = f.receipt(cell); r.tests[0].status = status;
  await rejects(validateReceipt(f.root, await f.submit(r), cell, m, manifestHash), "assembly_roster_not_passed");
});
for (const mutation of ["missing", "extra", "duplicate", "retry", "empty-expected"] as const) test(`frozen roster refuses ${mutation}`, async () => {
  const f = await fixture(), m = completeManifest(), c = m.cells[0], r = f.receipt(c);
  if (mutation === "missing") r.tests = [];
  if (mutation === "extra") r.tests.push({ id: "not-collected", status: "passed", attempt: 0 });
  if (mutation === "duplicate") r.tests.push(r.tests[0]);
  if (mutation === "retry") r.tests[0].attempt = 1;
  if (mutation === "empty-expected") { c.expectedTests = null; r.expectedTests = []; r.tests = []; }
  await rejects(validateReceipt(f.root, await f.submit(r), c, m, manifestHash), "assembly_roster_not_passed");
});
test("stale source/tree or altered manifest pin cannot reuse a receipt", async () => {
  const f = await fixture(), m = completeManifest(), c = m.cells[0];
  for (const field of ["sha", "tree", "manifest"] as const) {
    const r = f.receipt(c); if (field === "manifest") r.manifestSha256 = "0".repeat(64); else r.source = { ...r.source, [field]: "0".repeat(40) };
    await rejects(validateReceipt(f.root, await f.submit(r), c, m, manifestHash), "assembly_stale_source_or_manifest");
  }
});
test("artifact byte tampering and receipt-object substitution fail closed", async () => {
  const f = await fixture(), m = completeManifest(), c = m.cells[0], submitted = await f.submit(f.receipt(c));
  submitted.receipt.execution.exitCode = 1;
  await rejects(validateReceipt(f.root, submitted, c, m, manifestHash), "assembly_receipt_object_mismatch");
  await writeFile(path.join(f.root, f.output.path), "tamper");
  await rejects(verifyArtifact(f.root, f.output), "assembly_artifact_tampered");
});
test("relative traversal and symlink escape cannot borrow evidence outside the bundle", async () => {
  const f = await fixture(), other = await fixture(); await symlink(path.join(other.root, other.output.path), path.join(f.root, "escape"));
  await rejects(verifyArtifact(f.root, { ...f.output, path: "../observed.json" }), "assembly_artifact_shape");
  await rejects(verifyArtifact(f.root, { ...other.output, path: "escape" }), "assembly_artifact_path");
});
test("component controls and host mismatches cannot escalate to installed/platform proof", async () => {
  const f = await fixture(), m = completeManifest(), c = m.cells.find(c => !!c.engine)!, r = f.receipt(c);
  r.scope = "control";
  await rejects(validateReceipt(f.root, await f.submit(r), c, m, manifestHash), "assembly_control_scope_escalation");
  r.scope = "product"; r.host = HOSTS.find(h => canonical(h) !== canonical(c.host))!;
  await rejects(validateReceipt(f.root, await f.submit(r), c, m, manifestHash), "assembly_wrong_cell_or_host");
});
for (const kind of ["database", "restart", "resource", "engine", "fallback"] as const) test(`installed ${kind} evidence is mandatory`, async () => {
  const f = await fixture(), m = completeManifest(), c = m.cells.find(c => !!c.engine)!, r = f.receipt(c), runtime = r.runtime!;
  if (kind === "database") runtime.database.observedByApplication = false;
  if (kind === "restart") runtime.restart.firstClosed = false;
  if (kind === "resource") runtime.resources = [];
  if (kind === "engine") runtime.engine = null;
  if (kind === "fallback") runtime.noSourceFallback = false;
  await rejects(validateReceipt(f.root, await f.submit(r), c, m, manifestHash));
});
test("offline usage arithmetic cannot fill a live provider cell", async () => {
  const f = await fixture(), m = completeManifest(), c = m.cells.find(c => c.stage === "provider")!, r = f.receipt(c);
  r.provider!.meteredLive = false;
  await rejects(validateReceipt(f.root, await f.submit(r), c, m, manifestHash), "assembly_provider_unmeasured");
});
test("nonzero, timeout, primary signal, missing output, invariant and cleanup failures remain blockers", async () => {
  const f = await fixture(), m = completeManifest(), c = m.cells[0];
  for (const mutate of [(r: Receipt) => { r.execution.exitCode = 1; }, (r: Receipt) => { r.execution.timedOut = true; },
    (r: Receipt) => { r.execution.signal = "SIGTERM"; }, (r: Receipt) => { r.outputs = []; }, (r: Receipt) => { r.invariants.pop(); },
    (r: Receipt) => { r.cleanup.allOwnedClosed = false; }, (r: Receipt) => { r.outputs[0].expectedSha256 = "0".repeat(64); }]) {
    const r = f.receipt(c); mutate(r); await rejects(validateReceipt(f.root, await f.submit(r), c, m, manifestHash));
  }
});
test("duplicate cells are rejected even when both receipts pass individually", async () => {
  const f = await fixture(), m = completeManifest(), a = await f.submit(f.receipt(m.cells[0]));
  const result = await aggregateAssembly(m, manifestHash, [a, a], f.root, new Set(m.features.map(f => f.head!)));
  expect(result.blockers).toContainEqual({ cellId: m.cells[0].id, code: "assembly_duplicate_cell" });
});
test("independent review must bind exact receipt, source, host and stage", async () => {
  const f = await fixture(), m = completeManifest(), submitted = await f.submit(f.receipt(m.cells[0]));
  const review: IndependentReview = { cellId: m.cells[0].id, receiptSha256: submitted.artifact.sha256, source, host: submitted.receipt.host, stage: "assembled", decision: "approved" };
  const result = await aggregateAssembly(m, manifestHash, [submitted], f.root, new Set(m.features.map(f => f.head!)), [review]);
  expect(result.stages.component.accepted).toBe(0);
  expect(result.blockers).toContainEqual({ cellId: m.cells[0].id, code: "assembly_independent_review_required" });
  expect(JSON.parse(await readFile(path.join(f.root, submitted.artifact.path), "utf8"))).toHaveProperty("cellId", m.cells[0].id);
});

test("receipts cannot redefine frozen output or runtime/artifact expectations", async () => {
  const f = await fixture(), m = completeManifest(), c = m.cells[0], r = f.receipt(c);
  c.expectedOutputs![0].sha256 = "0".repeat(64);
  await rejects(validateReceipt(f.root, await f.submit(r), c, m, manifestHash), "assembly_output_mismatch");
  const installed = m.cells.find(c => c.stage === "installed")!, installedReceipt = f.receipt(installed);
  installedReceipt.runtime!.runtimeVersion = "different-engine";
  await rejects(validateReceipt(f.root, await f.submit(installedReceipt), installed, m, manifestHash), "assembly_runtime_profile_mismatch");
  installedReceipt.runtime!.runtimeVersion = "control-not-native-proof";
  m.profiles.find(p => p.mode === "installed" && canonical(p.host) === canonical(installedReceipt.host))!.artifactSha256 = "0".repeat(64);
  await rejects(validateReceipt(f.root, await f.submit(installedReceipt), installed, m, manifestHash), "assembly_runtime_profile_mismatch");
});

test("oversized sparse qualification input is refused before JSON allocation", async () => {
  const f = await fixture(), file = path.join(f.root, "oversized.json");
  await writeFile(file, ""); await truncate(file, 256 * 1024 * 1024);
  await rejects(readQualificationBytes(file), "assembly_json_limit");
});
