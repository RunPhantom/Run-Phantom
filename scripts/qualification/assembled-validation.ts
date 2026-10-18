import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileSha256 } from "../../app/tests-e2e/daemon-runtime";
import { hasDuplicateJsonKeys } from "../../src/json-keys";
import { parseJsonEvidence } from "../../src/evaluations/json-evidence";
import { CASE_OWNERS, FEATURES, HOSTS, STAGES, createManifest, hostId, requiredInvariants,
  type Artifact, type AssemblyResult, type Cell, type IndependentReview, type Manifest, type Receipt, type SubmittedReceipt } from "./assembled-contracts";

const digest = /^[a-f0-9]{64}$/;
const oid = /^[a-f0-9]{40}$/;
export const sha256 = (body: string | Buffer): string => createHash("sha256").update(body).digest("hex");
function refuse(code: string): never { throw new Error(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("assembly_object");
  return value as Record<string, unknown>;
}
function keys(value: unknown, names: string[]): void {
  if (Object.keys(object(value)).sort().join("\0") !== [...names].sort().join("\0")) refuse("assembly_fields");
}
function text(value: unknown, maximum = 1024): asserts value is string {
  if (typeof value !== "string" || !value || value.length > maximum || [...value].some(c => c.charCodeAt(0) < 32)) refuse("assembly_text");
}
function array(value: unknown, maximum = 4096): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) refuse("assembly_array");
}
function unique(values: string[]): boolean { return new Set(values).size === values.length; }
function sorted(values: readonly string[]): string { return [...values].sort().join("\0"); }
function pin(value: unknown): void {
  keys(value, ["sha", "tree"]); const p = value as Manifest["source"];
  if (!oid.test(p.sha) || !oid.test(p.tree)) refuse("assembly_source_pin");
}
function host(value: unknown): void {
  keys(value, ["platform", "arch"]);
  if (!HOSTS.some(h => h.platform === (value as Receipt["host"]).platform && h.arch === (value as Receipt["host"]).arch)) refuse("assembly_host");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function readQualificationBytes(file: string): Promise<Buffer> {
  if ((await stat(file)).size > 8 * 1024 * 1024) refuse("assembly_json_limit");
  const body = await readFile(file); if (body.length > 8 * 1024 * 1024) refuse("assembly_json_limit");
  return body;
}
export function parseQualificationJson(body: Buffer): unknown {
  if (body.length > 8 * 1024 * 1024) refuse("assembly_json_limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const parsed = parseJsonEvidence(text);
  if (hasDuplicateJsonKeys(text)) refuse("assembly_duplicate_json_key");
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) refuse("assembly_json_depth");
    if (value && typeof value === "object") for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(parsed, 0); return parsed;
}
export function validateManifest(value: unknown): Manifest {
  keys(value, ["schema", "source", "features", "cells", "profiles"]);
  const m = value as Manifest;
  if (m.schema !== "runphantom.assembly-manifest/v1") refuse("assembly_manifest_schema");
  pin(m.source); array(m.features, 50); array(m.cells, 1024); array(m.profiles, 10);
  if (m.profiles.length !== 10 || !unique(m.profiles.map(p => `${hostId(p.host)}/${p.mode}`))) refuse("assembly_profile_population");
  for (const profile of m.profiles) {
    keys(profile, ["host", "mode", "artifactSha256", "runtimeVersion", "database", "resourceSha256"]); host(profile.host);
    if (!["source", "installed"].includes(profile.mode) || profile.artifactSha256 !== null && !digest.test(profile.artifactSha256)) refuse("assembly_profile_pin");
    if (profile.runtimeVersion !== null) text(profile.runtimeVersion);
    if (profile.database !== null) {
      keys(profile.database, ["engineVersion", "engineSourceId", "busyTimeout", "journalMode", "synchronous", "foreignKeys"]); text(profile.database.engineVersion); text(profile.database.engineSourceId);
      if (!Number.isSafeInteger(profile.database.busyTimeout) || profile.database.busyTimeout < 0 || profile.database.busyTimeout > 2147483647) refuse("assembly_database_pin");
      if (!["wal", "delete", "truncate", "persist", "memory", "off"].includes(profile.database.journalMode) || ![0, 1, 2, 3].includes(profile.database.synchronous) || ![0, 1].includes(profile.database.foreignKeys)) refuse("assembly_database_pin");
    }
    array(profile.resourceSha256, 64); if (!unique(profile.resourceSha256) || profile.resourceSha256.some(d => !digest.test(d))) refuse("assembly_resource_pin");
  }
  if (m.features.length !== 50 || !unique(m.features.map(f => f.id))) refuse("assembly_feature_population");
  if (!unique(m.features.flatMap(f => f.head ? [f.head] : []))) refuse("assembly_duplicate_feature_head");
  for (const expected of FEATURES) {
    const f = m.features.find(f => f.id === expected.id); if (!f) refuse("assembly_feature_missing");
    keys(f, ["id", "dependencies", "head"]); array(f.dependencies, 49);
    if (!unique(f.dependencies) || sorted(f.dependencies) !== sorted(expected.dependencies)) refuse("assembly_dependencies");
    if (f.head !== null && !oid.test(f.head)) refuse("assembly_feature_head");
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) refuse("assembly_dependency_cycle");
    if (done.has(id)) return; visiting.add(id);
    for (const dependency of m.features.find(f => f.id === id)!.dependencies) visit(dependency);
    visiting.delete(id); done.add(id);
  };
  for (const f of m.features) visit(f.id);
  const expected = createManifest(m.source).cells;
  if (m.cells.length !== expected.length || !unique(m.cells.map(c => c.id))) refuse("assembly_cell_population");
  for (const c of m.cells) {
    keys(c, ["id", "stage", "features", "contracts", "host", "engine", "profile", "expectedTests", "enginePin", "expectedOutputs"]);
    const e = expected.find(e => e.id === c.id); if (!e) refuse("assembly_cell_unknown");
    if (canonical({ ...c, expectedTests: null, enginePin: null, expectedOutputs: null }) !== canonical(e)) refuse("assembly_cell_contract");
    if (c.enginePin !== null) {
      if (!c.engine) refuse("assembly_engine_pin"); keys(c.enginePin, ["version", "sha256"]); text(c.enginePin.version);
      if (!digest.test(c.enginePin.sha256)) refuse("assembly_engine_pin");
    }
    if (c.expectedOutputs !== null) {
      array(c.expectedOutputs, 64); if (!c.expectedOutputs.length || !unique(c.expectedOutputs.map(o => o.id))) refuse("assembly_output_pin");
      for (const output of c.expectedOutputs) { keys(output, ["id", "sha256"]); text(output.id); if (!digest.test(output.sha256)) refuse("assembly_output_pin"); }
    }
    if (c.expectedTests !== null) {
      array(c.expectedTests, 10000); for (const id of c.expectedTests) text(id);
      if (!c.expectedTests.length || !unique(c.expectedTests)) refuse("assembly_expected_roster");
    }
  }
  if (Object.keys(CASE_OWNERS).length !== 59) refuse("assembly_case_population");
  return m;
}
function artifactShape(value: unknown): asserts value is Artifact {
  keys(value, ["path", "sha256", "bytes"]); const a = value as Artifact;
  text(a.path, 4096);
  if (path.isAbsolute(a.path) || a.path.includes("\\") || a.path.split("/").some(s => s === ".." || s === "." || !s) || !digest.test(a.sha256)
    || !Number.isSafeInteger(a.bytes) || a.bytes < 0 || a.bytes > 512 * 1024 * 1024) refuse("assembly_artifact_shape");
}
export async function verifyArtifact(root: string, value: unknown): Promise<Buffer | null> {
  artifactShape(value); const base = await realpath(root), file = await realpath(path.join(base, value.path)), relative = path.relative(base, file);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) refuse("assembly_artifact_path");
  const meta = await stat(file);
  if (!meta.isFile() || meta.size !== value.bytes || await fileSha256(file) !== value.sha256) refuse("assembly_artifact_tampered");
  return value.bytes <= 8 * 1024 * 1024 ? await readFile(file) : null;
}
function receiptShape(value: unknown): asserts value is Receipt {
  keys(value, ["schema", "cellId", "stage", "scope", "source", "host", "manifestSha256", "execution", "expectedTests", "tests", "invariants", "outputs", "runtime", "provider", "cleanup"]);
  const r = value as Receipt; pin(r.source); host(r.host); text(r.cellId);
  if (r.schema !== "runphantom.assembly-receipt/v1" || !STAGES.includes(r.stage) || !["control", "product"].includes(r.scope) || !digest.test(r.manifestSha256)) refuse("assembly_receipt_schema");
  keys(r.execution, ["command", "exitCode", "timedOut", "signal", "startedAt", "finishedAt", "log"]);
  array(r.execution.command, 128); for (const s of r.execution.command) text(s, 8192);
  if (!r.execution.command.length || !Number.isInteger(r.execution.exitCode) && r.execution.exitCode !== null || typeof r.execution.timedOut !== "boolean"
    || r.execution.signal !== null && typeof r.execution.signal !== "string"
    || !Number.isFinite(Date.parse(r.execution.startedAt)) || !Number.isFinite(Date.parse(r.execution.finishedAt)) || Date.parse(r.execution.finishedAt) < Date.parse(r.execution.startedAt)) refuse("assembly_execution_shape");
  text(r.execution.startedAt); text(r.execution.finishedAt); artifactShape(r.execution.log);
  array(r.expectedTests, 10000); r.expectedTests.forEach(id => text(id));
  array(r.tests, 10000); for (const t of r.tests) {
    keys(t, ["id", "status", "attempt"]); text(t.id);
    if (!["passed", "failed", "skipped", "uncollected"].includes(t.status) || !Number.isSafeInteger(t.attempt) || t.attempt < 0) refuse("assembly_test_shape");
  }
  array(r.invariants, 64); for (const i of r.invariants) { keys(i, ["id", "passed", "artifact"]); text(i.id); if (typeof i.passed !== "boolean") refuse("assembly_invariant_shape"); artifactShape(i.artifact); }
  array(r.outputs, 64); for (const o of r.outputs) { keys(o, ["id", "actual", "expectedSha256"]); text(o.id); artifactShape(o.actual); if (!digest.test(o.expectedSha256)) refuse("assembly_output_shape"); }
  keys(r.cleanup, ["allOwnedClosed", "profilesRemoved"]);
  if (typeof r.cleanup.allOwnedClosed !== "boolean" || typeof r.cleanup.profilesRemoved !== "boolean") refuse("assembly_cleanup_shape");
}
async function verifyRuntime(root: string, r: Receipt, cell: Cell, manifest: Manifest): Promise<void> {
  if (cell.stage === "component") { if (r.runtime !== null || r.provider !== null) refuse("assembly_component_scope"); return; }
  const runtime = r.runtime; if (!runtime) refuse("assembly_runtime_missing");
  keys(runtime, ["mode", "runtimeVersion", "artifact", "database", "restart", "resources", "outsideCheckout", "noSourceFallback", "engine"]);
  text(runtime.runtimeVersion); if (!["source", "installed"].includes(runtime.mode)) refuse("assembly_runtime_mode");
  if ((cell.stage === "source" || cell.profile === "source-backend") && runtime.mode !== "source") refuse("assembly_source_scope");
  const installed = cell.stage === "installed" || cell.stage === "assembled" || cell.stage === "platform" && cell.profile !== "source-backend";
  if (installed && (runtime.mode !== "installed" || !runtime.outsideCheckout || !runtime.noSourceFallback || !runtime.artifact)) refuse("assembly_installed_scope");
  const profile = manifest.profiles.find(p => hostId(p.host) === hostId(r.host) && p.mode === runtime.mode);
  if (!profile?.runtimeVersion || !profile.database || !profile.resourceSha256.length || installed && !profile.artifactSha256) refuse("assembly_runtime_profile_unpinned");
  if (runtime.runtimeVersion !== profile.runtimeVersion || runtime.artifact && runtime.artifact.sha256 !== profile.artifactSha256) refuse("assembly_runtime_profile_mismatch");
  if (typeof runtime.outsideCheckout !== "boolean" || typeof runtime.noSourceFallback !== "boolean") refuse("assembly_runtime_shape");
  if (runtime.artifact) await verifyArtifact(root, runtime.artifact);
  keys(runtime.database, ["engineVersion", "engineSourceId", "busyTimeout", "journalMode", "synchronous", "foreignKeys", "observedByApplication"]);
  text(runtime.database.engineVersion); text(runtime.database.engineSourceId);
  if (!Number.isSafeInteger(runtime.database.busyTimeout) || runtime.database.busyTimeout < 0 || runtime.database.busyTimeout > 2147483647) refuse("assembly_database_evidence");
  if (runtime.database.observedByApplication !== true || !["wal", "delete", "truncate", "persist", "memory", "off"].includes(runtime.database.journalMode)
    || ![0, 1, 2, 3].includes(runtime.database.synchronous) || ![0, 1].includes(runtime.database.foreignKeys)) refuse("assembly_database_evidence");
  const { observedByApplication: _observedByApplication, ...database } = runtime.database;
  if (canonical(database) !== canonical(profile.database)) refuse("assembly_database_profile_mismatch");
  keys(runtime.restart, ["firstPid", "secondPid", "firstClosed", "sameDatabase", "before", "after"]);
  const restart = runtime.restart;
  if (![restart.firstPid, restart.secondPid].every(p => Number.isSafeInteger(p) && p > 0) || restart.firstPid === restart.secondPid || restart.firstClosed !== true || restart.sameDatabase !== true
    || !digest.test(restart.before) || restart.before !== restart.after) refuse("assembly_restart_evidence");
  array(runtime.resources, 64); if (!runtime.resources.length) refuse("assembly_resources_missing");
  if (sorted(runtime.resources.map(r => r.sha256)) !== sorted(profile.resourceSha256) || !unique(runtime.resources.map(r => r.sha256))) refuse("assembly_resource_profile_mismatch");
  for (const resource of runtime.resources) await verifyArtifact(root, resource);
  if (cell.engine) {
    if (!runtime.engine || runtime.engine.name !== cell.engine || !cell.enginePin || runtime.engine.version !== cell.enginePin.version || runtime.engine.executable.sha256 !== cell.enginePin.sha256) refuse("assembly_engine_missing");
    keys(runtime.engine, ["name", "version", "executable"]); text(runtime.engine.version); await verifyArtifact(root, runtime.engine.executable);
  } else if (runtime.engine !== null) refuse("assembly_engine_scope");
  if (cell.stage === "provider") {
    const p = r.provider; if (!p) refuse("assembly_provider_missing");
    keys(p, ["meteredLive", "provider", "operationId", "usageKnown", "usage", "budget"]); text(p.provider); text(p.operationId);
    if (p.meteredLive !== true || p.usageKnown !== true) refuse("assembly_provider_unmeasured");
    await verifyArtifact(root, p.usage); await verifyArtifact(root, p.budget);
  } else if (r.provider !== null) refuse("assembly_provider_scope");
}
export async function validateReceipt(root: string, submitted: SubmittedReceipt, cell: Cell, manifest: Manifest, manifestSha256: string): Promise<void> {
  const bytes = await verifyArtifact(root, submitted.artifact); if (!bytes) refuse("assembly_receipt_size");
  const parsed = parseQualificationJson(bytes); receiptShape(parsed);
  if (canonical(parsed) !== canonical(submitted.receipt)) refuse("assembly_receipt_object_mismatch");
  const r = parsed;
  if (r.source.sha !== manifest.source.sha || r.source.tree !== manifest.source.tree || r.manifestSha256 !== manifestSha256) refuse("assembly_stale_source_or_manifest");
  if (r.cellId !== cell.id || r.stage !== cell.stage || cell.host && hostId(r.host) !== hostId(cell.host)) refuse("assembly_wrong_cell_or_host");
  if (r.scope === "control" && cell.stage !== "component") refuse("assembly_control_scope_escalation");
  if (!cell.expectedTests || sorted(cell.expectedTests) !== sorted(r.expectedTests) || !unique(r.expectedTests) || !unique(r.tests.map(t => t.id))
    || sorted(r.tests.map(t => t.id)) !== sorted(cell.expectedTests) || r.tests.some(t => t.status !== "passed" || t.attempt !== 0)) refuse("assembly_roster_not_passed");
  if (r.execution.exitCode !== 0 || r.execution.timedOut || r.execution.signal !== null) refuse("assembly_command_not_passed");
  await verifyArtifact(root, r.execution.log);
  const required = requiredInvariants(cell);
  if (!unique(r.invariants.map(i => i.id)) || required.some(id => !r.invariants.some(i => i.id === id && i.passed)) || r.invariants.some(i => !i.passed)) refuse("assembly_invariants_missing");
  for (const i of r.invariants) await verifyArtifact(root, i.artifact);
  if (!r.outputs.length || !unique(r.outputs.map(o => o.id))) refuse("assembly_outputs_missing");
  if (!cell.expectedOutputs || sorted(cell.expectedOutputs.map(o => o.id)) !== sorted(r.outputs.map(o => o.id))) refuse("assembly_output_unpinned");
  for (const o of r.outputs) { await verifyArtifact(root, o.actual); if (o.actual.sha256 !== o.expectedSha256 || !cell.expectedOutputs.some(p => p.id === o.id && p.sha256 === o.expectedSha256)) refuse("assembly_output_mismatch"); }
  if (!r.cleanup.allOwnedClosed || !r.cleanup.profilesRemoved) refuse("assembly_cleanup_unconfirmed");
  await verifyRuntime(root, r, cell, manifest);
}
export async function aggregateAssembly(manifest: Manifest, manifestSha256: string, submissions: SubmittedReceipt[], root: string,
  reachableFeatureHeads: ReadonlySet<string>, reviews: IndependentReview[] = []): Promise<AssemblyResult> {
  validateManifest(manifest); if (!digest.test(manifestSha256)) refuse("assembly_manifest_digest");
  const stages = Object.fromEntries(STAGES.map(stage => [stage, { expected: manifest.cells.filter(c => c.stage === stage).length, valid: 0, accepted: 0 }])) as AssemblyResult["stages"];
  const blockers: AssemblyResult["blockers"] = []; const block = (cellId: string, code: string) => blockers.push({ cellId, code });
  for (const f of manifest.features) if (!f.head || !reachableFeatureHeads.has(f.head)) block(f.id, "assembly_feature_not_in_candidate");
  for (const r of submissions) if (!manifest.cells.some(c => c.id === r.receipt.cellId)) block("unrecognized", "assembly_unexpected_receipt");
  for (const c of manifest.cells) {
    const found = submissions.filter(r => r.receipt.cellId === c.id);
    if (found.length !== 1) { block(c.id, found.length ? "assembly_duplicate_cell" : "assembly_missing_cell"); continue; }
    const submitted = found[0];
    try { await validateReceipt(root, submitted, c, manifest, manifestSha256); stages[c.stage].valid++; }
    catch (error) { block(c.id, error instanceof Error && /^assembly_[a-z_]+$/.test(error.message) ? error.message : "assembly_invalid_evidence"); continue; }
    const matches = reviews.filter(r => r.cellId === c.id);
    if (submitted.receipt.scope !== "product" || matches.length !== 1 || matches[0].decision !== "approved" || matches[0].receiptSha256 !== submitted.artifact.sha256
      || canonical(matches[0].source) !== canonical(manifest.source) || canonical(matches[0].host) !== canonical(submitted.receipt.host) || matches[0].stage !== c.stage) {
      block(c.id, "assembly_independent_review_required"); continue;
    }
    stages[c.stage].accepted++;
  }
  const checksComplete = Object.values(stages).every(s => s.valid === s.expected) && !blockers.some(b => !["assembly_independent_review_required"].includes(b.code));
  const releaseQualified = checksComplete && blockers.length === 0;
  return { schema: "runphantom.assembly-result/v1", source: manifest.source, verdict: releaseQualified ? "QUALIFIED" : checksComplete ? "CHECKS_ONLY" : "BLOCKED", checksComplete, releaseQualified, stages, blockers };
}
export async function loadSubmittedReceipt(root: string, artifact: Artifact): Promise<SubmittedReceipt> {
  const body = await verifyArtifact(root, artifact); if (!body) refuse("assembly_receipt_size");
  const receipt = parseQualificationJson(body); receiptShape(receipt); return { receipt, artifact };
}
