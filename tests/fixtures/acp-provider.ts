import { appendFileSync } from "node:fs";
// Controlled native process fixture; this is not an authenticated provider or live model.
const mode = process.env.RUNPHANTOM_ACP_FIXTURE_MODE ?? process.argv[2] ?? "positive";
const sessionId = process.env.RUNPHANTOM_ACP_FIXTURE_SESSION_ID ?? "fixture_session";
let promptId: unknown;
let denied = false;
const receipt = process.env.RUNPHANTOM_ACP_FIXTURE_RECEIPT_PATH;
if (receipt) appendFileSync(receipt, JSON.stringify({ event: "birth", pid: process.pid, mode, cwd: process.cwd(), argv: process.argv }) + "\n");
if (mode.endsWith("slow_exit")) {
  setInterval(() => {}, 100);
  process.on("SIGTERM", () => {
    if (receipt) appendFileSync(receipt, JSON.stringify({ event: "term", pid: process.pid }) + "\n");
    setTimeout(() => process.exit(0), 250);
  });
}
function send(value: unknown) { process.stdout.write(JSON.stringify(value) + "\n"); }
function update(sessionUpdate: string, fields: Record<string, unknown> = {}, id = sessionId) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update: { sessionUpdate, ...fields } } });
}
function finish() {
  update("agent_message_chunk", { content: { type: "text", text: denied ? "Permission denied. " : "" } });
  update("agent_message_chunk", { content: { type: "text", text: "Fixture answer ✓" } });
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
}
let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  while (input.includes("\n")) {
    const index = input.indexOf("\n");
    const frame = JSON.parse(input.slice(0, index)) as Record<string, any>;
    input = input.slice(index + 1);
    switch (frame.method) {
      case "initialize":
        if (mode.startsWith("hold_initialize")) break;
        if (mode === "malformed") { process.stdout.write('{"jsonrpc":\n'); break; }
        if (mode === "utf8") { process.stdout.write(Buffer.from([0xc3, 0x28, 10])); break; }
        if (mode === "oversize") { process.stdout.write("x".repeat(65_537)); break; }
        if (mode === "duplicate") { process.stdout.write(`{"jsonrpc":"2.0","id":${frame.id},"result":{"protocolVersion":1,"protocol\\u0056ersion":2}}\n`); break; }
        if (mode === "lossy") { process.stdout.write(`{"jsonrpc":"2.0","id":${frame.id},"result":{"protocolVersion":1,"extra":9007199254740993}}\n`); break; }
        if (mode === "wrong_response") { send({ jsonrpc: "2.0", id: 50, result: {} }); break; }
        if (mode === "exit") process.exit(3);
        if (mode === "stderr") { process.stderr.write("synthetic-private-key-never-reflect"); process.exit(2); }
        send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: mode === "wrong_version" ? 2 : 1, agentCapabilities: { loadSession: mode !== "no_load" }, agentInfo: { name: "Controlled ACP fixture", version: "fixture-1" }, authMethods: [{ id: "fixture-login" }] } });
        break;
      case "session/new":
        if (mode === "auth") { send({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: "synthetic-private-auth-details", data: { key: "synthetic-private-key" } } }); break; }
        send({ jsonrpc: "2.0", id: frame.id, result: { sessionId } });
        break;
      case "session/load":
        if (mode === "hold_load") break;
        update("user_message_chunk", { content: { type: "text", text: "Old prompt" } });
        update("agent_message_chunk", { content: { type: "text", text: "Old response must not repeat" } });
        send({ jsonrpc: "2.0", id: frame.id, result: {} });
        break;
      case "session/prompt":
        promptId = frame.id;
        if (mode === "same_chunk_fault") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } }) + '\n{"jsonrpc":"2.0","method":"unadvertised_notification","params":{}}\n');
          break;
        }
        if (mode.startsWith("hold_prompt")) { update("agent_message_chunk", { content: { type: "text", text: "Partial answer" } }); break; }
        if (mode === "foreign") { update("agent_message_chunk", { content: { type: "text", text: "Foreign private content" } }, "foreign_session"); break; }
        if (mode === "unknown") { update("future_unsupported_update", { arbitrary: "Synthetic" }); break; }
        if (mode === "terminal_stop") { send({jsonrpc:"2.0",id:promptId,result:{stopReason:"max_tokens"}});break; }
        if (mode === "client_fs") { send({jsonrpc:"2.0",id:"fs1",method:"fs/read_text_file",params:{sessionId,path:"/never-read-private-file"}});break; }
        if (mode === "repeat_permission") {
          const request={jsonrpc:"2.0",id:"repeat1",method:"session/request_permission",params:{sessionId,toolCall:{title:"Fixture tool"},options:[]}};
          send(request);send(request);break;
        }
        if (mode === "many_frames") { for(let i=0;i<4_097;i++)update("current_mode_update",{currentModeId:"fixture"});break; }
        if (mode === "response_limit") { for (let i = 0; i < 65; i++) update("agent_message_chunk", { content: { type: "text", text: "x".repeat(1_024) } }); break; }
        update("agent_thought_chunk", { content: { type: "text", text: "Fixture thought" } });
        update("tool_call", { toolCallId: "tool1", title: "Read fixture", status: "pending" });
        update("tool_call_update", { toolCallId: "tool1", status: "failed" });
        update("plan", { entries: [{ content: "One fixture step", status: "completed", priority: "medium" }] });
        update("available_commands_update", { availableCommands: [{ name: "fixture-command", description: "Fixture only" }] });
        send({ jsonrpc: "2.0", id: "permission1", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tool1", title: "Read fixture" }, options: mode === "allow_only" ? [{ optionId: "allow", name: "Allow", kind: "allow_once" }] : [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } });
        break;
      case "session/cancel":
        update("agent_message_chunk", { content: { type: "text", text: "Late response must not escape cancellation" } });
        send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
        break;
      default:
        if(frame.id === "fs1") { if(frame.error?.code !== -32601)process.exit(8);finish(); }
        if (frame.id === "permission1") {
          denied = frame.result?.outcome?.optionId === "reject" || frame.result?.outcome?.outcome === "cancelled";
          if (!denied) process.exit(9);
          finish();
        }
    }
  }
}
export {};
