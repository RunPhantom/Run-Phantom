import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "../../src/server";
import { closeDb, getDrizzleDb, getRunWithSpans, upsertRun } from "../../src/db";
import { saveAgentsConfig } from "../../src/agents-config";
import { decodeCodexRollout, codexSnapshotOtlp } from "../../src/coding-hooks/codex";
import { codexJsonl, codexRecords, codexSession } from "./coding-hooks-codex";

let health = 0, posts = 0, origin = "";
const cwd = process.cwd(), eventName = "private-replay-fixture";
function sdkBatch(traceId: string, replayRunId?: string) {
  const attributes = { "ai.operationId": "ai.generateText", "ai.prompt.messages": JSON.stringify([{ role: "user", content: "Synthetic SDK context" }]), "ai.response.text": "Synthetic SDK result", ...(replayRunId ? { "runphantom.replay.run_id": replayRunId } : {}) };
  return { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId, spanId: "1234567890abcdef", name: "ai.generateText", startTimeUnixNano: "1000000000", endTimeUnixNano: "1001000000", status: { code: 1 }, attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: { stringValue: value } })) }] }] }] };
}
const agent = createHttpServer((req, res) => {
  if (req.url === "/health") {
    health++; res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, eventName, cwd, command: "bun fixture-agent.ts" })); return;
  }
  posts++; const chunks: Buffer[] = [];
  req.on("data", chunk => chunks.push(Buffer.from(chunk)));
  req.on("end", () => { void (async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { replayRunId: string };
    const ingested = await fetch(origin + "/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sdkBatch("b".repeat(32), body.replayRunId)) });
    if (!ingested.ok) throw new Error("fixture replay trace refused");
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ replayId: "synthetic-attempt" }));
  })().catch(error => { res.statusCode = 500; res.end(String(error)); }); });
});
const runtime = await createServer(0);
try {
  await new Promise<void>(resolve => runtime.server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  await new Promise<void>(resolve => agent.listen(0, "127.0.0.1", resolve));
  saveAgentsConfig({ [eventName]: { url: `http://127.0.0.1:${(agent.address() as { port: number }).port}/replay`, prefillFromTrace: { source: "run.id" } } });
  const decoded = decodeCodexRollout(codexJsonl(codexRecords(cwd)), { sessionId: codexSession, cwd });
  if (decoded.status !== "accepted") throw new Error(decoded.reason);
  const ingest = await fetch(origin + "/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(codexSnapshotOtlp(decoded.value, "private-replay-authority")) });
  if (!ingest.ok) throw new Error("observation ingest refused");
  const db = getDrizzleDb().$client;
  const run = db.query("SELECT id,started_at,last_updated_at FROM runs LIMIT 1").get() as { id: string; started_at: number; last_updated_at: number };
  upsertRun({ ...run, event_name: eventName });
  const validated = getRunWithSpans(run.id).spans.every(span => span.normalized.capture?.contract === "runphantom.codex-hook.observation/v1");
  const rows = () => JSON.stringify([db.query("SELECT * FROM runs ORDER BY id").all(), db.query("SELECT * FROM spans ORDER BY run_id,id").all()]);
  const before = rows(), agentsBefore = readFileSync(path.join(process.env.HOME!, ".runphantom/agents.json"), "utf8");
  const replay = await fetch(origin + "/api/replay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: run.id, userMessage: "Explicit override must not grant observation replay", model: "fixture-model", systemPrompt: "override", contextOverrides: { source: "override" } }) });
  const observationEvents = await replay.text();
  const context = await fetch(origin + "/api/replay/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: run.id, eventName }) });
  const observation = { validated, events: observationEvents, contextStatus: context.status, context: await context.json(), health, posts, rowsUnchanged: before === rows(), agentConfigUnchanged: agentsBefore === readFileSync(path.join(process.env.HOME!, ".runphantom/agents.json"), "utf8") };
  const mixedIngest = await fetch(origin + "/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sdkBatch(run.id)) });
  if (!mixedIngest.ok) throw new Error("mixed SDK control refused");
  const beforeMixed = rows(), callsBeforeMixed = { health, posts };
  const mixed = await fetch(origin + "/api/replay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: run.id }) });
  const mixedObservation = { events: await mixed.text(), rowsUnchanged: beforeMixed === rows(), noAgentCalls: health === callsBeforeMixed.health && posts === callsBeforeMixed.posts };
  const ordinaryId = "c".repeat(32);
  const ordinaryIngest = await fetch(origin + "/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sdkBatch(ordinaryId)) });
  if (!ordinaryIngest.ok) throw new Error("SDK ingest refused");
  const ordinary = db.query("SELECT started_at,last_updated_at FROM runs WHERE id=?").get(ordinaryId) as { started_at: number; last_updated_at: number };
  upsertRun({ id: ordinaryId, ...ordinary, event_name: eventName });
  const ordinaryReplay = await fetch(origin + "/api/replay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: ordinaryId }) });
  const ordinaryEvents = await ordinaryReplay.text();
  const ordinaryPositive = { events: ordinaryEvents, health, posts, normalizedSdk: getRunWithSpans(ordinaryId).spans[0].normalized.kind === "llm" };
  upsertRun({ id: "empty-sdk", name: "No LLM", event_name: eventName, started_at: 100, last_updated_at: 101 });
  const beforeEmpty = { health, posts };
  const empty = await fetch(origin + "/api/replay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: "empty-sdk" }) });
  const ordinaryNegative = { events: await empty.text(), noAgentCalls: health === beforeEmpty.health && posts === beforeEmpty.posts };
  process.stdout.write(JSON.stringify({ observation, mixedObservation, ordinaryPositive, ordinaryNegative }) + "\n");
} finally {
  await new Promise<void>((resolve, reject) => agent.close(error => error ? reject(error) : resolve()));
  runtime.server.closeAllConnections(); await new Promise<void>((resolve, reject) => runtime.server.close(error => error ? reject(error) : resolve())); closeDb();
}
