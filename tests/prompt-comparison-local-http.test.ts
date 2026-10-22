import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server";
import { closeDb, getDrizzleDb } from "../src/db";
import { createComparisonProviderClient } from "../src/prompts/providers";
import { COMPARISON_MODELS } from "../src/prompts/comparison-protocol";
import { ComparisonStore } from "../src/prompts/comparison-store";
import { request as httpRequest } from "node:http";

let directory: string, url: string, prior: string | undefined, handle: Awaited<ReturnType<typeof createServer>>, upstream: ReturnType<typeof Bun.serve>;
let calls = 0, active = 0, peak = 0, overage = false;
beforeEach(async () => {
  closeDb(); calls = 0; active = 0; peak = 0; overage = false; directory = realpathSync(mkdtempSync(join(tmpdir(), "rp-comparison-local-http-")));
  prior = process.env.RUNPHANTOM_DB_PATH; process.env.RUNPHANTOM_DB_PATH = join(directory, "owner.sqlite");
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string; messages: { content: string }[] }; calls++; active++; peak = Math.max(peak, active); await Bun.sleep(15); active--;
    const output = overage ? "x".repeat(7900) : "Native result <img src='https://untrusted.invalid'>", raw = body.model.startsWith("gpt")
      ? { model: body.model, service_tier: "default", choices: [{ message: { content: output }, finish_reason: "stop" }], usage: { prompt_tokens: overage ? 1000000 : 3, completion_tokens: overage ? 1 : 2, prompt_tokens_details: { cached_tokens: 0 } } }
      : { model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: output }], usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, inference_geo: "global", service_tier: "standard" } };
    return Response.json(raw);
  } });
  await start();
});
async function start() {
  const client = createComparisonProviderClient({ credentials: { openai: "fixture-token", anthropic: "fixture-token" }, transport: (_url, init) => fetch(upstream.url, init), provenance: "controlled-http-fixture" });
  handle = await createServer(0, { comparisons: { client, budgets: { openai: 1000000, anthropic: 1000000 } } }); handle.server.listen(0, "127.0.0.1"); await once(handle.server, "listening"); url = `http://127.0.0.1:${(handle.server.address() as { port: number }).port}`;
}
async function stop() { await new Promise<void>((resolve, reject) => handle.server.close(error => error ? reject(error) : resolve())); closeDb(); }
afterEach(async () => { await stop(); await upstream.stop(true); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
async function call(path: string, method = "GET", value?: unknown) {
  const response = await fetch(url + path, { method, headers: value === undefined ? {} : { "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }); return { response, data: await response.json() };
}
async function request(targets = [...COMPARISON_MODELS]) {
  const saved = await call("/api/prompts", "POST", { operationKey: randomUUID(), name: "Native immutable source", template: "Literal {{topic}}" }); expect(saved.response.status).toBe(201);
  const cap = await call("/api/prompts/comparisons/capabilities"); expect(cap.response.status).toBe(200);
  return { operationKey: randomUUID(), promptId: saved.data.id, revision: 1, variables: { topic: "$& {{literal}}" }, targets, options: { maxOutputTokens: 128, temperature: 0 }, operationBudgetMicrousd: 1000000, expectedGeneration: cap.data.generation };
}
async function terminal(id: string) {
  const end = performance.now() + 3000;
  for (;;) { const value = await call("/api/prompts/comparisons/" + id); if (value.data.attempts.every((row: { status: string }) => !["queued", "running"].includes(row.status))) return value.data; if (performance.now() >= end) throw new Error("Actual native result deadline"); await Bun.sleep(5); }
}
test("actual local registered owner routes retain four native outputs and reject noncanonical/raw duplicate inputs without another dispatch", async () => {
  const value = await request(), first = await call("/api/prompts/comparisons", "POST", value); expect(first.response.status).toBe(201);
  const result = await terminal(first.data.id); expect(calls).toBe(4); expect(peak).toBe(2); expect(result.request.compiled).toBe("Literal $& {{literal}}"); expect(result.attempts.every((row: { status: string; payload: { output: string } }) => row.status === "completed" && row.payload.output.includes("Native result <img"))).toBe(true);
  const db = getDrizzleDb().$client, rows = () => ["prompt_comparisons", "prompt_comparison_attempts"].map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()), before = rows();
  for (const path of ["/api/prompts/comparisons/", "/api/PROMPTS/comparisons", "/api/prompts/comparisons/capabilities?cursor=x", "/api/prompts/comparisons?cursor=a&cursor=b", "/api/prompts/comparisons/%63apabilities"]) expect((await call(path)).response.status).toBe(400);
  for (const body of ['{"operationKey":"one","operationKey":"two"}', '{"variables":{"topic":"one","to\\u0070ic":"two"}}']) { const response = await fetch(url + "/api/prompts/comparisons", { method: "POST", headers: { "Content-Type": "application/json" }, body }); expect(response.status).toBe(400); await response.arrayBuffer(); }
  expect((await fetch(url + "/api/prompts/comparisons", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://foreign.invalid" }, body: JSON.stringify(value) })).status).toBe(403);
  expect(rows()).toEqual(before); expect(calls).toBe(4); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("actual mounted adapter preserves enriched-output overage, fuse and all accounting across privacy clear and same-inode owner reopen", async () => {
  overage = true; const value = await request([COMPARISON_MODELS[1]]), first = await call("/api/prompts/comparisons", "POST", value); expect(first.response.status).toBe(201);
  const result = await terminal(first.data.id); expect(result.attempts[0]).toMatchObject({ status: "failed", reason: "response_limit", payload: null, accountingState: "measured_estimate", observedEstimateUsd: "2.000008", chargeMicrousd: 2000008, budgetBreach: true }); expect(calls).toBe(1);
  const cap = await call("/api/prompts/comparisons/capabilities"); expect(cap.data.models.filter((model: { provider: string }) => model.provider === "openai").every((model: { spendingEnabled: boolean; admissionReason: string }) => !model.spendingEnabled && model.admissionReason === "overage_fuse")).toBe(true);
  const refused = await call("/api/prompts/comparisons", "POST", { ...value, operationKey: randomUUID() }); expect(refused.data.attempts[0].status).toBe("budget_refused"); expect(calls).toBe(1);
  const filename = getDrizzleDb().$client.filename, inode = statSync(filename).ino, history = getDrizzleDb().$client.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all(); expect(history).toHaveLength(15);
  expect((await call("/api/prompts/comparisons/clear", "POST", { operationKey: randomUUID(), expectedGeneration: cap.data.generation, confirmRemoval: true })).response.status).toBe(200);
  const tombstone = (await call("/api/prompts/comparisons/" + first.data.id)).data; expect(tombstone.request).toBeNull(); expect(tombstone.attempts[0].chargeMicrousd).toBe(2000008);
  await stop(); await start(); expect(statSync(filename).ino).toBe(inode); expect(getDrizzleDb().$client.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(history);
  expect((await call("/api/prompts/comparisons/" + first.data.id)).data).toEqual(tombstone); expect((await call("/api/prompts/comparisons/capabilities")).data.models[0].admissionReason).toBe("overage_fuse"); expect(calls).toBe(1); expect(getDrizzleDb().$client.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
});
test("a real held request body cannot dispatch after comparison authority advances while it was being acquired", async () => {
  const value = await request(), bytes = Buffer.from(JSON.stringify(value)), half = Math.floor(bytes.byteLength / 2);
  const capture = spyOn(ComparisonStore.prototype, "capture"), before = capture.mock.calls.length;
  let socket!: ReturnType<typeof httpRequest>;
  const response = new Promise<{ status: number; text: string }>((resolve, reject) => {
    socket = httpRequest(url + "/api/prompts/comparisons", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": bytes.byteLength } }, result => {
      let text = ""; result.on("data", part => { text += part; }); result.on("end", () => resolve({ status: result.statusCode!, text }));
    }); socket.on("error", reject); socket.write(bytes.subarray(0, half));
  });
  try {
    const deadline = performance.now() + 3000;
    while (capture.mock.calls.length === before && performance.now() < deadline) await Bun.sleep(5);
    expect(capture.mock.calls.length).toBeGreaterThan(before);
    const cleared = await call("/api/prompts/comparisons/clear", "POST", { operationKey: randomUUID(), expectedGeneration: value.expectedGeneration, confirmRemoval: true }); expect(cleared.response.status).toBe(200);
    socket.end(bytes.subarray(half)); const rejected = await response; expect(rejected.status).toBe(409); expect(rejected.text).not.toContain("$& {{literal}}");
    expect(getDrizzleDb().$client.query("SELECT count(*) n FROM prompt_comparisons").get()).toEqual({ n: 0 }); expect(calls).toBe(0);
  } finally { capture.mockRestore(); socket.destroy(); }
});
