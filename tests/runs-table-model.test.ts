import { describe, expect, test } from "bun:test";
import type { RunListRow } from "../app/src/api/runs";
import {
  agentCell,
  compactNumber,
  contentTracks,
  contentTracksFor,
  costCell,
  durationCell,
  errorsCell,
  exportRowsJson,
  fitColumns,
  widerContent,
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
    known_cost_source: "estimated", cost_unknown_calls: 0, ...overrides,
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

  test("cost: a partial total says whether its known part was reported or estimated", () => {
    const reported = costCell(row({ est_cost_usd: null, cost_source: "unknown", known_cost_usd: 0.5, known_cost_source: "reported", cost_unknown_calls: 1 }));
    expect(reported).toEqual({ text: "$0.500+", title: "Reported by the provider $0.500 · 1 call without a reported cost or list price" });
    const mixed = costCell(row({ est_cost_usd: null, cost_source: "unknown", known_cost_usd: 0.5, known_cost_source: "mixed", cost_unknown_calls: 1 }));
    expect(mixed).toMatchObject({ text: "$0.500+", marker: "est." });
    expect(mixed.title).toContain("part reported by the provider and part estimated");
    expect(costCell(row({ known_cost_source: "mixed" })).title).toStartWith("Reported by the provider for some calls");
  });

  test("a search row without run facts shows every fact as unknown, never zero", () => {
    const missing = row({ facts_unavailable: true, llm_calls: 0, est_cost_usd: null, primary_model: null, duration_ms: null, agent: null });
    for (const cell of [costCell(missing), tokensCell(missing), durationCell(missing, "Still running"), modelCell(missing), agentCell(missing)]) {
      expect(cell).toMatchObject({ text: "—", unknown: true, title: "Unknown: this run's details could not be loaded" });
    }
  });

  test("duration and model", () => {
    expect(durationCell(row(), "Still running").text).toBe("1.2s");
    expect(durationCell(row({ duration_ms: null }), "Still running")).toMatchObject({ text: "—", title: "Still running", unknown: true });
    expect(modelCell(row({ models: ["claude-sonnet-4-5", "gpt-5-nano"] }))).toEqual({ text: "claude-sonnet-4-5 +1", title: "claude-sonnet-4-5, gpt-5-nano" });
    expect(modelCell(row({ primary_model: "gpt-5-nano-2025-08-07", models: ["gpt-5-nano-2025-08-07", "gpt-5-nano"] }))).toEqual({ text: "gpt-5-nano", title: "gpt-5-nano-2025-08-07, gpt-5-nano" });
    expect(modelCell(row({ primary_model: null, model: null, llm_calls: 0 }))).toMatchObject({ text: "—", unknown: true });
  });

  test("agent and errors cells say what a dash means", () => {
    expect(agentCell({ agent: "billing_agent" })).toEqual({ text: "billing_agent", title: "billing_agent" });
    expect(agentCell({ agent: null })).toMatchObject({ text: "—", unknown: true, title: "Agent unknown: the run did not name an agent" });
    expect(errorsCell({ error_count: 0 })).toEqual({ text: "—", title: "No step ended in an error" });
    expect(errorsCell({ error_count: 1 })).toEqual({ text: "1", title: "1 step ended in an error" });
    expect(errorsCell({ error_count: 3 })).toEqual({ text: "3", title: "3 steps ended in an error" });
  });
});

describe("runs table columns and sort", () => {
  test("column choice keeps canonical order and the run column", () => {
    expect(toggleColumn(RUNS_TABLE_DEFAULT_COLUMNS, "steps")).toEqual(["status", "run", "agent", "input", "model", "steps", "duration", "tokens", "cost", "errors", "started"]);
    const storedBeforeAgent = ["status", "run", "input", "model", "duration", "tokens", "cost", "errors", "started"];
    expect(normalizeColumns(storedBeforeAgent)).toEqual(storedBeforeAgent);
    expect(toggleColumn(normalizeColumns(storedBeforeAgent), "agent")).toEqual(RUNS_TABLE_DEFAULT_COLUMNS);
    expect(toggleColumn(["run", "cost"], "run")).toEqual(["run", "cost"]);
    expect(normalizeColumns(["cost", "bogus", "cost"])).toEqual(["run", "cost"]);
    expect(normalizeColumns("nope")).toEqual([...RUNS_TABLE_DEFAULT_COLUMNS]);
  });

  test("default columns fit a laptop window beside the sidebar by leaving out Agent, then Input", () => {
    const rows = [row({ primary_model: "claude-haiku-4-5-20251001", models: ["claude-haiku-4-5-20251001"] })];
    const tracks = contentTracks(rows, () => "Completed · 1 tool error");
    const at1440 = fitColumns(RUNS_TABLE_DEFAULT_COLUMNS, 1440 - 240, tracks);
    expect(at1440).toContain("input");
    expect(at1440).not.toContain("agent");
    const at1280 = fitColumns(RUNS_TABLE_DEFAULT_COLUMNS, 1280 - 240, tracks);
    expect(at1280).not.toContain("agent");
    expect(at1280).toEqual(expect.arrayContaining(["status", "run", "model", "duration", "tokens", "cost", "errors", "started"]));
    expect(minTableWidth(at1280, tracks)).toBeLessThanOrEqual(1280 - 240);
    expect(fitColumns(RUNS_TABLE_DEFAULT_COLUMNS, 1920 - 240, tracks)).toEqual([...RUNS_TABLE_DEFAULT_COLUMNS]);
  });

  test("a window too narrow even without Input and Agent keeps every chosen column and scrolls sideways", () => {
    expect(fitColumns(RUNS_TABLE_DEFAULT_COLUMNS, 390, {})).toEqual([...RUNS_TABLE_DEFAULT_COLUMNS]);
  });

  test("Status and Model are sized to their widest value, within caps", () => {
    // Widths measured in the browser at 12px: Inter "Completed · 1 tool error" 133px, Geist Mono 7.2px per glyph.
    const measure = (text: string, font: string) => font.includes("Mono") ? text.length * 7.2 : text === "Completed · 1 tool error" ? 133 : text.length * 6.5;
    const tracks = (model: string, status: string) => contentTracks([row({ primary_model: model, models: [model] })], () => status, measure);
    const px = (track: string | undefined) => Number(/(\d+)px/.exec(track ?? "")?.[1]);
    const long = tracks("claude-haiku-4-5-20251001", "Completed · 1 tool error");
    expect(px(long.status)).toBe(133 + 36);
    expect(px(long.model)).toBe(Math.ceil(16 * 7.2 + 20));
    const short = tracks("gpt-4o", "Run complete");
    expect(px(short.status)).toBe(Math.ceil(12 * 6.5 + 36));
    expect(px(short.model)).toBe(104);
    const odd = tracks("x".repeat(200), "y".repeat(200));
    expect(px(odd.model)).toBe(220);
    expect(px(odd.status)).toBe(200);
    expect(contentTracks([], () => "", measure)).toEqual({});
  });

  test("measured widths only grow, so a new row cannot narrow a column under the reader", () => {
    const wide = { status: 169, model: 135 };
    expect(widerContent(null, wide)).toBe(wide);
    expect(widerContent(wide, null)).toBe(wide);
    expect(widerContent(wide, { status: 100, model: 104 })).toBe(wide);
    expect(widerContent(wide, { status: 120, model: 180 })).toEqual({ status: 169, model: 180 });
    expect(contentTracksFor(wide)).toEqual({ status: "169px", model: "minmax(135px, 0.8fr)" });
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
