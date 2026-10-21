import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import type { AcpMcpServer } from "../../src/acp-sessions";
import type { VerificationReport } from "../../src/verification/protocol";

// Controlled ACP provider genuinely launches the real Run Phantom MCP child. No model/authentication claim.
const receipt = process.env.RUNPHANTOM_ACP_FIXTURE_RECEIPT_PATH!;
const id = `verification_${process.pid}`;
let servers: AcpMcpServer[] = [];
function record(value: unknown) { appendFileSync(receipt, JSON.stringify(value) + "\n"); }
record({ event: "birth", pid: process.pid, mode: "controlled_actual_mcp", cwd: process.cwd(), argv: process.argv });
function send(value: unknown) { process.stdout.write(JSON.stringify(value) + "\n"); }
function update(sessionUpdate: string, fields: Record<string, unknown>) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update: { sessionUpdate, ...fields } } }); }
let client: Client | undefined;
let transport: StdioClientTransport | undefined;
async function closeMcp() {
  const pid = transport?.pid;
  await client?.close(); await transport?.close();
  if (pid) { assert.throws(() => process.kill(pid, 0)); record({ event: "mcp_reaped", pid }); }
  client = undefined; transport = undefined;
}
process.on("SIGTERM", () => { void closeMcp().finally(() => process.exit(0)); });
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += String(chunk);
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"); const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (frame.method === "initialize") send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Controlled actual MCP provider", version: "fixture-1" }, authMethods: [] } });
    else if (frame.method === "session/new" || frame.method === "session/load") {
      servers = frame.params.mcpServers;
      assert.equal(servers.length, 1); assert.equal(servers[0]!.name, "runphantom_verification");
      send({ jsonrpc: "2.0", id: frame.id, result: frame.method === "session/new" ? { sessionId: id } : {} });
    } else if (frame.method === "session/prompt") {
      const spec = servers[0]!;
      const env = Object.fromEntries(spec.env.map(entry => [entry.name, entry.value]));
      assert.match(env.RUNPHANTOM_ACP_MCP_GRANT!, /^[a-f0-9]{64}$/);
      assert.match(env.RUNPHANTOM_URL!, /^http:\/\/127\.0\.0\.1:\d+$/);
      transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === "string")), ...env }, cwd: process.cwd(), stderr: "pipe" });
      client = new Client({ name: "controlled-ACP-verification-client", version: "1" });
      try {
        await client.connect(transport);
        record({ event: "mcp_birth", pid: transport.pid, cwd: process.cwd(), command: spec.command, args: spec.args });
        const tools = await client.listTools(); assert.deepEqual(tools.tools.map(tool => tool.name), ["app_observe", "app_assert"]);
        await assert.rejects(client.callTool({ name: "query_traces", arguments: { sql: "SELECT 1" } }));
        await assert.rejects(client.callTool({ name: "app_observe", arguments: { sessionId: "caller_target" } }));
        const endpoint = `${env.RUNPHANTOM_URL}/api/agent/acp/mcp/${env.RUNPHANTOM_ACP_MCP_GRANT}`;
        for (const url of [endpoint, endpoint.replace("/api/agent/", "/API/agent/") + "/"]) {
          const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"name":"app_observe","arguments":{"since":1,"sinc\\u0065":2}}' });
          assert.equal(response.status, 400);
        }
        const forbidden = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://foreign.invalid" }, body: JSON.stringify({ name: "app_observe", arguments: {} }) });
        assert.equal(forbidden.status, 403);
        record({ event: "negative_mcp_controls", unknownToolRejected: true, callerTargetRejected: true, rawDuplicateRejected: true, caseAndTrailingAliasRejected: true, foreignOriginRejected: true });
        const observation = await client.callTool({ name: "app_observe", arguments: {} });
        const observed = JSON.parse((observation.content as Array<{ text: string }>)[0]!.text);
        assert.equal(observed.session.connected, true);
        update("tool_call", { toolCallId: "actual_assert", title: "Run Phantom application check", status: "in_progress" });
        const prompt = frame.params.prompt[0]?.text as string;
        const selector = prompt.includes("missing") || prompt.includes("disconnect") ? "#missing" : "#verified";
        record({ event: "assert_started", pid: process.pid });
        const result = await client.callTool({ name: "app_assert", arguments: { predicate: { kind: "element", selector, state: "present" }, name: "Native ACP application check" } });
        const report = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as VerificationReport;
        assert.equal(report.sessionId, observed.session.id); assert.equal(report.runId, observed.session.runId);
        record({ event: "verification_report", report, controlledProvider: true, paidRequests: 0 });
        update("tool_call_update", { toolCallId: "actual_assert", title: "Run Phantom application check", status: "completed" });
        await closeMcp();
        update("agent_message_chunk", { content: { type: "text", text: `Verification report: ${report.status}. ${report.reason}` } });
        send({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
      } catch {
        await closeMcp();
        send({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "Controlled actual verification MCP unavailable" } });
      }
    }
  }
}
await closeMcp();
