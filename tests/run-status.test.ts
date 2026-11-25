import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getRuns, getRunWithSpans, insertSpan, upsertRun } from "../src/db";
import { searchRuns } from "../src/run-search";
import { countedErrors, deriveRunStatus, RUN_INTERRUPTED_AFTER_MS, RUN_QUIET_AFTER_MS, runErrorEvidenceFromSpans, runInProgress, runStatusTone } from "../src/run-status";

const NOW = Date.UTC(2026, 10, 25, 12);

describe("deriveRunStatus", () => {
  const finished = { last_updated_at: NOW - 1_000, finished: 1, span_count: 4, error_count: 0, tool_error_count: 0, root_failed: false };

  test("a finished run is complete at once, even with recent live events", () => {
    expect(deriveRunStatus({ ...finished, last_updated_at: NOW }, NOW)).toMatchObject({ status: "complete", label: "Run complete" });
  });

  test("a finished run whose root succeeded but a tool errored reads completed with one tool error", () => {
    expect(deriveRunStatus({ ...finished, error_count: 1, tool_error_count: 1 }, NOW))
      .toMatchObject({ status: "completed_with_errors", label: "Completed · 1 tool error", errorCount: 1, toolErrorCount: 1 });
    expect(deriveRunStatus({ ...finished, error_count: 3, tool_error_count: 1 }, NOW).label).toBe("Completed · 3 errors");
    expect(deriveRunStatus({ ...finished, error_count: 2, tool_error_count: 2 }, NOW).label).toBe("Completed · 2 tool errors");
  });

  test("a run fails only when its root errored", () => {
    expect(deriveRunStatus({ ...finished, error_count: 2, tool_error_count: 1, root_failed: true }, NOW)).toMatchObject({ status: "failed", label: "Run failed", errorCount: 2 });
    expect(deriveRunStatus({ ...finished, finished: 0, last_updated_at: NOW, error_count: 1, root_failed: true }, NOW).status).toBe("failed");
  });

  test("an unfinished run is live only while spans keep arriving", () => {
    const open = { ...finished, finished: 0 };
    expect(deriveRunStatus({ ...open, last_updated_at: NOW - RUN_QUIET_AFTER_MS + 1 }, NOW).status).toBe("live");
    expect(deriveRunStatus({ ...open, span_count: 0, last_updated_at: NOW - RUN_QUIET_AFTER_MS }, NOW)).toMatchObject({ status: "unknown", label: "No spans recorded" });
  });

  test("a quiet run waiting on a long call is not called interrupted until the interrupted threshold", () => {
    const open = { ...finished, finished: 0 };
    const quiet = deriveRunStatus({ ...open, last_updated_at: NOW - 45_000 }, NOW);
    expect(quiet).toMatchObject({ status: "quiet", label: "Run quiet" });
    expect(quiet.detail).toContain("No new spans for 45s");
    expect(runInProgress(quiet.status)).toBe(true);
    expect(runStatusTone(quiet.status)).toBe("neutral");
    expect(deriveRunStatus({ ...open, last_updated_at: NOW - RUN_INTERRUPTED_AFTER_MS + 1 }, NOW).status).toBe("quiet");
    const interrupted = deriveRunStatus({ ...open, last_updated_at: NOW - RUN_INTERRUPTED_AFTER_MS }, NOW);
    expect(interrupted).toMatchObject({ status: "interrupted", label: "Run interrupted" });
    expect(runInProgress(interrupted.status)).toBe(false);
  });

  test("validated partial captures stay unknown instead of guessing an outcome", () => {
    expect(deriveRunStatus({ ...finished, finished: 0, last_updated_at: NOW, capture_completion: "unavailable" }, NOW))
      .toMatchObject({ status: "unknown", label: "Completion unavailable" });
  });

  test("legacy sibling roots: one errored tool root is a child error unless every root errored", () => {
    const spans = [
      { parent_span_id: null, span_type: "LLM_GENERATION", status: "OK" },
      { parent_span_id: null, span_type: "TOOL_CALL", status: "ERROR" },
    ];
    expect(runErrorEvidenceFromSpans(spans)).toEqual({ error_count: 1, tool_error_count: 1, root_failed: false });
    expect(runErrorEvidenceFromSpans(spans.map(span => ({ ...span, status: "ERROR" }))).root_failed).toBe(true);
    expect(runErrorEvidenceFromSpans([{ parent_span_id: null, span_type: "AGENT_ROOT", status: "ERROR" }, ...spans]).root_failed).toBe(true);
  });

  test("an errored agent root is not counted again when an error beneath it explains the failure", () => {
    const root = { parent_span_id: null, span_type: "AGENT_ROOT", status: "ERROR" };
    const call = { parent_span_id: "root", span_type: "LLM_GENERATION", status: "ERROR" };
    expect(runErrorEvidenceFromSpans([root, call])).toEqual({ error_count: 1, tool_error_count: 0, root_failed: true });
    expect(runErrorEvidenceFromSpans([root, { ...call, status: "OK" }])).toEqual({ error_count: 1, tool_error_count: 0, root_failed: true });
    expect(runErrorEvidenceFromSpans([root, call, { ...call, span_type: "TOOL_CALL" }]).error_count).toBe(2);
    expect(countedErrors(3, 0)).toBe(3);
  });
});

