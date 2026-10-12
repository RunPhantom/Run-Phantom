import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb, upsertRun } from "../src/db";
import { createServer } from "../src/server";
import { runMcpServer, type McpServerHandle } from "../src/mcp/index";
import { EVIDENCE_READER_IDENTITY } from "../src/evaluations/evidence-import";
import { evidenceDigest } from "../src/evaluations/evidence-validation";
import { callEvaluationTool } from "../src/mcp/evaluation-tools";

let client: Client, mcp: McpServerHandle, server: import("node:http").Server, directory: string, oldDb: string | undefined, base: string;
const raw = Buffer.from('<testsuite tests="1"><testcase name="MCP actual report"/></testsuite>');
beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "runphantom-evidence-mcp-")); oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "actual.db");
  ({ server } = await createServer(0)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  upsertRun({ id: "actual-run", started_at: 1, last_updated_at: 1 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = await runMcpServer({ url: base, transport: serverTransport }); client = new Client({ name: "actual-evidence-client", version: "1" }); await client.connect(clientTransport);
});
afterEach(async () => {
  await client.close(); await mcp.close(); await new Promise<void>(resolve => server.close(() => resolve())); closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb; rmSync(directory, { recursive: true, force: true });
});
async function call(args: Record<string, unknown>) {
  const result = await client.callTool({ name: "eval_evidence", arguments: args }); return JSON.parse((result.content as { text: string }[])[0].text);
}
function request() { return { ...EVIDENCE_READER_IDENTITY, operationKey: "mcp-operation", target: null, inventory: null, attachment: { kind: "run", id: "actual-run" }, retention: "raw_and_normalized",
  sources: [{ sourceId: "unit", shardId: "unit", kind: "junit", dialect: "junit-xml/v1", artifactSha256: evidenceDigest(raw), byteLength: raw.length }] }; }
test("actual MCP client uses the binary import, durable status, minimized report and explicit raw actions", async () => {
  expect((await client.listTools()).tools.some(tool => tool.name === "eval_evidence")).toBe(true);
  const receipt = await call({ action: "import", request: request(), sources: [{ sourceId: "unit", base64: raw.toString("base64") }] });
  let job = receipt.job;
  for (let count = 0; count < 200 && ["queued", "running"].includes(job.status); count++) {
    job = (await call({ action: "status", operationKey: "mcp-operation" })).job; await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(job).toMatchObject({ id: receipt.job.id, status: "completed" });
  const report = await call({ action: "report", setId: job.setId });
  expect(report).toMatchObject({ format: "runphantom-evidence-report/v1", revision: { coverage: "not_declared" } });
  expect(report.sources[0].observation).toMatchObject({ reportOutcome: "reports_pass", leafCounts: { executed: "1" } });
  expect(JSON.stringify(report)).not.toContain("bytesBase64");
  const downloaded = await call({ action: "raw", setId: job.setId, sourceId: "unit", revision: 1 });
  expect(Buffer.from(downloaded.bytesBase64, "base64")).toEqual(raw);
  expect((await call({ action: "retention_delete", setId: job.setId, kind: "raw", revision: 1 })).removed).toBe(1);
  expect(await call({ action: "raw", setId: job.setId, sourceId: "unit", revision: 1 }).catch(error => error)).toMatchObject({ code: ErrorCode.InvalidParams });
});
test("closed MCP action and predecode length/order checks refuse paths, hidden fields and oversized bytes", async () => {
  for (const args of [{ action: "import", request: request(), sources: [{ sourceId: "wrong", base64: raw.toString("base64") }] },
    { action: "import", request: request(), sources: [{ sourceId: "unit", base64: "x".repeat(2_796_205) }] },
    { action: "import", request: request(), sources: [{ sourceId: "unit", base64: raw.toString("base64") }], path: "/private/report" },
    { action: "status", jobId: "id", operationKey: "key" }, { action: "status", jobId: "id", sourceId: "raw-attempt" }]) {
    expect(await call(args).catch(error => error)).toMatchObject({ code: ErrorCode.InvalidParams });
  }
  let accessed = 0; const accessor = { get action() { accessed++; return "status"; }, jobId: "absent" };
  expect(await callEvaluationTool("eval_evidence", accessor, base).catch(error => error)).toMatchObject({ code: ErrorCode.InvalidParams }); expect(accessed).toBe(0);
  expect(getDrizzleDb().$client.query("SELECT count(*) AS n FROM evaluation_evidence_jobs").get()).toEqual({ n: 0 });
  expect((await client.listTools()).tools.some(tool => tool.name === "eval_dataset")).toBe(true);
});
