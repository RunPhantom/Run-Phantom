import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";
import { acquireCodingHookOwner, type CodingHookOwnerLease } from "../src/coding-hooks/owner";
import { CodingHookStore, type InstallationBinding } from "../src/coding-hooks/store";
import { ContextHookStore } from "../src/coding-hooks/context-store";
import { CATALOG_CONTEXT_VERSION, claimsForRegistration, encodeInstallationCatalog } from "../src/coding-hooks/catalog";
import { parseAdmissionV2 } from "../src/coding-hooks/context-v2";
import { CANONICAL_COLUMNS } from "../src/coding-hooks/retained-version";
import { HookRefusal } from "../src/coding-hooks/protocol";
import { normalizeClaudeHook } from "../src/coding-hooks/claude";
import { hookFixture } from "./fixtures/coding-hooks-claude";

// Actual migrated SQLite and exclusive kernel ownership; finite producer fixtures, no FD/capture claim.
let directory: string, previous: string | undefined, lease: CodingHookOwnerLease, store: CodingHookStore;
const token = "a".repeat(64), identity = "b".repeat(64);
const binding: InstallationBinding = { installationId: "a".repeat(32), scope: "local", captureMode: "full", workspace: "/private/project", registeredWorkspace: "/private/project", transcriptRoot: "/private/projects", projectDirectory: "/private/projects/project", homeDirectory: "/private/home", settingsPath: "/private/project/.claude/settings.local.json", executable: "/private/bin/runphantom" };
const claims = claimsForRegistration(binding);
const snapshot = () => JSON.stringify(["coding_hook_owner", "coding_hook_installations", "coding_hook_sessions", "coding_hook_entities", "runs", "spans"].map(table => store.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const sourceRequest = (sourceIdentity = identity) => parseAdmissionV2(JSON.stringify({ version: 2, sourceSessionIdentity: sourceIdentity, claims, event: "Stop", selector: { kind: "main" } }));
function enablePrivateFixtureCatalog() {
  const installed = store.readInstallation(binding.installationId)!;
  store.db.query("UPDATE coding_hook_installations SET data=? WHERE id=?").run(encodeInstallationCatalog(installed.binding, installed.registrations, CATALOG_CONTEXT_VERSION), binding.installationId);
}
function normalized(sourceKey: string, event = "Stop") {
  const result = normalizeClaudeHook(hookFixture(event, event === "PostToolUse" ? { tool_use_id: "new_tool", tool_name: "lookup", tool_input: 0, tool_response: false } : {}), { sourceKey, captureMode: "full" }, null);
  if (result.status !== "accepted") throw new Error("fixture"); return result.value;
}
function legacyPublished() {
  const admission = store.admit(token, identity, claims); store.publish(token, admission, normalized(admission.sourceKey)); return admission;
}
function assertRefusal(work: () => unknown, reason: "corrupt" | "quota") {
  const before = snapshot(); let error: unknown; try { work(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(HookRefusal); expect((error as HookRefusal).reason).toBe(reason); expect(snapshot()).toBe(before);
}
// Independent contract oracle: exact authority/cache SQL bytes plus each coherent referenced canonical once.
function measuredBytes() {
  const base = store.db.query(`SELECT
    COALESCE((SELECT sum(80) FROM coding_hook_owner),0)+
    COALESCE((SELECT sum(2*length(CAST(id AS BLOB))+2*length(CAST(token_sha256 AS BLOB))+length(CAST(generation||state||capture_mode||scope||COALESCE(workspace,'')||transcript_root||source_root_key||config_sha256||data AS BLOB))+8) FROM coding_hook_installations),0)+
    COALESCE((SELECT sum(2*length(CAST(source_key AS BLOB))+3*length(CAST(run_id AS BLOB))+length(CAST(source_root_key||root_span_id||state||COALESCE(incarnation_key,'')||COALESCE(prefix_sha256,'')||data AS BLOB))+40) FROM coding_hook_sessions),0)+
    COALESCE((SELECT sum(3*length(CAST(source_key AS BLOB))+2*length(CAST(entity_key AS BLOB))+2*length(CAST(span_id AS BLOB))+length(CAST(kind||phase||COALESCE(incarnation_key,'')||observation_sha256||projection_sha256||data AS BLOB))+16) FROM coding_hook_entities),0) bytes`).get() as { bytes: number };
  const spans = store.db.query(`SELECT DISTINCT ${CANONICAL_COLUMNS.map(c => `s.${c}`).join(",")} FROM spans s JOIN coding_hook_sessions session ON session.run_id=s.run_id JOIN coding_hook_entities e ON e.source_key=session.source_key AND e.span_id=s.id`).all();
  const canonical = spans.reduce<number>((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  return { base: base.bytes, canonical, total: base.bytes + canonical, projections: spans.length };
}
const limited = (bytes: number, contextTransport = true) => new CodingHookStore(store.db, { bytes }, () => lease.isActive(), { contextTransport });
beforeEach(async () => {
  closeDb(); previous = process.env.RUNPHANTOM_DB_PATH; directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runphantom-f11-boundaries-"))); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "owner.sqlite");
  const db = getDrizzleDb().$client; lease = await acquireCodingHookOwner(db.filename); const currentLease = lease;
  store = new CodingHookStore(db, {}, () => currentLease.isActive(), { contextTransport: true }); store.beginOwner();
  const receipt = store.prepareInstallation(binding, token, "c".repeat(64)); store.commitInstallation(binding.installationId, receipt.installationGeneration, token, "c".repeat(64), receipt.ownerGeneration);
});
afterEach(async () => { await lease.release(); closeDb(); if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous; rmSync(directory, { recursive: true, force: true }); });
for (const version of ["legacy", "context"] as const) {
  test.each([
    ["ordinary", '{"ordinary":"business"}', false],
    ["valid marker", '{"source":"claude_hook","captureContract":"runphantom.claude-hook.observation/v2"}', true],
    ["malformed marker", '{"captureContract":"runphantom.claude-hook.observation/v2"', true],
    ["CASE-null oversized marker", JSON.stringify({ captureContract: "runphantom.claude-hook.observation/v2", extra: "x".repeat(17000) }), true],
  ])(`native ${version} selected orphan %s is classified before any producer FD`, (_name, attributes, shouldRefuse) => {
    const contexts = new ContextHookStore(store), contextAdmit = () => { const a = contexts.admit(token, sourceRequest()); if (a.dispatch !== "context-v2") throw new Error("fixture version"); return a; };
    const admission = version === "legacy" ? legacyPublished() : (enablePrivateFixtureCatalog(), contextAdmit());
    const ordinary = store.db.query("SELECT * FROM spans WHERE run_id=? AND id=?").get(admission.runId, admission.rootSpanId) as Record<string, string | number | null>;
    const inserted = { ...ordinary, id: "f".repeat(16), span_type: "INTERNAL", attributes }, columns = Object.keys(inserted);
    store.db.query(`INSERT INTO spans(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(inserted));
    const before = snapshot(), read = () => version === "legacy" ? store.admit(token, identity, claims) : contextAdmit();
    if (shouldRefuse) assertRefusal(read, "corrupt"); else { expect(read().sourceKey).toBe(admission.sourceKey); expect(snapshot()).toBe(before); }
  });
}
for (const operation of ["admission", "publication"] as const) {
  test(`native legacy ${operation} complete 3465-byte quota admits exact and refuses 3464 atomically`, () => {
    const admission = legacyPublished(), measured = measuredBytes(); expect(measured).toEqual({ base: 2581, canonical: 884, total: 3465, projections: 1 });
    const at = limited(3465), under = limited(3464), value = normalized(admission.sourceKey);
    if (operation === "admission") { const before = snapshot(); expect(at.admit(token, identity, claims)).toEqual(admission); expect(snapshot()).toBe(before); assertRefusal(() => under.admit(token, identity, claims), "quota"); }
    else { expect(at.publish(token, admission, value).status).toBe("accepted"); assertRefusal(() => under.publish(token, admission, value), "quota"); }
  });
}
test("native legacy publication checks newly grown canonical bytes in final transaction and rolls all source bytes back", () => {
  const admission = legacyPublished(), old = measuredBytes(), value = normalized(admission.sourceKey, "PostToolUse");
  store.db.exec("SAVEPOINT measure_growth"); store.publish(token, admission, value); const next = measuredBytes(); store.db.exec("ROLLBACK TO measure_growth; RELEASE measure_growth");
  expect(next.total - 1).toBeGreaterThan(old.total); expect(next.total - 1).toBeGreaterThan(next.base);
  assertRefusal(() => limited(next.total - 1).publish(token, admission, value), "quota");
  expect(limited(next.total).publish(token, admission, value).status).toBe("accepted"); expect(measuredBytes()).toEqual(next);
});
test("native legacy transport charges mixed v1/v2 distinct canonical projections exactly once", () => {
  const legacy = legacyPublished(); enablePrivateFixtureCatalog(); const contexts = new ContextHookStore(store); contexts.admit(token, sourceRequest("d".repeat(64)));
  const total = measuredBytes(); expect(total.projections).toBe(2); expect(total.canonical).toBeGreaterThan(884); const before = snapshot();
  expect(limited(total.total).admit(token, identity, claims).sourceKey).toBe(legacy.sourceKey); expect(snapshot()).toBe(before);
  assertRefusal(() => limited(total.total - 1).admit(token, identity, claims), "quota"); assertRefusal(() => limited(total.total - 1).publish(token, legacy, normalized(legacy.sourceKey)), "quota");
  expect(limited(total.total).publish(token, legacy, normalized(legacy.sourceKey)).status).toBe("accepted"); expect(measuredBytes()).toEqual(total);
});
test("native default-false legacy quota behavior remains the original baseline accounting", () => {
  const admission = legacyPublished(), before = snapshot(); expect(limited(3464, false).admit(token, identity, claims).sourceKey).toBe(admission.sourceKey); expect(snapshot()).toBe(before);
});
