export const codexSession = "019a0000-0000-7000-8000-000000000012";
export const codexTurn = "019a0000-0000-7000-8000-000000000013";
export function codexRecord(type: string, payload: unknown, second = 0) {
  return { timestamp: new Date(Date.UTC(2026, 9, 18, 10, 0, second)).toISOString(), type, payload };
}
/** Synthetic records matching the inspected 0.163.0 protocol; no live-provider provenance. */
export function codexRecords(cwd: string) {
  return [
    codexRecord("session_meta", { id: codexSession, session_id: codexSession, cwd, cli_version: "0.163.0" }),
    codexRecord("turn_context", { turn_id: codexTurn, cwd, model: "fixture-model" }),
    codexRecord("response_item", { type: "message", id: "msg-user", role: "user", content: [{ type: "input_text", text: "Find the café result" }] }, 1),
    codexRecord("response_item", { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"count\":0}" }, 2),
    codexRecord("response_item", { type: "function_call_output", call_id: "call_1", output: "safe synthetic business result" }, 3),
    codexRecord("response_item", { type: "message", id: "msg-assistant", role: "assistant", content: [{ type: "output_text", text: "Found the café result" }] }, 4),
    codexRecord("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 19, cached_input_tokens: 7, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 24 }, last_token_usage: { input_tokens: 19, output_tokens: 5 } } }, 5),
  ];
}
export const codexJsonl = (records: unknown[]): string => records.map(r => JSON.stringify(r)).join("\n") + "\n";
export function codexHook(cwd: string, transcript: string, event = "Stop") {
  return JSON.stringify({ session_id: codexSession, hook_event_name: event, cwd, transcript_path: transcript, turn_id: codexTurn, stop_hook_active: false, last_assistant_message: "This callback body is not the acquired transcript" });
}
