import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDrizzleDb, closeDb, deleteRun, insertSpan } from "../src/db";
import { claimsForRegistration } from "../src/coding-hooks/catalog";
import { CodingHookStore, type InstallationBinding } from "../src/coding-hooks/store";
import { normalizeClaudeHook } from "../src/coding-hooks/claude";
import { hookFixture, transcriptRecord, transcriptSnapshot } from "./fixtures/coding-hooks-claude";
import { parseHookAdmission, parseHookPublication, validateClaudeBatch, hookDigest, HOOK_PROTOCOL, HookRefusal } from "../src/coding-hooks/protocol";

// Actual source migrations in a temporary owner SQLite fixture.
// The actual source migration supplies schema; these store fixtures use a trusted test-only guard. Product startup uses the kernel lease.
let directory: string, store: CodingHookStore, db: ReturnType<typeof getDrizzleDb>["$client"], prior: string | undefined;
const admit = (token: string, identity: string) => store.admit(token, identity, claimsForRegistration(store.authenticate(token).binding));
const token = "a".repeat(64), id = "a".repeat(32), sourceIdentity = "b".repeat(64);
const binding = (mode: "metadata" | "full" = "metadata", installationId = id): InstallationBinding => ({ installationId, scope: "local", captureMode: mode, workspace: "/private/project", registeredWorkspace: "/private/project", transcriptRoot: "/private/projects", projectDirectory: "/private/projects/project", homeDirectory: "/private/home", settingsPath: "/private/project/.claude/settings.local.json", executable: "/private/bin/runphantom" });
beforeEach(() => { closeDb(); prior = process.env.RUNPHANTOM_DB_PATH; directory = mkdtempSync(path.join(tmpdir(), "runphantom-f11-store-")); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "owner.sqlite"); db = getDrizzleDb().$client; store = new CodingHookStore(db, {}, () => true); store.beginOwner(); });
afterEach(() => { closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
function active(mode: "metadata" | "full" = "metadata") {
  const receipt = store.prepareInstallation(binding(mode), token, "c".repeat(64));
  store.commitInstallation(id, receipt.installationGeneration, token, "c".repeat(64), receipt.ownerGeneration); return admit(token, sourceIdentity);
}
function batch(admission: ReturnType<CodingHookStore["admit"]>, event = "PostToolUse") {
  const normalized = normalizeClaudeHook(hookFixture(event, { tool_use_id: "tool_exact", tool_name: "Bash", tool_response: "exact business output", ...(event === "PostToolUseFailure" ? { error: "producer failure" } : {}) }), { sourceKey: admission.sourceKey, captureMode: "full" }, null);
  if (normalized.status !== "accepted") throw new Error("fixture admission unavailable"); return normalized.value;
}
test("actual canonical publication is idempotent and producer-only with exact ordinary OTLP behavior preserved", () => {
  const admission = active("full"), value = batch(admission);
  expect(store.publish(token, admission, value).status).toBe("accepted"); expect(store.publish(token, admission, value).status).toBe("accepted");
  expect(db.query("SELECT output_payload FROM spans WHERE run_id=? AND span_type='TOOL_CALL'").get(admission.runId)).toEqual({ output_payload: JSON.stringify("exact business output") });
  expect((db.query("SELECT count(*) AS count FROM coding_hook_entities").get() as { count: number }).count).toBe(2);
  const ordinary = { id: "1".repeat(16), run_id: "1".repeat(32), name: "ordinary", start_time_ms: 1, end_time_ms: 2, duration_ms: 1, output_payload: "original OTLP" };
  db.query("INSERT INTO runs(id,started_at,last_updated_at) VALUES(?,1,1)").run(ordinary.run_id); insertSpan(ordinary); insertSpan({ ...ordinary, output_payload: "ordinary correction" });
  expect(db.query("SELECT output_payload FROM spans WHERE run_id=?").get(ordinary.run_id)).toEqual({ output_payload: "ordinary correction" });
});
test("a prepared full installation is inactive until exact filesystem receipt commits", () => {
  store.prepareInstallation(binding("full"), token, "c".repeat(64)); expect(() => admit(token, sourceIdentity)).toThrow();
});
test("old owner or installation generations cannot publish after revocation", () => {
  const admission = active("full"), value = batch(admission); store.rotateOwner(); expect(() => store.publish(token, admission, value)).toThrow();
});
test("current metadata authority strips full body claims without promoting capture policy", () => {
  const admission = active(), value = batch(admission); store.publish(token, admission, value);
  expect(JSON.stringify(db.query("SELECT * FROM spans").all())).not.toContain("exact business output");
  expect(JSON.stringify(db.query("SELECT data FROM coding_hook_entities").all())).not.toContain("exact business output");
});
test("external canonical mutation is refused rather than restoring cached hook projection", () => {
  const admission = active("full"), value = batch(admission); store.publish(token, admission, value);
  db.query("UPDATE spans SET output_payload='external original replacement' WHERE run_id=? AND span_type='TOOL_CALL'").run(admission.runId);
  expect(() => store.publish(token, admission, value)).toThrow();
  expect(db.query("SELECT output_payload FROM spans WHERE run_id=? AND span_type='TOOL_CALL'").get(admission.runId)).toEqual({ output_payload: "external original replacement" });
});
test("actual delete transaction tombstone rejects late callbacks and cannot resurrect the run", () => {
  const admission = active("full"), value = batch(admission); store.publish(token, admission, value); deleteRun(admission.runId);
  expect(() => store.publish(token, admission, value)).toThrow(); expect(() => admit(token, sourceIdentity)).toThrow();
  expect(db.query("SELECT id FROM runs WHERE id=?").get(admission.runId)).toBeNull();
});
test("identical management preserves policy generation; changed policy and token revoke earlier callbacks", () => {
  const admission = active("full"), repeated = store.prepareInstallation(binding("full"), token, "c".repeat(64));
  expect(repeated.unchanged).toBe(true); expect(repeated.installationGeneration).toBe(admission.installationGeneration);
  const changedToken = "d".repeat(64), changed = store.prepareInstallation(binding(), changedToken, "c".repeat(64));
  expect(changed.installationGeneration).not.toBe(admission.installationGeneration); expect(() => admit(token, sourceIdentity)).toThrow(); expect(() => admit(changedToken, sourceIdentity)).toThrow();
  expect(() => store.commitInstallation(id, admission.installationGeneration, changedToken, "c".repeat(64), changed.ownerGeneration)).toThrow();
  store.commitInstallation(id, changed.installationGeneration, changedToken, "c".repeat(64), changed.ownerGeneration); expect(admit(changedToken, sourceIdentity).captureMode).toBe("metadata");
});
test("global target and local full authority over the same registered project deduplicate identities without sharing policy", () => {
  const local = active("full"), globalId = "e".repeat(32), globalToken = "e".repeat(64), globalBinding = { ...binding("metadata", globalId), scope: "global" as const, workspace: null, settingsPath: "/private/profile/.claude/settings.json" };
  const receipt = store.prepareInstallation(globalBinding, globalToken, "f".repeat(64)); store.commitInstallation(globalId, receipt.installationGeneration, globalToken, "f".repeat(64), receipt.ownerGeneration);
  const global = admit(globalToken, sourceIdentity); expect(global.sourceKey).toBe(local.sourceKey); expect(global.runId).toBe(local.runId); expect(global.captureMode).toBe("metadata");
  const foreignId = "f".repeat(32), foreignToken = "f".repeat(64), foreignBinding = { ...binding("full", foreignId), workspace: "/private/other-project", registeredWorkspace: "/private/other-project", projectDirectory: "/private/projects/other-project", settingsPath: "/private/other-project/.claude/settings.local.json" };
  const foreignReceipt = store.prepareInstallation(foreignBinding, foreignToken, "f".repeat(64)); store.commitInstallation(foreignId, foreignReceipt.installationGeneration, foreignToken, "f".repeat(64), foreignReceipt.ownerGeneration);
  const foreign = admit(foreignToken, sourceIdentity); expect(foreign.sourceKey).not.toBe(local.sourceKey);
  expect(() => store.publish(token, foreign, batch(foreign))).toThrow();
});
test("owner recovery rotates only the generation and resumes source identity in the actual reopened file", () => {
  const before = active("full"), epoch = (db.query("SELECT source_epoch FROM coding_hook_owner").get() as { source_epoch: string }).source_epoch;
  closeDb(); db = getDrizzleDb().$client; store = new CodingHookStore(db, {}, () => true); store.beginOwner(); const after = admit(token, sourceIdentity);
  expect(after.ownerGeneration).not.toBe(before.ownerGeneration); expect(after.sourceKey).toBe(before.sourceKey);
  expect((db.query("SELECT source_epoch FROM coding_hook_owner").get() as { source_epoch: string }).source_epoch).toBe(epoch);
  expect(() => store.publish(token, before, batch(before))).toThrow(); expect(store.publish(token, after, batch(after)).status).toBe("accepted");
});
test("row and encoded-state quota refusals roll back session/entity/canonical creation", () => {
  active(); const oneSession = new CodingHookStore(db, { sessions: 1 }, () => true);
  const tables = ["coding_hook_owner", "coding_hook_installations", "coding_hook_sessions", "coding_hook_entities", "runs", "spans"];
  const snapshot = () => JSON.stringify(tables.map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = snapshot(); let refusal: unknown;
  try { oneSession.admit(token, "c".repeat(64), claimsForRegistration(store.authenticate(token).binding)); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(HookRefusal); expect((refusal as HookRefusal).reason).toBe("quota"); expect((refusal as HookRefusal).status).toBe(507);
  expect(snapshot()).toBe(before);
  expect((db.query("SELECT count(*) count FROM coding_hook_sessions").get() as { count: number }).count).toBe(1);
  const admission = admit(token, sourceIdentity), oneEntity = new CodingHookStore(db, { sessionEntities: 1 }, () => true); expect(() => oneEntity.publish(token, admission, batch(admission))).toThrow();
  expect(db.query("SELECT id FROM runs WHERE id=?").get(admission.runId)).toBeNull(); expect((db.query("SELECT count(*) count FROM coding_hook_entities").get() as { count: number }).count).toBe(0);
  const boundedBytes = new CodingHookStore(db, { bytes: 2000 }, () => true); expect(() => boundedBytes.publish(token, admission, batch(admission))).toThrow(); expect(db.query("SELECT id FROM runs WHERE id=?").get(admission.runId)).toBeNull();
});
test("growing same-incarnation records correct usage once, while older and replaced snapshots cannot erase it", () => {
  const admission = active("full"), first = transcriptSnapshot([transcriptRecord()]);
  const normalize = (snapshot: typeof first) => { const result = normalizeClaudeHook(hookFixture("Stop"), { sourceKey: admission.sourceKey, captureMode: "full" }, snapshot); if (result.status !== "accepted") throw new Error("fixture not admitted"); return result.value; };
  store.publish(token, admission, normalize(first));
  const nextRecord = transcriptRecord({ uuid: "record_2", message: { id: "msg_1", model: "fixture-model", content: [{ type: "text", text: "later exact output" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 7 } } });
  const appended = { ...transcriptSnapshot([nextRecord], "", first.endOffset), prefixBytes: first.prefixBytes, prefixSha256: first.prefixSha256 };
  store.publish(token, admission, normalize(appended)); expect(db.query("SELECT input_tokens,output_tokens,output_payload FROM spans WHERE run_id=? AND span_type='LLM_GENERATION'").get(admission.runId)).toEqual({ input_tokens: 10, output_tokens: 7, output_payload: JSON.stringify([{ type: "text", text: "later exact output" }]) });
  expect(() => store.publish(token, admission, normalize(first))).toThrow(); expect(() => store.publish(token, admission, normalize({ ...appended, incarnationKey: "e".repeat(64) }))).toThrow();
  expect((db.query("SELECT count(*) count FROM spans WHERE run_id=? AND span_type='LLM_GENERATION'").get(admission.runId) as { count: number }).count).toBe(1);
});
test("empty source freezes its first nonempty prefix and Stop never closes or reopens the session", () => {
  const admission = active(), empty = transcriptSnapshot([]), first = transcriptSnapshot([transcriptRecord()]);
  for (const snapshot of [empty, first]) { const result = normalizeClaudeHook(hookFixture("Stop"), { sourceKey: admission.sourceKey, captureMode: "metadata" }, snapshot); if (result.status !== "accepted") throw new Error("fixture"); store.publish(token, admission, result.value); }
  expect(db.query("SELECT state FROM coding_hook_sessions WHERE source_key=?").get(admission.sourceKey)).toEqual({ state: "open" });
  const ended = normalizeClaudeHook(hookFixture("SessionEnd", { reason: "prompt_input_exit" }), { sourceKey: admission.sourceKey, captureMode: "metadata" }, null); if (ended.status !== "accepted") throw new Error("fixture"); store.publish(token, admission, ended.value);
  const stopped = normalizeClaudeHook(hookFixture("Stop"), { sourceKey: admission.sourceKey, captureMode: "metadata" }, null); if (stopped.status !== "accepted") throw new Error("fixture"); store.publish(token, admission, stopped.value);
  expect(db.query("SELECT state FROM coding_hook_sessions WHERE source_key=?").get(admission.sourceKey)).toEqual({ state: "closed" });
});
test("closed controller DTOs refuse authority extras, duplicate keys and forged runtime proof without getters", () => {
  const admission = active(), value = batch(admission), envelope = { version: HOOK_PROTOCOL, ownerGeneration: admission.ownerGeneration, installationGeneration: admission.installationGeneration, sourceKey: admission.sourceKey, batch: value };
  expect(parseHookPublication(JSON.stringify(envelope)).sourceKey).toBe(admission.sourceKey);
  expect(() => parseHookPublication(JSON.stringify({ ...envelope, captureMode: "full", database: "/private/other.sqlite" }))).toThrow();
  expect(() => parseHookAdmission('{"version":"' + HOOK_PROTOCOL + '","sourceSessionIdentity":"' + sourceIdentity + '","sourceSessionIdentity":"' + sourceIdentity + '"}')).toThrow();
  expect(() => validateClaudeBatch(JSON.stringify({ ...value, runtimeVerified: true }), admission.sourceKey, "full")).toThrow();
  let reads = 0; expect(() => validateClaudeBatch({ get entities() { reads++; return []; } }, admission.sourceKey, "full")).toThrow(); expect(reads).toBe(0);
});

test("owner rotation fences prepared management receipts before authority activation", () => {
  const receipt = store.prepareInstallation(binding("full"), token, "c".repeat(64)); store.rotateOwner();
  expect(() => store.commitInstallation(id, receipt.installationGeneration, token, "c".repeat(64), receipt.ownerGeneration)).toThrow();
  expect(() => admit(token, sourceIdentity)).toThrow();
});

test("actual second-connection writer lock refuses publication without partial canonical state", () => {
  const admission = active("full"), other = new Database(db.filename), timeout = db.query("PRAGMA busy_timeout").get(); other.exec("BEGIN IMMEDIATE"); const started = performance.now();
  try { expect(() => store.publish(token, admission, batch(admission))).toThrow(); expect(performance.now() - started).toBeLessThan(250); }
  finally { other.exec("ROLLBACK"); other.close(); }
  expect(db.query("PRAGMA busy_timeout").get()).toEqual(timeout);
  expect(db.query("SELECT id FROM runs WHERE id=?").get(admission.runId)).toBeNull(); expect(db.query("SELECT entity_key FROM coding_hook_entities").all()).toEqual([]);
  expect(store.publish(token, admission, batch(admission)).status).toBe("accepted");
});

const canonicalBytes = () => JSON.stringify(db.query("SELECT * FROM spans ORDER BY id").all());
test.each(["phase", "sourceKind", "sourceOffset", "incarnationKey", "usage", "coverageReasons", "reportedAt", "reportedDurationMs", "bodyError", "model", "name", "runtimeVerified", "bodyOutput", "extraField"])("actual cached %s corruption refuses atomically with canonical witness and columns unchanged", field => {
  const admission = active("full"), normalized = normalizeClaudeHook(hookFixture("Stop"), { sourceKey: admission.sourceKey, captureMode: "full" }, transcriptSnapshot([transcriptRecord()]));
  if (normalized.status !== "accepted") throw new Error("fixture"); store.publish(token, admission, normalized.value);
  const row = db.query("SELECT * FROM coding_hook_entities WHERE source_key=? AND kind='assistant'").get(admission.sourceKey) as { entity_key: string; data: string };
  const prior = JSON.parse(row.data); const sessionBefore = JSON.stringify(db.query("SELECT * FROM coding_hook_sessions").all()); const before = canonicalBytes(), columnsBefore = { ...row, data: null };
  const edits: Record<string, unknown> = { phase: "pending", sourceKind: "hook", sourceOffset: prior.sourceOffset + 1, incarnationKey: "f".repeat(64), usage: { ...prior.usage, outputTokens: 123 }, coverageReasons: ["invalid_usage"], reportedAt: "2026-10-12T04:00:00.000Z", reportedDurationMs: 7, bodyError: "forged error", model: "changed-model", name: "changed label", runtimeVerified: true, bodyOutput: "forged output", extraField: true };
  if (field === "bodyError") prior.body.error = edits[field]; else if (field === "bodyOutput") prior.body.output = edits[field]; else prior[field] = edits[field];
  db.query("UPDATE coding_hook_entities SET data=? WHERE source_key=? AND entity_key=?").run(JSON.stringify(prior), admission.sourceKey, row.entity_key);
  const changed = db.query("SELECT * FROM coding_hook_entities WHERE source_key=? AND entity_key=?").get(admission.sourceKey, row.entity_key) as typeof row;
  expect({ ...changed, data: null }).toEqual(columnsBefore); expect(canonicalBytes()).toBe(before);
  expect(() => store.publish(token, admission, normalized.value)).toThrow(); expect(canonicalBytes()).toBe(before); expect(JSON.stringify(db.query("SELECT * FROM coding_hook_sessions").all())).toBe(sessionBefore);
  expect(db.query("SELECT data FROM coding_hook_entities WHERE source_key=? AND entity_key=?").get(admission.sourceKey, row.entity_key)).toEqual({ data: JSON.stringify(prior) });
});
test("actual cached success-to-pending tool mutation cannot downgrade the unchanged terminal projection", () => {
  const admission = active("full"), value = batch(admission); store.publish(token, admission, value);
  const row = db.query("SELECT * FROM coding_hook_entities WHERE source_key=? AND kind='tool'").get(admission.sourceKey) as { entity_key: string; data: string };
  const prior = JSON.parse(row.data), before = canonicalBytes(); prior.phase = "pending";
  db.query("UPDATE coding_hook_entities SET data=? WHERE source_key=? AND entity_key=?").run(JSON.stringify(prior), admission.sourceKey, row.entity_key);
  const control = db.query("SELECT * FROM coding_hook_entities WHERE source_key=? AND entity_key=?").get(admission.sourceKey, row.entity_key) as typeof row;
  expect({ ...control, data: null }).toEqual({ ...row, data: null }); expect(canonicalBytes()).toBe(before);
  expect(() => store.publish(token, admission, batch(admission, "PreToolUse"))).toThrow(); expect(canonicalBytes()).toBe(before);
});
test("unchanged retained success stays terminal when a pending observation arrives", () => {
  const admission = active("full"); store.publish(token, admission, batch(admission)); const before = canonicalBytes();
  expect(store.publish(token, admission, batch(admission, "PreToolUse")).status).toBe("accepted"); expect(canonicalBytes()).toBe(before);
});

test.each(["null", "unknown_field", "missing_field"])("bounded retained DTO %s corruption cannot be repaired or overwrite current state", mutation => {
  const admission = active("full"); store.publish(token, admission, batch(admission)); const before = canonicalBytes(), sessions = JSON.stringify(db.query("SELECT * FROM coding_hook_sessions").all());
  const row = db.query("SELECT entity_key,data FROM coding_hook_entities WHERE source_key=? AND kind='tool'").get(admission.sourceKey) as { entity_key: string; data: string };
  const value = JSON.parse(row.data); if (mutation === "unknown_field") value.untrustedExtra = "unknown"; else if (mutation === "missing_field") delete value.runtimeVerified;
  const data = mutation === "null" ? "null" : JSON.stringify(value); db.query("UPDATE coding_hook_entities SET data=? WHERE source_key=? AND entity_key=?").run(data, admission.sourceKey, row.entity_key);
  expect(() => store.publish(token, admission, batch(admission))).toThrow(); expect(canonicalBytes()).toBe(before); expect(JSON.stringify(db.query("SELECT * FROM coding_hook_sessions").all())).toBe(sessions);
});
test("metadata after full retains prior consented bodies through terminal conflict with a distinct NEXT witness", () => {
  const admission = active("full"); store.publish(token, admission, batch(admission));
  const changedToken = "d".repeat(64), receipt = store.prepareInstallation(binding(), changedToken, "c".repeat(64)); store.commitInstallation(id, receipt.installationGeneration, changedToken, "c".repeat(64), receipt.ownerGeneration);
  const metadata = admit(changedToken, sourceIdentity), failed = batch(metadata, "PostToolUseFailure");
  expect(store.publish(changedToken, metadata, failed).status).toBe("accepted");
  const row = db.query("SELECT data,observation_sha256 FROM coding_hook_entities WHERE source_key=? AND kind='tool'").get(metadata.sourceKey) as { data: string; observation_sha256: string };
  expect(JSON.parse(row.data).phase).toBe("conflict"); expect(JSON.parse(row.data).body.output).toBe("exact business output");
  expect(hookDigest(row.data)).not.toBe(row.observation_sha256); const before = canonicalBytes(); expect(store.publish(changedToken, metadata, failed).status).toBe("accepted"); expect(canonicalBytes()).toBe(before);
  const pending = batch(metadata, "PreToolUse"); expect(store.publish(changedToken, metadata, pending).status).toBe("accepted"); expect(canonicalBytes()).toBe(before);
});

test("stored transition columns independently disagreeing with retained JSON refuse exact canonical/session changes", () => {
  const admission = active("full"); store.publish(token, admission, batch(admission)); const before = canonicalBytes(), sessions = JSON.stringify(db.query("SELECT * FROM coding_hook_sessions").all());
  db.query("UPDATE coding_hook_entities SET phase='pending' WHERE source_key=? AND kind='tool'").run(admission.sourceKey);
  expect(() => store.publish(token, admission, batch(admission, "PreToolUse"))).toThrow(); expect(canonicalBytes()).toBe(before); expect(JSON.stringify(db.query("SELECT * FROM coding_hook_sessions").all())).toBe(sessions);
});
test("current projection without a retained NEXT witness refuses instead of inferring or repairing cached state", () => {
  const admission = active("full"); store.publish(token, admission, batch(admission));
  const span = db.query("SELECT * FROM spans WHERE run_id=? AND span_type='TOOL_CALL'").get(admission.runId) as { id: string; attributes: string };
  const attributes = JSON.parse(span.attributes); delete attributes.retainedEntitySha256; db.query("UPDATE spans SET attributes=? WHERE run_id=? AND id=?").run(JSON.stringify(attributes), admission.runId, span.id);
  const current = db.query("SELECT id,run_id,parent_span_id,name,span_type,status,input_payload,output_payload,start_time_ms,end_time_ms,duration_ms,model,provider,input_tokens,output_tokens,attributes,otlp_evidence FROM spans WHERE run_id=? AND id=?").get(admission.runId, span.id);
  db.query("UPDATE coding_hook_entities SET projection_sha256=? WHERE source_key=? AND kind='tool'").run(hookDigest(JSON.stringify(current)), admission.sourceKey);
  const before = canonicalBytes(), sessions = JSON.stringify(db.query("SELECT * FROM coding_hook_sessions").all());
  expect(() => store.publish(token, admission, batch(admission))).toThrow(); expect(canonicalBytes()).toBe(before); expect(JSON.stringify(db.query("SELECT * FROM coding_hook_sessions").all())).toBe(sessions);
});
