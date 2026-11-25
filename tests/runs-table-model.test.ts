import { describe, expect, test } from "bun:test";
import type { RunListRow } from "../app/src/api/runs";
import {
  compactNumber,
  costCell,
  durationCell,
  exportRowsJson,
  minTableWidth,
  modelCell,
  nextSort,
  normalizeColumns,
  toggleColumn,
  tokensCell,
} from "../app/src/runs/table-model";
import { RUNS_TABLE_DEFAULT_COLUMNS } from "../src/saved-views-protocol";

function row(overrides: Partial<RunListRow> = {}): RunListRow {
  return {
    id: "r1", name: "agent", event_name: "agent", display_name: null, user_id: null, convo_id: null, started_at: 0, last_updated_at: 0,
    metadata: null, model: null, finished: 1, error_count: 0, tool_error_count: 0, root_failed: false, span_count: 3, live_event_count: 0,
    capture_completion: null, agent: "agent", duration_ms: 1200, input_tokens: 4936, output_tokens: 428, est_cost_usd: 0.021228,
    cost_source: "estimated", tool_count: 1, primary_model: "claude-sonnet-4-5", provider: "anthropic", models: ["claude-sonnet-4-5"],
    input_preview: "hi", llm_calls: 2, known_input_tokens: 4936, known_output_tokens: 428, token_unknown_calls: 0, known_cost_usd: 0.021228,
    cost_unknown_calls: 0, ...overrides,
  };
}

describe("runs table cells", () => {
  test("compact numbers keep three significant figures at most", () => {
    expect([0, 428, 999, 1000, 4936, 12_345, 999_499, 1_250_000, 42_000_000].map(compactNumber))
      .toEqual(["0", "428", "999", "1K", "4.9K", "12K", "999K", "1.3M", "42M"]);
  });

  test("tokens: known, partial and unknown are told apart", () => {
    expect(tokensCell(row()).text).toBe("4.9K / 428");
    expect(tokensCell(row()).unknown).toBeUndefined();
    expect(tokensCell(row()).title).toBe("4,936 input · 428 output tokens over 2 model calls");
    const partial = tokensCell(row({ input_tokens: null, output_tokens: null, known_input_tokens: 300, known_output_tokens: 30, token_unknown_calls: 1 }));
    expect(partial.text).toBe("300+ / 30+");
    expect(partial.title).toContain("1 call did not report counts");
    expect(tokensCell(row({ input_tokens: null, output_tokens: null, known_input_tokens: null, known_output_tokens: null, llm_calls: 1 })))
      .toMatchObject({ text: "—", unknown: true, title: "Tokens unknown: the model call did not report token counts" });
    expect(tokensCell(row({ llm_calls: 0 }))).toMatchObject({ text: "—", title: "No model calls in this run" });
  });

  test("cost: an estimate is marked, unknown is a dash with the reason, never $0", () => {
    expect(costCell(row())).toMatchObject({ text: "$0.021", marker: "est." });
    expect(costCell(row({ cost_source: "reported" }))).toEqual({ text: "$0.021", title: "Cost reported by the provider" });
    expect(costCell(row({ est_cost_usd: null, cost_source: "unknown", known_cost_usd: 0.0025, cost_unknown_calls: 2 })))
      .toMatchObject({ text: "$0.0025+", title: "Known estimates $0.0025 · 2 calls without a reported cost or list price" });
    const unknown = costCell(row({ est_cost_usd: null, cost_source: "unknown", known_cost_usd: null, cost_unknown_calls: 2 }));
    expect(unknown).toMatchObject({ text: "—", unknown: true });
    expect(unknown.title).toStartWith("Cost unknown:");
    expect(costCell(row({ llm_calls: 0, est_cost_usd: null }))).toMatchObject({ text: "—", title: "No model calls in this run" });
  });

  test("duration and model", () => {
    expect(durationCell(row(), "Still running").text).toBe("1.2s");
    expect(durationCell(row({ duration_ms: null }), "Still running")).toMatchObject({ text: "—", title: "Still running", unknown: true });
    expect(modelCell(row({ models: ["claude-sonnet-4-5", "gpt-5-nano"] }))).toEqual({ text: "claude-sonnet-4-5 +1", title: "claude-sonnet-4-5, gpt-5-nano" });
    expect(modelCell(row({ primary_model: "gpt-5-nano-2025-08-07", models: ["gpt-5-nano-2025-08-07", "gpt-5-nano"] }))).toEqual({ text: "gpt-5-nano", title: "gpt-5-nano-2025-08-07, gpt-5-nano" });
    expect(modelCell(row({ primary_model: null, model: null, llm_calls: 0 }))).toMatchObject({ text: "—", unknown: true });
  });
});

describe("runs table columns and sort", () => {
  test("column choice keeps canonical order and the run column", () => {
    expect(toggleColumn(RUNS_TABLE_DEFAULT_COLUMNS, "steps")).toEqual(["status", "run", "input", "model", "steps", "duration", "tokens", "cost", "errors", "started"]);
    expect(toggleColumn(["run", "cost"], "run")).toEqual(["run", "cost"]);
    expect(normalizeColumns(["cost", "bogus", "cost"])).toEqual(["run", "cost"]);
    expect(normalizeColumns("nope")).toEqual([...RUNS_TABLE_DEFAULT_COLUMNS]);
  });

  test("default columns fit a 1280px window beside the sidebar", () => {
    expect(minTableWidth(RUNS_TABLE_DEFAULT_COLUMNS)).toBeLessThanOrEqual(1280 - 240);
  });

  test("a header click sorts descending first, then flips", () => {
    expect(nextSort({}, "cost")).toEqual({ sort: "cost", order: "desc" });
    expect(nextSort({ sort: "cost", order: "desc" }, "cost")).toEqual({ sort: "cost", order: "asc" });
    expect(nextSort({ sort: "cost", order: "asc" }, "cost")).toEqual({ sort: "cost", order: "desc" });
    expect(nextSort({}, "last_updated_at")).toEqual({ sort: "last_updated_at", order: "asc" });
  });

  test("export keeps API rows untouched", () => {
    const parsed = JSON.parse(exportRowsJson([row()], Date.UTC(2026, 10, 25)));
    expect(parsed).toEqual({ format: "runphantom-runs/v1", exportedAt: "2026-11-25T00:00:00.000Z", runs: [row()] });
  });
});
