import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDrizzleDb, closeDb, deleteRun, insertSpan } from "../src/db";
import { CodingHookStore, type InstallationBinding } from "../src/coding-hooks/store";
import { normalizeClaudeHook } from "../src/coding-hooks/claude";
import { hookFixture, transcriptRecord, transcriptSnapshot } from "./fixtures/coding-hooks-claude";
import { parseHookAdmission, parseHookPublication, validateClaudeBatch, HOOK_PROTOCOL } from "../src/coding-hooks/protocol";

// Exact root-reviewed SQL in an actual owner SQLite fixture. This is not a product migration.
let directory: string, store: CodingHookStore, db: ReturnType<typeof getDrizzleDb>["$client"], prior: string | undefined;
const token = "a".repeat(64), id = "a".repeat(32), sourceIdentity = "b".repeat(64);
const binding = (mode: "metadata" | "full" = "metadata", installationId = id): InstallationBinding => ({ installationId, scope: "local", captureMode: mode, workspace: "/private/project", registeredWorkspace: "/private/project", transcriptRoot: "/private/projects", projectDirectory: "/private/projects/project", homeDirectory: "/private/home", settingsPath: "/private/project/.claude/settings.local.json", executable: "/private/bin/runphantom" });
beforeEach(() => { closeDb(); prior = process.env.RUNPHANTOM_DB_PATH; directory = mkdtempSync(path.join(tmpdir(), "runphantom-f11-store-")); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "owner.sqlite"); db = getDrizzleDb().$client; db.exec(readFileSync(path.join(import.meta.dir, "fixtures/coding-hooks-bootstrap.sql"), "utf8")); store = new CodingHookStore(db); store.beginOwner(); });
afterEach(() => { closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
function active(mode: "metadata" | "full" = "metadata") {
  const receipt = store.prepareInstallation(binding(mode), token, "c".repeat(64));
  store.commitInstallation(id, receipt.installationGeneration, token, "c".repeat(64), receipt.ownerGeneration); return store.admit(token, sourceIdentity);
}
function batch(admission: ReturnType<CodingHookStore["admit"]>, event = "PostToolUse") {
  const normalized = normalizeClaudeHook(hookFixture(event, { tool_use_id: "tool_exact", tool_name: "Bash", tool_response: "exact business output" }), { sourceKey: admission.sourceKey, captureMode: "full" }, null);
  if (normalized.status !== "accepted") throw new Error("fixture admission unavailable"); return normalized.value;
}
test("actual canonical publication is idempotent and producer-only with exact ordinary OTLP behavior preserved", () => {
  const admission = active("full"), value = batch(admission);
  expect(store.publish(token, admission, value).status).toBe("accepted"); expect(store.publish(token, admission, value).status).toBe("accepted");
  expect(db.query("SELECT output_payload FROM spans WHERE run_id=? AND span_type='tool'").get(admission.runId)).toEqual({ output_payload: JSON.stringify("exact business output") });
  expect((db.query("SELECT count(*) AS count FROM coding_hook_entities").get() as { count: number }).count).toBe(2);
  const ordinary = { id: "1".repeat(16), run_id: "1".repeat(32), name: "ordinary", start_time_ms: 1, end_time_ms: 2, duration_ms: 1, output_payload: "original OTLP" };
  db.query("INSERT INTO runs(id,started_at,last_updated_at) VALUES(?,1,1)").run(ordinary.run_id); insertSpan(ordinary); insertSpan({ ...ordinary, output_payload: "ordinary correction" });
  expect(db.query("SELECT output_payload FROM spans WHERE run_id=?").get(ordinary.run_id)).toEqual({ output_payload: "ordinary correction" });
});
test("a prepared full installation is inactive until exact filesystem receipt commits", () => {
  store.prepareInstallation(binding("full"), token, "c".repeat(64)); expect(() => store.admit(token, sourceIdentity)).toThrow();
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
  db.query("UPDATE spans SET output_payload='external original replacement' WHERE run_id=? AND span_type='tool'").run(admission.runId);
  expect(() => store.publish(token, admission, value)).toThrow();
  expect(db.query("SELECT output_payload FROM spans WHERE run_id=? AND span_type='tool'").get(admission.runId)).toEqual({ output_payload: "external original replacement" });
});
test("actual delete transaction tombstone rejects late callbacks and cannot resurrect the run", () => {
  const admission = active("full"), value = batch(admission); store.publish(token, admission, value); deleteRun(admission.runId);
  expect(() => store.publish(token, admission, value)).toThrow(); expect(() => store.admit(token, sourceIdentity)).toThrow();
  expect(db.query("SELECT id FROM runs WHERE id=?").get(admission.runId)).toBeNull();
});
test("identical management preserves policy generation; changed policy and token revoke earlier callbacks", () => {
  const admission = active("full"), repeated = store.prepareInstallation(binding("full"), token, "c".repeat(64));
  expect(repeated.unchanged).toBe(true); expect(repeated.installationGeneration).toBe(admission.installationGeneration);
  const changedToken = "d".repeat(64), changed = store.prepareInstallation(binding(), changedToken, "c".repeat(64));
  expect(changed.installationGeneration).not.toBe(admission.installationGeneration); expect(() => store.admit(token, sourceIdentity)).toThrow(); expect(() => store.admit(changedToken, sourceIdentity)).toThrow();
  expect(() => store.commitInstallation(id, admission.installationGeneration, changedToken, "c".repeat(64), changed.ownerGeneration)).toThrow();
  store.commitInstallation(id, changed.installationGeneration, changedToken, "c".repeat(64), changed.ownerGeneration); expect(store.admit(changedToken, sourceIdentity).captureMode).toBe("metadata");
});
test("global target and local full authority over the same registered project deduplicate identities without sharing policy", () => {
  const local = active("full"), globalId = "e".repeat(32), globalToken = "e".repeat(64), globalBinding = { ...binding("metadata", globalId), scope: "global" as const, workspace: null, settingsPath: "/private/home/.claude/settings.json" };
  const receipt = store.prepareInstallation(globalBinding, globalToken, "f".repeat(64)); store.commitInstallation(globalId, receipt.installationGeneration, globalToken, "f".repeat(64), receipt.ownerGeneration);
  const global = store.admit(globalToken, sourceIdentity); expect(global.sourceKey).toBe(local.sourceKey); expect(global.runId).toBe(local.runId); expect(global.captureMode).toBe("metadata");
  const foreignId = "f".repeat(32), foreignToken = "f".repeat(64), foreignBinding = { ...binding("full", foreignId), workspace: "/private/other-project", registeredWorkspace: "/private/other-project", projectDirectory: "/private/projects/other-project", settingsPath: "/private/other-project/.claude/settings.local.json" };
  const foreignReceipt = store.prepareInstallation(foreignBinding, foreignToken, "f".repeat(64)); store.commitInstallation(foreignId, foreignReceipt.installationGeneration, foreignToken, "f".repeat(64), foreignReceipt.ownerGeneration);
  const foreign = store.admit(foreignToken, sourceIdentity); expect(foreign.sourceKey).not.toBe(local.sourceKey);
  expect(() => store.publish(token, foreign, batch(foreign))).toThrow();
});
test("owner recovery rotates only the generation and resumes source identity in the actual reopened file", () => {
  const before = active("full"), epoch = (db.query("SELECT source_epoch FROM coding_hook_owner").get() as { source_epoch: string }).source_epoch;
  closeDb(); db = getDrizzleDb().$client; store = new CodingHookStore(db); store.beginOwner(); const after = store.admit(token, sourceIdentity);
  expect(after.ownerGeneration).not.toBe(before.ownerGeneration); expect(after.sourceKey).toBe(before.sourceKey);
  expect((db.query("SELECT source_epoch FROM coding_hook_owner").get() as { source_epoch: string }).source_epoch).toBe(epoch);
  expect(() => store.publish(token, before, batch(before))).toThrow(); expect(store.publish(token, after, batch(after)).status).toBe("accepted");
});
test("row and encoded-state quota refusals roll back session/entity/canonical creation", () => {
  active(); const oneSession = new CodingHookStore(db, { sessions: 1 }); expect(() => oneSession.admit(token, "c".repeat(64))).toThrow();
  expect((db.query("SELECT count(*) count FROM coding_hook_sessions").get() as { count: number }).count).toBe(1);
  const admission = store.admit(token, sourceIdentity), oneEntity = new CodingHookStore(db, { sessionEntities: 1 }); expect(() => oneEntity.publish(token, admission, batch(admission))).toThrow();
  expect(db.query("SELECT id FROM runs WHERE id=?").get(admission.runId)).toBeNull(); expect((db.query("SELECT count(*) count FROM coding_hook_entities").get() as { count: number }).count).toBe(0);
  const boundedBytes = new CodingHookStore(db, { bytes: 2000 }); expect(() => boundedBytes.publish(token, admission, batch(admission))).toThrow(); expect(db.query("SELECT id FROM runs WHERE id=?").get(admission.runId)).toBeNull();
});
test("growing same-incarnation records correct usage once, while older and replaced snapshots cannot erase it", () => {
  const admission = active("full"), first = transcriptSnapshot([transcriptRecord()]);
  const normalize = (snapshot: typeof first) => { const result = normalizeClaudeHook(hookFixture("Stop"), { sourceKey: admission.sourceKey, captureMode: "full" }, snapshot); if (result.status !== "accepted") throw new Error("fixture not admitted"); return result.value; };
  store.publish(token, admission, normalize(first));
  const nextRecord = transcriptRecord({ uuid: "record_2", message: { id: "msg_1", model: "fixture-model", content: [{ type: "text", text: "later exact output" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 7 } } });
  const appended = { ...transcriptSnapshot([nextRecord], "", first.endOffset), prefixBytes: first.prefixBytes, prefixSha256: first.prefixSha256 };
  store.publish(token, admission, normalize(appended)); expect(db.query("SELECT input_tokens,output_tokens,output_payload FROM spans WHERE run_id=? AND span_type='llm'").get(admission.runId)).toEqual({ input_tokens: 10, output_tokens: 7, output_payload: JSON.stringify([{ type: "text", text: "later exact output" }]) });
  expect(() => store.publish(token, admission, normalize(first))).toThrow(); expect(() => store.publish(token, admission, normalize({ ...appended, incarnationKey: "e".repeat(64) }))).toThrow();
  expect((db.query("SELECT count(*) count FROM spans WHERE run_id=? AND span_type='llm'").get(admission.runId) as { count: number }).count).toBe(1);
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
  expect(() => store.admit(token, sourceIdentity)).toThrow();
});

test("actual second-connection writer lock refuses publication without partial canonical state", () => {
  const admission = active("full"), other = new Database(db.filename); other.exec("BEGIN IMMEDIATE"); const started = performance.now();
  try { expect(() => store.publish(token, admission, batch(admission))).toThrow(); expect(performance.now() - started).toBeLessThan(250); }
  finally { other.exec("ROLLBACK"); other.close(); }
  expect(db.query("SELECT id FROM runs WHERE id=?").get(admission.runId)).toBeNull(); expect(db.query("SELECT entity_key FROM coding_hook_entities").all()).toEqual([]);
  expect(store.publish(token, admission, batch(admission)).status).toBe("accepted");
});
