export const cursorConversation = "cursor-fixture-conversation";
export const cursorGeneration = "cursor-fixture-generation";
export function cursorHook(event: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ conversation_id: cursorConversation, generation_id: cursorGeneration, hook_event_name: event, cursor_version: "fixture-not-installed", workspace_roots: ["/private/synthetic workspace"],
    ...(event === "sessionEnd" ? { session_id: cursorConversation, reason: "completed" } : {}),
    ...(event === "beforeSubmitPrompt" ? { prompt: "Explain the synthetic result" } : {}),
    ...(event === "afterAgentResponse" ? { text: "Captured synthetic Cursor answer" } : {}),
    ...(event === "stop" ? { status: "completed", loop_count: 0 } : {}),
    ...(["postToolUse", "postToolUseFailure"].includes(event) ? { tool_name: "Shell", tool_use_id: "tool-fixture-1", tool_input: { command: "synthetic command" }, ...(event === "postToolUse" ? { tool_output: '{"exitCode":0,"stdout":"synthetic result"}', duration: 12 } : { error_message: "Synthetic timeout", failure_type: "timeout", duration: 12, is_interrupt: false }) } : {}), ...fields });
}
