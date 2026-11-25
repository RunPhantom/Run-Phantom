import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { clearAll, closeDb, getDrizzleDb } from "../src/db";
import { createServer } from "../src/server";
import { runMcpServer } from "../src/mcp/index";
import { clearRunFactsCache } from "../src/stats/run-facts";
import { _runSearchInternal } from "../src/run-search";

type Attributes = Record<string, string | number>;
interface SpanSpec { id: string; parent?: string; name: string; attributes?: Attributes; startMs: number; endMs: number; status?: 1 | 2 }

let directory: string;
let oldDb: string | undefined;
let origin: string;
let server: Awaited<ReturnType<typeof createServer>>["server"];
const NOW = Date.now() - 60_000;

const otlpAttributes = (attributes: Attributes) => Object.entries(attributes).map(([key, value]) => ({
  key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
}));
const traceId = (n: number) => n.toString(16).padStart(32, "0");
const spanId = (id: string) => Buffer.from(id).toString("hex").padEnd(16, "0").slice(0, 16);

function otlp(trace: number, resource: Attributes, spans: SpanSpec[]) {
  return { resourceSpans: [{ resource: { attributes: otlpAttributes(resource) }, scopeSpans: [{ scope: { name: "agent-identity-fixture" }, spans: spans.map(span => ({
    traceId: traceId(trace), spanId: spanId(span.id), ...(span.parent ? { parentSpanId: spanId(span.parent) } : {}), name: span.name, kind: 1,
    startTimeUnixNano: `${span.startMs}000000`, endTimeUnixNano: `${span.endMs}000000`,
    attributes: otlpAttributes(span.attributes ?? {}), status: { code: span.status ?? 1 },
  })) }] }] };
}