describe("run status in API payloads", () => {
  let directory: string, previous: string | undefined;
  beforeEach(() => {
    closeDb(); previous = process.env.RUNPHANTOM_DB_PATH;
    directory = mkdtempSync(path.join(tmpdir(), "run-status-"));
    process.env.RUNPHANTOM_DB_PATH = path.join(directory, "status.sqlite");
  });
  afterEach(() => {
    closeDb(); if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });

  function seedRun(id: string, rootStatus: string, toolStatus: string) {
    const start = Date.now() - 2_000;
    upsertRun({ id, name: id, started_at: start, last_updated_at: Date.now() });
    insertSpan({ id: `${id}-root`, run_id: id, name: "agent", span_type: "AGENT_ROOT", status: rootStatus, start_time_ms: start, end_time_ms: start + 1_500, duration_ms: 1_500 });
    insertSpan({ id: `${id}-tool`, run_id: id, parent_span_id: `${id}-root`, name: "run_tests", span_type: "TOOL_CALL", status: toolStatus, start_time_ms: start + 100, end_time_ms: start + 200, duration_ms: 100 });
  }

  test("/api/runs rows and run detail carry the same derived status and evidence", async () => {
    seedRun("tool-error", "OK", "ERROR");
    seedRun("root-error", "ERROR", "OK");
    seedRun("clean", "OK", "OK");
    const rows = new Map(getRuns().map(row => [row.id, row]));
    expect(rows.get("tool-error")).toMatchObject({ run_status: "completed_with_errors", error_count: 1, tool_error_count: 1, root_failed: false, finished: 1 });
    expect(rows.get("root-error")).toMatchObject({ run_status: "failed", error_count: 1, tool_error_count: 0, root_failed: true });
    expect(rows.get("clean")).toMatchObject({ run_status: "complete", error_count: 0, root_failed: false });
    for (const id of ["tool-error", "root-error", "clean"]) {
      const detail = getRunWithSpans(id).run!;
      expect(detail.run_status).toBe(rows.get(id)!.run_status);
      expect({ error_count: detail.error_count, tool_error_count: detail.tool_error_count, root_failed: detail.root_failed })
        .toEqual({ error_count: rows.get(id)!.error_count, tool_error_count: rows.get(id)!.tool_error_count, root_failed: rows.get(id)!.root_failed });
    }
    const searched = await searchRuns({});
    const searchedToolError = searched.runs.find(run => run.id === "tool-error")!;
    expect(deriveRunStatus(searchedToolError).status).toBe("completed_with_errors");
    expect(deriveRunStatus(searched.runs.find(run => run.id === "root-error")!).status).toBe("failed");
  });
});
