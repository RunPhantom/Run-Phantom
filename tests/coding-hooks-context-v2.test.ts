import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";
import { CodingHookStore, type InstallationBinding } from "../src/coding-hooks/store";
import { claimsForRegistration } from "../src/coding-hooks/catalog";
import { normalizeClaudeHook } from "../src/coding-hooks/claude";
import { hookFixture } from "./fixtures/coding-hooks-claude";
import { HookRefusal } from "../src/coding-hooks/protocol";

let directory: string, previous: string | undefined, store: CodingHookStore, db: ReturnType<typeof getDrizzleDb>["$client"];
const token = "a".repeat(64), identity = "b".repeat(64);
const binding: InstallationBinding = { installationId: "a".repeat(32), scope: "local", captureMode: "full", workspace: "/private/project", registeredWorkspace: "/private/project", transcriptRoot: "/private/projects", projectDirectory: "/private/projects/project", homeDirectory: "/private/home", settingsPath: "/private/project/.claude/settings.local.json", executable: "/private/bin/runphantom" };
const claims = claimsForRegistration(binding);
const snapshot = () => JSON.stringify(["coding_hook_owner", "coding_hook_installations", "coding_hook_sessions", "coding_hook_entities", "runs", "spans"].map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const admit = () => store.admit(token, identity, claims);
beforeEach(() => {
  closeDb(); previous = process.env.RUNPHANTOM_DB_PATH; directory = mkdtempSync(path.join(tmpdir(), "runphantom-f11-c06-")); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "owner.sqlite");
  db = getDrizzleDb().$client; store = new CodingHookStore(db, {}, () => true, { contextTransport: true }); store.beginOwner();
  const receipt = store.prepareInstallation(binding, token, "c".repeat(64)); store.commitInstallation(binding.installationId, receipt.installationGeneration, token, "c".repeat(64), receipt.ownerGeneration);
});
afterEach(() => { closeDb(); if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous; rmSync(directory, { recursive: true, force: true }); });
function published() {
  const admission = admit(), value = normalizeClaudeHook(hookFixture("Stop"), { sourceKey: admission.sourceKey, captureMode: "full" }, null);
  if (value.status !== "accepted") throw new Error("fixture"); store.publish(token, admission, value.value); return admission;
}
function refusedWithoutMutation(work: () => unknown) {
  const before = snapshot(); let error: unknown; try { work(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(HookRefusal); expect(snapshot()).toBe(before);
}
test("C06 actual unopened legacy initial47 admission remains read-only and main-only", () => {
  const admission = admit(); expect(db.query("SELECT data FROM coding_hook_sessions").get()).toEqual({ data: '{"coverage":"partial","producerVerified":false}' });
  expect(Buffer.byteLength('{"coverage":"partial","producerVerified":false}')).toBe(47); const before = snapshot(); expect(admit()).toEqual(admission); expect(snapshot()).toBe(before);
});
test("C06 actual published three-key legacy shape with coherent root remains read-only", () => {
  const admission = published(), before = snapshot(); const row = db.query("SELECT data FROM coding_hook_sessions").get() as { data: string };
  expect(Object.keys(JSON.parse(row.data))).toEqual(["coverage", "reasons", "unlinkedAssertions"]); expect(admit().sourceKey).toBe(admission.sourceKey); expect(snapshot()).toBe(before);
});
test.each(["null", "not-json", '{"version":2}', '{"coverage":"partial","producerVerified":false,"version":1}', '{"coverage":"partial","producerVerified":false,"agents":[]}', '{"coverage":"partial","reasons":[],"unlinkedAssertions":null,"revision":1}', '{"coverage":"partial","coverage":"partial","producerVerified":false}', '{"coverage":"partial","reasons":["unknown"],"unlinkedAssertions":null}'])("C06 actual malformed retained %s refuses before returning acquisition authority", data => {
  admit(); db.query("UPDATE coding_hook_sessions SET data=?").run(data); refusedWithoutMutation(admit);
});
test.each(["root", "run", "cache", "canonical", "usage", "column"])("C06 actual published %s corruption refuses atomically before FD", mutation => {
  const admission = published();
  if (mutation === "root" || mutation === "canonical") db.query("UPDATE spans SET attributes='{}' WHERE run_id=?").run(admission.runId);
  else if (mutation === "run") db.query("UPDATE coding_hook_sessions SET run_id=?").run("f".repeat(32));
  else if (mutation === "cache") db.query("UPDATE coding_hook_entities SET data='null'").run();
  else if (mutation === "usage") { const row = db.query("SELECT data FROM coding_hook_entities").get() as { data: string }; const entity = JSON.parse(row.data); entity.usage = { freshInputTokens: 1, outputTokens: null, cacheCreatedInputTokens: null, cacheReadInputTokens: null }; db.query("UPDATE coding_hook_entities SET data=?").run(JSON.stringify(entity)); }
  else db.query("UPDATE coding_hook_entities SET phase='complete'").run();
  refusedWithoutMutation(admit);
});
test("C06 initial shape cannot conceal published anchors", () => { published(); db.query("UPDATE coding_hook_sessions SET data=?").run('{"coverage":"partial","producerVerified":false}'); refusedWithoutMutation(admit); });
test("C06 suppression precedes malformed retained grammar without recreating a root", () => {
  admit(); db.query("UPDATE coding_hook_sessions SET state='suppressed',data='not-json'").run(); const before = snapshot();
  let error: unknown; try { admit(); } catch (caught) { error = caught; } expect(error).toBeInstanceOf(HookRefusal); expect((error as HookRefusal).reason).toBe("suppressed"); expect(snapshot()).toBe(before);
});
