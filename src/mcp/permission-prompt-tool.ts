import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const PERMISSION_PROMPT_TOOL = "permission_prompt";
export const PERMISSION_PROMPT_TOOL_ENV = "RUNPHANTOM_PERMISSION_PROMPT_TOOL";

const TOOL: Tool = {
  name: PERMISSION_PROMPT_TOOL,
  description: "Answers Claude Code permission prompts for the Run Phantom side pane (--permission-prompt-tool). It never grants a permission. Do not call it directly.",
  inputSchema: {
    type: "object",
    required: ["tool_name", "input"],
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
  },
};

function enabled(): boolean {
  return process.env[PERMISSION_PROMPT_TOOL_ENV] === "1";
}

export function permissionPromptTools(): Tool[] {
  return enabled() ? [TOOL] : [];
}

/**
 * Without --permission-prompt-tool, print mode denies any tool call that would
 * need a prompt. The side pane has no approval UI, so this gives the same
 * answer. AskUserQuestion is answered earlier by the PreToolUse hook in
 * claude-cli-chat.ts and only reaches this tool when that hook returns no
 * decision (for example when node is missing).
 */
export function callPermissionPromptTool(name: string, args: Record<string, unknown>) {
  if (name !== PERMISSION_PROMPT_TOOL || !enabled()) return undefined;
  const toolName = typeof args.tool_name === "string" && args.tool_name ? args.tool_name : "this tool";
  const decision = {
    behavior: "deny",
    message: `Run Phantom's side pane cannot show a permission prompt, so ${toolName} was denied. Explain in your reply what you wanted to do, or ask the user there.`,
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(decision) }] };
}