async function ingest(body: unknown) {
  const response = await fetch(`${origin}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
}

const llm = (id: string, parent: string, at: number, extra: Attributes = {}): SpanSpec => ({
  id, parent, name: "chat gpt-4o-mini", startMs: at + 10, endMs: at + 400,
  attributes: { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "openai", "gen_ai.request.model": "gpt-4o-mini", "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 20, ...extra },
});

async function seed() {
  // examples/tool-agent: the event name carries the run title, gen_ai.agent.name the agent.
  for (const [index, title] of ["Turn 2 · Order follow-up", "Refund a damaged order"].entries()) {
    const at = NOW - (index + 1) * 10_000;
    await ingest(otlp(1 + index, { "service.name": "runphantom-tool-agent" }, [
      { id: "root", name: "invoke_agent support-agent", startMs: at, endMs: at + 1_000, status: index === 1 ? 2 : 1, attributes: {
        "runphantom.span.kind": "agent_root", "runphantom.event.name": title, "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "support-agent" } },
      llm("llm", "root", at, { "gen_ai.agent.name": "support-agent" }),
      { id: "tool", parent: "root", name: "execute_tool delegate_research", startMs: at + 500, endMs: at + 900, attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "delegate_research" } },
      { id: "sub", parent: "tool", name: "invoke_agent researcher", startMs: at + 510, endMs: at + 890, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "researcher" } },
    ]));
  }
  await ingest(otlp(3, { "service.name": "billing-service" }, [
    { id: "root", name: "BillingAgent", startMs: NOW - 40_000, endMs: NOW - 39_000, attributes: { "openinference.span.kind": "AGENT", "agent.name": "billing-agent", "input.value": "Why was I charged twice?" } },
    { id: "llm", parent: "root", name: "ChatCompletion", startMs: NOW - 39_900, endMs: NOW - 39_500, attributes: { "openinference.span.kind": "LLM", "llm.model_name": "gpt-4o-mini", "llm.token_count.prompt": 50, "llm.token_count.completion": 5 } },
  ]));
  await ingest(otlp(4, { "service.name": "unknown_service:node" }, [
    { id: "root", name: "TriageAgent", startMs: NOW - 50_000, endMs: NOW - 49_000, attributes: { "openinference.span.kind": "AGENT", "input.value": "Route this ticket" } },
  ]));
  await ingest(otlp(5, { "service.name": "checkout-bot" }, [
    { id: "root", name: "POST /chat", startMs: NOW - 60_000, endMs: NOW - 59_000, attributes: { "http.request.method": "POST" } },
    llm("llm", "root", NOW - 60_000),
  ]));
  await ingest(otlp(6, { "service.name": "web" }, [
    { id: "root", name: "ai.generateText", startMs: NOW - 70_000, endMs: NOW - 69_000, attributes: {
      "ai.operationId": "ai.generateText", "ai.telemetry.metadata.runphantom.eventName": "triage_agent", "ai.model.id": "gpt-4o-mini", "ai.usage.promptTokens": 10, "ai.usage.completionTokens": 2 } },
  ]));
  await ingest(otlp(7, { "service.name": "crm" }, [
    { id: "root", name: "lead_scorer.workflow", startMs: NOW - 80_000, endMs: NOW - 79_000, attributes: {
      "traceloop.span.kind": "workflow", "traceloop.entity.name": "lead_scorer", "traceloop.association.properties.event_name": "lead_scorer" } },
  ]));
  // An HTTP root wraps the agent span; the event name is still a per-run title and the deeper researcher must not win.
  await ingest(otlp(8, { "service.name": "concierge-api" }, [
    { id: "root", name: "POST /chat", startMs: NOW - 90_000, endMs: NOW - 89_000, attributes: { "http.request.method": "POST", "runphantom.event.name": "Rebook a cancelled flight" } },
    { id: "agent", parent: "root", name: "invoke_agent concierge-agent", startMs: NOW - 89_990, endMs: NOW - 89_010, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "concierge-agent" } },
    { id: "tool", parent: "agent", name: "execute_tool delegate_research", startMs: NOW - 89_900, endMs: NOW - 89_100, attributes: { "gen_ai.operation.name": "execute_tool" } },
    { id: "sub", parent: "tool", name: "invoke_agent researcher", startMs: NOW - 89_890, endMs: NOW - 89_110, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "researcher" } },
  ]));
  await ingest(otlp(9, { "service.name": "intake-api" }, [
    { id: "root", name: "POST /intake", startMs: NOW - 100_000, endMs: NOW - 99_000, attributes: { "http.request.method": "POST", "runphantom.event.name": "New patient intake" } },
    { id: "agent", parent: "root", name: "invoke_agent intake-agent", startMs: NOW - 99_990, endMs: NOW - 99_010, attributes: { "gen_ai.operation.name": "invoke_agent" } },
    { id: "sub", parent: "agent", name: "invoke_agent researcher", startMs: NOW - 99_980, endMs: NOW - 99_020, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "researcher" } },
  ]));
}

const EXPECTED: Record<string, { agent: string; title: string }> = {
  [traceId(1)]: { agent: "support-agent", title: "Turn 2 · Order follow-up" },
  [traceId(2)]: { agent: "support-agent", title: "Refund a damaged order" },
  [traceId(3)]: { agent: "billing-agent", title: "BillingAgent" },
  [traceId(4)]: { agent: "TriageAgent", title: "TriageAgent" },
  [traceId(5)]: { agent: "checkout-bot", title: "POST /chat" },
  [traceId(6)]: { agent: "triage_agent", title: "triage_agent" },
  [traceId(7)]: { agent: "lead_scorer", title: "lead_scorer" },
  [traceId(8)]: { agent: "concierge-agent", title: "Rebook a cancelled flight" },
  [traceId(9)]: { agent: "intake-agent", title: "New patient intake" },
};

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-agent-identity-"));
  oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "runs.db");
  getDrizzleDb();
  ({ server } = await createServer(0));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => { clearAll(); clearRunFactsCache(); await seed(); });
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  const until = Date.now() + 10_000;
  while (_runSearchInternal.activeWorkers() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});

const json = async <T>(route: string): Promise<T> => {
  const response = await fetch(`${origin}${route}`);
  expect(response.status).toBe(200);
  return await response.json() as T;
};
const title = (run: { display_name: string | null; event_name: string | null; name: string | null }) => run.display_name || run.event_name || run.name;

describe("one agent identity across the API", () => {
  test("GET /api/runs keeps the agent and the run title apart and filters on the agent", async () => {
    const rows = await json<Array<{ id: string; agent: string | null; display_name: string | null; event_name: string | null; name: string | null }>>("/api/runs");
    expect(Object.fromEntries(rows.map(row => [row.id, { agent: row.agent, title: title(row) }]))).toEqual(EXPECTED);
    const support = await json<Array<{ id: string }>>("/api/runs?agent=support-agent");
    expect(support.map(row => row.id).sort()).toEqual([traceId(1), traceId(2)]);
    expect(await json<unknown[]>(`/api/runs?agent=${encodeURIComponent("Turn 2 · Order follow-up")}`)).toEqual([]);
    expect((await json<Array<{ id: string }>>("/api/runs?q=checkout-bot")).map(row => row.id)).toEqual([traceId(5)]);
  });

  test("GET /api/overview groups by agent and filters on it", async () => {
    type Overview = { byAgent: Array<{ agent: string | null; runs: number }>; recentFailures: Array<{ runId: string; name: string; agent: string | null }>; kpis: { activeAgents: { value: number } } };
    const overview = await json<Overview>("/api/overview?window=24h");
    expect(overview.byAgent.map(row => [row.agent, row.runs])).toEqual([
      ["support-agent", 2], ["TriageAgent", 1], ["billing-agent", 1], ["checkout-bot", 1], ["concierge-agent", 1], ["intake-agent", 1], ["lead_scorer", 1], ["triage_agent", 1],
    ]);
    expect(overview.kpis.activeAgents.value).toBe(8);
    expect(overview.recentFailures).toMatchObject([{ runId: traceId(2), name: "Refund a damaged order", agent: "support-agent" }]);
    const filtered = await json<Overview>("/api/overview?window=24h&agent=support-agent");
    expect(filtered.byAgent.map(row => [row.agent, row.runs])).toEqual([["support-agent", 2]]);
  });

  test("search, run outline, the active run and MCP search_runs report the same agent", async () => {
    const search = await json<{ runs: Array<{ id: string; agent: string | null }> }>("/api/runs/search");
    expect(Object.fromEntries(search.runs.map(row => [row.id, row.agent]))).toEqual(Object.fromEntries(Object.entries(EXPECTED).map(([id, value]) => [id, value.agent])));
    const ranked = await json<{ runs: Array<{ id: string; agent: string | null }> }>("/api/runs/search?q=Order%20follow-up");
    expect(ranked.runs).toMatchObject([{ id: traceId(1), agent: "support-agent" }]);
    expect((await json<{ run: { agent: string | null } }>(`/api/runs/${traceId(3)}/outline`)).run.agent).toBe("billing-agent");
    expect((await json<{ id: string; agent: string | null }>("/api/runs/active")).agent).toBe(EXPECTED[(await json<{ id: string }>("/api/runs/active")).id].agent);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = await runMcpServer({ url: origin, transport: serverTransport });
    const client = new Client({ name: "agent-identity-test", version: "1" });
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({ name: "search_runs", arguments: { q: "Refund a damaged order" } });
      expect(JSON.parse((response.content as { text: string }[])[0].text).runs).toMatchObject([{ id: traceId(2), agent: "support-agent" }]);
    } finally {
      await client.close(); await mcp.close();
    }
  });

  test("an agent name over the hint limit is cut the same way by the run list and search", async () => {
    const long = `${"agent-".repeat(200)}😀${"x".repeat(400)}`;
    await ingest(otlp(10, { "service.name": "long-names" }, [
      { id: "root", name: "invoke_agent", startMs: NOW - 5_000, endMs: NOW - 4_000, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": long } },
    ]));
    const listed = (await json<Array<{ id: string; agent: string | null }>>("/api/runs")).find(row => row.id === traceId(10))!.agent!;
    const searched = (await json<{ runs: Array<{ id: string; agent: string | null }> }>("/api/runs/search")).runs.find(row => row.id === traceId(10))!.agent;
    expect([...listed]).toHaveLength(1024);
    expect(long.startsWith(listed)).toBe(true);
    expect(searched).toBe(listed);
    expect((await json<Array<{ id: string }>>(`/api/runs?agent=${encodeURIComponent(searched!)}`)).map(row => row.id)).toEqual([traceId(10)]);
  });
});
