import fs from "fs";
import os from "os";
import path from "path";
import { SOURCE_ENTRY } from "./source-paths";
import { IS_PACKAGED_RUNTIME } from "./version";

export type AgentProviderId = "claude" | "codex";
export type AgentAnnotationSource = "claude-code" | "codex";

export interface AgentLoadout {
  tools: string[];
  mcps: string[];
  skills: string[];
  plugins: string[];
  slash_commands?: string[];
  model?: string;
}

export type AgentStreamEvent =
  | { type: "provider_session"; sessionId: string }
  | ({ type: "loadout" } & AgentLoadout)
  | { type: "text"; content: string }
  | { type: "status"; content: string }
  | { type: "error"; content: string }
  | { type: "tool_start"; id: string; name: string; input_preview?: string }
  | { type: "tool_finish"; id: string; ok: boolean; output_preview?: string }
  | { type: "thinking_delta"; content: string }
  | { type: "subagent_start"; parent_id: string; subagent: string }
  | { type: "permission_denied"; tool: string; reason: string }
  | { type: "usage"; input_tokens?: number; output_tokens?: number; cost_usd?: number }
  | { type: "done" };

export interface AgentCliChatInput {
  backendUrl: string;
  content: string;
  cwd: string;
  runId?: string | null;
  sessionId?: string | null;
  userMessageId?: string | null;
  resumeSessionId?: string | null;
  abortSignal?: AbortSignal;
}

export interface AgentCliChatHandlers {
  onEvent?(event: AgentStreamEvent): void;
  onProviderSession(sessionId: string): void;
  onText(content: string): void;
  onStatus(status: string): void;
  onError?(content: string): void;
}

export interface AgentCliChatResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export const RUN_PHANTOM_MCP_TOOLS = [
  { name: "get_current_run", description: "resolve the focused Run Phantom run and selected span" },
  { name: "query_traces", description: "run read-only SQL over local trace tables" },
  { name: "get_span_payload", description: "read raw input or output payload slices for a span" },
  { name: "annotate", description: "create durable run or span annotations" },
  { name: "get_run_outline", description: "summarize a run's structure before reading payloads" },
  { name: "ask_agent", description: "ask the captured agent context about a trace" },
  { name: "replay_run", description: "replay a run through the registered local agent" },
  { name: "search_run", description: "search a run's span payloads, attributes, and live events" },
  { name: "get_span_context", description: "read nearby span skeletons around a span of interest" },
  { name: "show_in_ui", description: "open runs, filters, or drafted notes in the Run Phantom UI" },
] as const;

const STATE_PATH = path.join(os.homedir(), ".runphantom", "agent-provider.json");

export function getAgentProvider(): AgentProviderId {
  const envProvider = parseAgentProvider(process.env.RUNPHANTOM_AGENT_PROVIDER);
  if (envProvider) return envProvider;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as { provider?: unknown };
    return parseAgentProvider(parsed.provider) ?? "claude";
  } catch {
    return "claude";
  }
}

export function setAgentProvider(provider: AgentProviderId): AgentProviderId {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ provider, updated_at: new Date().toISOString() }, null, 2) + "\n");
  return provider;
}

export function parseAgentProvider(value: unknown): AgentProviderId | null {
  return value === "claude" || value === "codex" ? value : null;
}

export function defaultAgentLoadout(provider: AgentProviderId): AgentLoadout {
  return {
    tools: RUN_PHANTOM_MCP_TOOLS.map((tool) => `runphantom.${tool.name}`),
    mcps: ["runphantom"],
    skills: [],
    plugins: [],
    slash_commands: provider === "claude" ? [] : ["/clear", "/trace"],
  };
}

export function agentProviderLabel(provider: AgentProviderId): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

export function agentAnnotationSource(provider: AgentProviderId): AgentAnnotationSource {
  return provider === "codex" ? "codex" : "claude-code";
}

export interface RunPhantomSidepanelPromptInput {
  provider: AgentProviderId;
  localMcpName: string;
  runId?: string | null;
}

export function runPhantomSidepanelPrompt(input: RunPhantomSidepanelPromptInput): string {
  return [
    ...baseSidepanelInstructions(input.localMcpName),
    ...prioritizationInstructions(input.provider),
    providerCapabilities(input.provider),
    runInstruction(input.runId),
  ].join(" ");
}

function baseSidepanelInstructions(localMcpName: string): string[] {
  return [
    "You are replying inside the Run Phantom sidepanel.",
    "Run Phantom is the local-first diagnostics and replay UI for inspecting agent runs, spans, payloads, and annotations.",
    "You are the sidepanel coding assistant, not the captured agent whose trace is being inspected, unless a tool explicitly continues captured agent context.",
    "Your stdout is streamed directly into the Run Phantom chat UI.",
    "Use normal assistant text as your final answer. Markdown is supported.",
    `The local Run Phantom MCP server is configured as ${localMcpName}; its tool descriptions and schemas are authoritative.`,
    "Use the exact argument names and types from each MCP tool schema.",
    "For broad requests, understand the user's goal and inspect relevant local project context before selecting trace queries.",
    "When a concrete trace or span matters, show it in the Run Phantom UI as well as explaining it unless the user clearly wants text only.",
  ];
}

function prioritizationInstructions(provider: AgentProviderId): string[] {
  const localContext = provider === "claude"
    ? "Use relevant Claude Code memory, project context, and available MCPs."
    : "Use the active workspace, conversation context, and available MCPs.";
  return [
    "Treat open-ended prioritization questions as requests to gather local context before answering.",
    localContext,
    "Do not claim that you lack visibility until you have checked the relevant available context or identified the unavailable source.",
  ];
}

function providerCapabilities(provider: AgentProviderId): string {
  return provider === "claude"
    ? "You may also use the user's normal Claude Code tools, skills, memories, and MCP servers when relevant."
    : "You may also use your normal Codex workspace capabilities when relevant.";
}

function runInstruction(runId?: string | null): string {
  return runId
    ? `The current Run Phantom trace is ${runId}. When the user refers to this trace, screen, or selected span, use the local Run Phantom MCP server to inspect it.`
    : "No Run Phantom trace is selected. If the user asks about the current trace or screen, use the local Run Phantom MCP server to resolve the focused run.";
}

export function resolveRunPhantomMcpCommand(): { command: string; args: string[] } {
  if (!IS_PACKAGED_RUNTIME && fs.existsSync(SOURCE_ENTRY)) {
    return { command: process.execPath, args: [SOURCE_ENTRY, "mcp"] };
  }
  return { command: process.execPath, args: ["mcp"] };
}
