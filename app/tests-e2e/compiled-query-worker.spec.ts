import { test, expect, type APIRequestContext } from "@playwright/test";

// The native qualifier owns the copied artifact and two process boots. A URL alone is not native provenance.
const copiedUrl = process.env.RUNPHANTOM_COMPILED_URL;
const reopen = process.env.RUNPHANTOM_COMPILED_REOPEN;
if (reopen !== undefined && reopen !== "0" && reopen !== "1") throw new Error("compiled_reopen_phase_invalid");
if (copiedUrl) {
  const url = new URL(copiedUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("compiled_query_url_invalid");
  }
}
const definitionInput = "Owned compiled query input β";
const definitionOutput = "Owned compiled query output ✓";
const capture = {
  id: "00000000000000000000000000f32001",
  body: { resourceSpans: [{ scopeSpans: [{ spans: [{
    traceId: "00000000000000000000000000f32001", spanId: "0000000000f32001", name: "Owned compiled query capture", kind: 1,
    startTimeUnixNano: "1780000000000000000", endTimeUnixNano: "1780000000100000000", status: { code: 1 },
    attributes: [
      { key: "runphantom.span.kind", value: { stringValue: "agent_root" } },
      { key: "runphantom.input", value: { stringValue: definitionInput } },
      { key: "runphantom.output", value: { stringValue: definitionOutput } },
    ],
  }] }] }] },
};
async function query(request: APIRequestContext, sql: string) {
  return request.post(`${copiedUrl}/api/traces/query`, { data: { sql } });
}
async function storedOutput(request: APIRequestContext) {
  const response = await query(request, `SELECT input_payload,output_payload FROM spans WHERE run_id='${capture.id}'`);
  expect(response.status()).toBe(200);
  expect((await response.json()).rows).toEqual([{ input_payload: definitionInput, output_payload: definitionOutput }]);
}
async function readOnlyJourney(request: APIRequestContext) {
  const scalar = await query(request, "SELECT 1 AS value");
  expect(scalar.status()).toBe(200); expect((await scalar.json()).rows).toEqual([{ value: 1 }]);
  await storedOutput(request);
  for (const sql of [`DELETE FROM spans WHERE run_id='${capture.id}'`, "PRAGMA query_only = OFF"]) {
    const refused = await query(request, sql);
    expect(refused.status()).toBe(400); expect((await refused.json()).error).toContain("SELECT");
  }
  await storedOutput(request);
  const health = await request.get(`${copiedUrl}/health`);
  expect(health.status()).toBe(200); const body = await health.json();
  expect(Number.isSafeInteger(body.pid) && body.pid > 0).toBe(true);
}
test("compiled query worker executes real captured reads and refuses writes without blocking the daemon", async ({ request }, info) => {
  test.skip(!copiedUrl || reopen === "1", "Requires an actual copied executable URL in the initial native phase");
  expect((await request.post(`${copiedUrl}/v1/traces`, { data: capture.body })).status()).toBe(200);
  await readOnlyJourney(request);
  await info.attach("compiled-query-worker-initial", { body: JSON.stringify({ runId: capture.id, phase: "initial", capturedInputOutputExact: true, writesAndPragmaRefused: true, healthResponsive: true }), contentType: "application/json" });
});
test("compiled query worker retains exact captured reads after a same-profile native reopen without reseeding", async ({ request }, info) => {
  test.skip(!copiedUrl || reopen !== "1", "Requires the separately owned second native boot against the same database");
  await readOnlyJourney(request);
  await info.attach("compiled-query-worker-reopen", { body: JSON.stringify({ runId: capture.id, phase: "reopen", reseeded: false, capturedInputOutputExact: true, writesAndPragmaRefused: true, healthResponsive: true }), contentType: "application/json" });
});
