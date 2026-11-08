import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { parseOtlpRequest } from "../src/parse";

let directory: string;
let DB: string;

const { upsertRun, insertSpan, getRunOutline, closeDb } = await import("../src/db");

// db.ts memoises its path on first open, so scope the override to seeding and
// drop the handle afterwards, as tests/span-tree-cycles.test.ts does.
function withFixtureDb(fn: () => void): void {
  const original = process.env.RUNPHANTOM_DB_PATH;
  process.env.RUNPHANTOM_DB_PATH = DB;
  try { fn(); }
  finally {
    if (original === undefined) delete process.env.RUNPHANTOM_DB_PATH;
    else process.env.RUNPHANTOM_DB_PATH = original;
  }
}

const RUN = "e9a2d665ec74b1da6e6271ee069ae819";
const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rp-outline-errors-"));
  DB = path.join(directory, "outline.db");
  closeDb();
  // The shape openinference-instrumentation-openai exported for a real agent
  // whose lookup_order tool raised: status message set, no output.value.
  const base = 1_794_143_241_000;
  const spans = parseOtlpRequest({ resourceSpans: [{ scopeSpans: [{ spans: [
    { traceId: RUN, spanId: "55c98bc7b6c8971c", name: "support-agent", startTimeUnixNano: String(base * 1e6), endTimeUnixNano: String((base + 50) * 1e6),
      status: { code: 1 }, attributes: [attribute("openinference.span.kind", "AGENT")] },
    { traceId: RUN, spanId: "202f012e8a29c6b7", parentSpanId: "55c98bc7b6c8971c", name: "lookup_order", startTimeUnixNano: String((base + 1) * 1e6), endTimeUnixNano: String((base + 2) * 1e6),
      status: { code: 2, message: "KeyError: 'order Z-9999 not found in orders database'" },
      attributes: [attribute("openinference.span.kind", "TOOL"), attribute("tool.name", "lookup_order"), attribute("input.value", "{\"order_id\": \"Z-9999\"}")] },
    { traceId: RUN, spanId: "6d0e7a1b2c3d4e5f", parentSpanId: "55c98bc7b6c8971c", name: "openai.chat.completions", startTimeUnixNano: String((base + 3) * 1e6), endTimeUnixNano: String((base + 4) * 1e6),
      status: { code: 2, message: "status message" }, attributes: [attribute("runphantom.span.kind", "llm_call"), attribute("runphantom.output", "401 Incorrect API key\nsecond line")] },
  ] }] }] });
  withFixtureDb(() => {
    upsertRun({ id: RUN, name: "support-agent", started_at: base, last_updated_at: base + 50 });
    for (const span of spans) {
      insertSpan({ id: span.spanId, run_id: RUN, parent_span_id: span.parentSpanId, name: span.name, span_type: span.spanType, status: span.status,
        input_payload: span.inputPayload, output_payload: span.outputPayload, start_time_ms: span.startTimeMs, end_time_ms: span.endTimeMs,
        duration_ms: span.durationMs, attributes: JSON.stringify(span.attributes) });
    }
    getRunOutline(RUN);
  });
});

afterAll(() => {
  closeDb();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test("an outline error names the failure when the span reports it only as status", () => {
  const errors = getRunOutline(RUN).errors;
  expect(errors.map(error => error.name)).toEqual(["lookup_order", "openai.chat.completions"]);
  expect(errors[0]).toMatchObject({ first_line_of_output: "", reason: "KeyError: 'order Z-9999 not found in orders database'" });
});

test("captured output stays the reason when the span has one", () => {
  const llm = getRunOutline(RUN).errors[1];
  expect(llm.first_line_of_output).toBe("401 Incorrect API key");
  expect(llm.reason).toBe(llm.first_line_of_output);
});
