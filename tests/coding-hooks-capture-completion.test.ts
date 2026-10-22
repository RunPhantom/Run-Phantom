import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb, getRuns, getRunWithSpans, insertSpan, upsertRun } from "../src/db";
import { isActive } from "../app/src/utils/helpers";

let directory: string, previous: string | undefined;
beforeEach(() => {
  closeDb(); previous = process.env.RUNPHANTOM_DB_PATH;
  directory = mkdtempSync(path.join(tmpdir(), "capture-completion-"));
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "private.sqlite");
});
afterEach(() => {
  closeDb(); if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous;
  rmSync(directory, { recursive: true, force: true });
});
const attributes = JSON.stringify({ captureContract: "runphantom.codex-hook.observation/v1", source: "codex_hook", entityKind: "session", coverage: "partial", producerVerified: false, runtimeVerified: false, reportedPhase: "unknown", "runphantom.span.kind": "agent_root" });
function seed(id: string, attrs: string | undefined, updated = Date.now()) {
  upsertRun({ id, name: "Codex session", started_at: Date.UTC(2026, 9, 18, 10), last_updated_at: updated });
  insertSpan({ id: "root", run_id: id, name: "Codex session", span_type: "AGENT_ROOT", status: "UNSET", start_time_ms: Date.UTC(2026, 9, 18, 10), end_time_ms: 0, duration_ms: 0, attributes: attrs });
}
test("never-opened list and detail downgrade validated partial capture without rewriting historical evidence", () => {
  seed("partial", attributes);
  const db = getDrizzleDb().$client, before = db.query("SELECT * FROM spans").all();
  const listed = getRuns()[0];
  expect(listed.capture_completion).toBe("unavailable"); expect(isActive(listed)).toBe(false);
  const detail = getRunWithSpans("partial");
  expect(detail.run?.capture_completion).toBe("unavailable");
  expect(detail.spans[0]).toMatchObject({ status: "UNSET", end_time_ms: 0, duration_ms: 0, start_time_ms: Date.UTC(2026, 9, 18, 10) });
  expect(db.query("SELECT * FROM spans").all()).toEqual(before);
});
test("generic live SDK runs retain activity even with matching names and unavailable end time", () => {
  seed("ordinary", undefined);
  const listed = getRuns()[0];
  expect(listed.capture_completion).toBeNull(); expect(isActive(listed)).toBe(true);
  expect(getRunWithSpans("ordinary").run?.capture_completion).toBeNull();
  expect(isActive({ last_updated_at: Date.now() - 31_000, finished: 1 })).toBe(false);
  expect(isActive({ last_updated_at: Date.now() - 4_000, finished: 1, live_event_count: 1 })).toBe(true);
});
test("malformed, unknown-version and oversized root claims grant no validated capture projection", () => {
  seed("malformed", "{"); seed("unknown", attributes.replace("observation/v1", "observation/v999"));
  seed("oversized", " ".repeat(16385) + attributes);
  for (const run of getRuns()) expect(run.capture_completion).toBeNull();
  expect(JSON.stringify(getRuns())).not.toContain("capture_attributes");
});
test("capture projection preserves selected run population, ordering and list bounds", () => {
  seed("older", attributes, 100); seed("newer", undefined, 200);
  expect(getRuns(1).map(run => run.id)).toEqual(["newer"]);
  expect(getRuns(2).map(run => run.id)).toEqual(["newer", "older"]);
  expect(getRuns(2).map(run => run.capture_completion)).toEqual([null, "unavailable"]);
});
