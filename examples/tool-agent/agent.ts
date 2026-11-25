import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { loadWorkspaceEnv } from "../loadEnv";
import {
  callModel, DEFAULT_MODELS, missingKeys, OTEL_PROVIDER_NAME, PROVIDERS, ProviderError,
  type Message, type ModelTurn, type Provider, type ToolCall,
} from "./providers";
import { DELEGATE_TOOL, FatalToolError, LOCAL_TOOLS, TOOL_DEFINITIONS, ToolError, type ToolDefinition } from "./tools";
import { runUrl, Trace, type Span } from "./tracing";

export const MAX_STEPS = 8;
const RESEARCHER_MAX_STEPS = 4;
const MAX_OUTPUT_TOKENS = 4096;

export const SUPPORT_SYSTEM_PROMPT = `You are the customer support agent for Northwind Audio & Outdoor.
Today is 2026-11-25. Use the tools; never guess order facts or policy.
- Look up the order before acting on it.
- Follow the refund policy from the knowledge base. When a refund is allowed, issue it right away for the full order total without asking for confirmation.
- If a tool fails, say plainly what could not be checked and offer the next best step. Do not retry a call that failed with the same arguments.
- Answer in at most four short sentences.`;

const DELEGATING_SYSTEM_PROMPT = `${SUPPORT_SYSTEM_PROMPT}
- For any warranty or policy question, call delegate_research instead of search_kb and base your answer on its findings.`;

const RESEARCHER_SYSTEM_PROMPT = `You are a research assistant for a support team. Search the knowledge base with search_kb,
then answer the question in two or three sentences, naming the article ids you relied on. Do not invent policy.`;

export interface TurnOptions {
  provider: Provider;
  model?: string;
  subagent?: boolean;
  conversationId: string;
  /** Run name shown in Run Phantom's run list. */
  eventName?: string;
  /** Messages from earlier turns of the same conversation. */
  history?: Message[];
  maxSteps?: number;
}

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  error?: string;
  /** Calls made by a nested agent while this call ran, such as the researcher's search_kb calls under delegate_research. */
  nested?: ToolCallRecord[];
}

export interface TurnResult {
  traceId: string;
  runUrl: string;
  ok: boolean;
  text: string;
  error?: string;
  /** The root span's error.type when the run failed, for example ledger_write_conflict or provider_error. */
  errorType?: string;
  steps: number;
  toolCalls: ToolCallRecord[];
  /** The conversation after this turn; unchanged from the input when the turn failed. */
  history: Message[];
  exportError?: string;
}

class AgentFailure extends Error {
  constructor(readonly type: string, message: string) {
    super(message);
    this.name = "AgentFailure";
  }
}

interface LoopContext {
  provider: Provider;
  model: string;
  agentSpan: Span;
  agentName: string;
  system: string;
  tools: ToolDefinition[];
  messages: Message[];
  maxSteps: number;
  execute: (call: ToolCall, toolSpan: Span, nested: ToolCallRecord[]) => Promise<unknown>;
  toolCalls: ToolCallRecord[];
  steps: { count: number };
}

function genAiInputMessages(messages: Message[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", parts: [{ type: "text", content: message.text }] };
    if (message.role === "assistant") {
      return {
        role: "assistant",
        parts: [
          ...(message.text ? [{ type: "text", content: message.text }] : []),
          ...message.toolCalls.map((call) => ({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments })),
        ],
      };
    }
    return { role: "tool", parts: [{ type: "tool_call_response", id: message.callId, response: message.content }] };
  });
}

function genAiOutputMessages(turn: ModelTurn): unknown[] {
  return [{
    role: "assistant",
    parts: [
      ...(turn.text ? [{ type: "text", content: turn.text }] : []),
      ...turn.toolCalls.map((call) => ({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments })),
    ],
    finish_reason: turn.finishReason,
  }];
}

function operationName(provider: Provider): "chat" | "generate_content" {
  return provider === "gemini" ? "generate_content" : "chat";
}

async function modelStep(context: LoopContext): Promise<ModelTurn> {
  const operation = operationName(context.provider);
  const span = context.agentSpan.child(`${operation} ${context.model}`, 3).set({
    "gen_ai.operation.name": operation,
    "gen_ai.provider.name": OTEL_PROVIDER_NAME[context.provider],
    "gen_ai.request.model": context.model,
    "gen_ai.request.max_tokens": MAX_OUTPUT_TOKENS,
    "gen_ai.agent.name": context.agentName,
    "gen_ai.system_instructions": JSON.stringify([{ type: "text", content: context.system }]),
    "gen_ai.input.messages": JSON.stringify(genAiInputMessages(context.messages)),
    "gen_ai.tool.definitions": JSON.stringify(context.tools.map((tool) => ({ type: "function", ...tool }))),
  });
  try {
    const turn = await callModel({
      provider: context.provider, model: context.model, system: context.system,
      messages: context.messages, tools: context.tools, maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    const { usage } = turn;
    span.set({
      "gen_ai.response.model": turn.responseModel,
      "gen_ai.response.id": turn.responseId,
      "gen_ai.response.finish_reasons": [turn.finishReason],
      "gen_ai.output.messages": JSON.stringify(genAiOutputMessages(turn)),
      "gen_ai.usage.input_tokens": usage.inputTokens,
      "gen_ai.usage.output_tokens": usage.outputTokens,
      "gen_ai.usage.cache_read.input_tokens": usage.cacheReadTokens,
      "gen_ai.usage.cache_creation.input_tokens": usage.cacheWriteTokens,
      "gen_ai.usage.output_tokens.reasoning": usage.reasoningTokens,
      "runphantom.usage.input_includes_cache": usage.inputTokens !== undefined ? true : undefined,
      "runphantom.usage.output_includes_reasoning": usage.outputTokens !== undefined ? true : undefined,
    });
    span.end();
    return turn;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    span.set({
      "error.type": failure instanceof ProviderError && failure.status ? String(failure.status) : failure.name,
      "gen_ai.output.messages": JSON.stringify({ error: failure.message }),
    });
    span.recordException(failure);
    span.end({ code: 2, message: failure.message });
    throw new AgentFailure("provider_error", failure.message);
  }
}

async function toolStep(context: LoopContext, call: ToolCall): Promise<Message> {
  const span = context.agentSpan.child(`execute_tool ${call.name}`).set({
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": call.name,
    "gen_ai.tool.type": "function",
    "gen_ai.tool.call.id": call.id,
    "gen_ai.tool.call.arguments": JSON.stringify(call.arguments),
    "gen_ai.agent.name": context.agentName,
  });
  const nested: ToolCallRecord[] = [];
  const nestedField = () => nested.length ? { nested } : {};
  try {
    const result = await context.execute(call, span, nested);
    const content = JSON.stringify(result);
    span.set({ "gen_ai.tool.call.result": content });
    span.end();
    context.toolCalls.push({ name: call.name, arguments: call.arguments, ok: true, ...nestedField() });
    return { role: "tool", callId: call.id, name: call.name, content, isError: false };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const type = failure instanceof ToolError ? failure.type : failure.name;
    span.set({ "error.type": type, "gen_ai.tool.call.result": JSON.stringify({ error: type, message: failure.message }) });
    span.recordException(failure);
    span.end({ code: 2, message: failure.message });
    context.toolCalls.push({ name: call.name, arguments: call.arguments, ok: false, error: failure.message, ...nestedField() });
    if (failure instanceof FatalToolError) throw new AgentFailure(failure.type, `${call.name} failed and the run was stopped: ${failure.message}`);
    return { role: "tool", callId: call.id, name: call.name, content: JSON.stringify({ error: type, message: failure.message }), isError: true };
  }
}

/** The model-calls-tools loop shared by the support agent and the researcher. Returns the final answer text. */
async function agentLoop(context: LoopContext): Promise<string> {
  for (let step = 1; step <= context.maxSteps; step++) {
    context.steps.count++;
    const turn = await modelStep(context);
    context.messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });
    if (turn.toolCalls.length === 0) {
      if (!turn.text.trim()) throw new AgentFailure("empty_response", `The model ended its turn without text or tool calls (finish reason: ${turn.finishReason}).`);
      return turn.text;
    }
    for (const call of turn.toolCalls) context.messages.push(await toolStep(context, call));
  }
  throw new AgentFailure("step_limit", `Stopped after ${context.maxSteps} model steps without a final answer.`);
}

function localTool(call: ToolCall): unknown {
  const tool = LOCAL_TOOLS[call.name];
  if (!tool) throw new ToolError("unknown_tool", `No tool named ${call.name}.`);
  return tool(call.arguments);
}

async function runResearcher(parent: LoopContext, call: ToolCall, toolSpan: Span, toolCalls: ToolCallRecord[]): Promise<unknown> {
  const question = typeof call.arguments.question === "string" ? call.arguments.question.trim() : "";
  if (!question) throw new ToolError("invalid_arguments", "Missing required string argument \"question\".");
  const agentSpan = toolSpan.child("invoke_agent researcher").set({
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "researcher",
    "gen_ai.provider.name": OTEL_PROVIDER_NAME[parent.provider],
    "gen_ai.request.model": parent.model,
    "runphantom.input": question,
  });
  const researchTools = TOOL_DEFINITIONS.filter((tool) => tool.name === "search_kb");
  try {
    const answer = await agentLoop({
      ...parent, agentSpan, agentName: "researcher", system: RESEARCHER_SYSTEM_PROMPT, tools: researchTools,
      messages: [{ role: "user", text: question }], maxSteps: RESEARCHER_MAX_STEPS,
      toolCalls, steps: { count: 0 },
      execute: async (inner) => localTool(inner),
    });
    agentSpan.set({ "runphantom.output": answer });
    agentSpan.end();
    return { answer };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentSpan.set({ "error.type": error instanceof AgentFailure ? error.type : "researcher_failed", "runphantom.output": message });
    agentSpan.end({ code: 2, message });
    throw new ToolError("researcher_failed", `The researcher agent failed: ${message}`);
  }
}

const RUN_NAME_LIMIT = 60;

/** The user's message, shortened, so runs started from the CLI can be told apart in the run list. */
export function defaultRunName(userText: string): string {
  const text = userText.replace(/\s+/g, " ").trim();
  if (!text) return "Support agent";
  if (text.length <= RUN_NAME_LIMIT) return text;
  const cut = text.slice(0, RUN_NAME_LIMIT - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > RUN_NAME_LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Runs one user turn as one trace: the support agent loop plus every model and tool span it produced. */
export async function runTurn(userText: string, options: TurnOptions): Promise<TurnResult> {
  const model = options.model || DEFAULT_MODELS[options.provider];
  const history = options.history ?? [];
  const trace = new Trace();
  const root = trace.startSpan("invoke_agent support-agent").set({
    "runphantom.span.kind": "agent_root",
    "runphantom.event.id": randomUUID(),
    "runphantom.event.name": options.eventName ?? defaultRunName(userText),
    "runphantom.conversation.id": options.conversationId,
    "runphantom.input": userText,
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "support-agent",
    "gen_ai.conversation.id": options.conversationId,
    "gen_ai.provider.name": OTEL_PROVIDER_NAME[options.provider],
    "gen_ai.request.model": model,
  });
  const messages: Message[] = [...history, { role: "user", text: userText }];
  const toolCalls: ToolCallRecord[] = [];
  const steps = { count: 0 };
  const context: LoopContext = {
    provider: options.provider, model, agentSpan: root, agentName: "support-agent",
    system: options.subagent ? DELEGATING_SYSTEM_PROMPT : SUPPORT_SYSTEM_PROMPT,
    tools: options.subagent ? [...TOOL_DEFINITIONS, DELEGATE_TOOL] : TOOL_DEFINITIONS,
    messages, maxSteps: options.maxSteps ?? MAX_STEPS, toolCalls, steps,
    execute: async (call, toolSpan, nested) => call.name === DELEGATE_TOOL.name && options.subagent
      ? runResearcher(context, call, toolSpan, nested)
      : localTool(call),
  };

  let result: Omit<TurnResult, "exportError">;
  try {
    const text = await agentLoop(context);
    root.set({ "runphantom.output": text });
    root.end();
    result = { traceId: trace.traceId, runUrl: runUrl(trace.traceId), ok: true, text, steps: steps.count, toolCalls, history: messages };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorType = error instanceof AgentFailure ? error.type : "agent_error";
    root.set({ "error.type": errorType, "runphantom.output": message });
    root.recordException(error instanceof Error ? error : new Error(message));
    root.end({ code: 2, message });
    result = { traceId: trace.traceId, runUrl: runUrl(trace.traceId), ok: false, text: "", error: message, errorType, steps: steps.count, toolCalls, history };
  }

  try {
    await trace.export();
    return result;
  } catch (error) {
    return { ...result, exportError: error instanceof Error ? error.message : String(error) };
  }
}

/** Every tool call in the turn, nested agents' calls included, in the order they finished. */
export function allToolCalls(calls: ToolCallRecord[]): ToolCallRecord[] {
  return calls.flatMap((call) => [...allToolCalls(call.nested ?? []), call]);
}

function describeCalls(calls: ToolCallRecord[], indent: string, lines: string[]): void {
  for (const call of calls) {
    lines.push(`${indent}tool ${call.name}(${JSON.stringify(call.arguments)}) ${call.ok ? "ok" : `failed: ${call.error}`}`);
    if (call.nested?.length) describeCalls(call.nested, `${indent}    `, lines);
  }
}

export function describeTurn(result: TurnResult): string {
  const lines: string[] = [];
  describeCalls(result.toolCalls, "  ", lines);
  lines.push(result.ok ? `agent: ${result.text}` : `run failed: ${result.error}`);
  if (!result.ok && /no longer available to new users/i.test(result.error ?? "")) {
    const replacement = /use models\/([\w.-]+)/i.exec(result.error ?? "")?.[1];
    lines.push(`  hint: this Gemini model is closed to new API keys; pass --model with ${replacement ? `${replacement} or another model` : "a model"} your key can use.`);
  }
  lines.push(result.exportError ? `trace not exported: ${result.exportError}` : `trace: ${result.runUrl}`);
  return lines.join("\n");
}

function parseProvider(value: string | undefined): Provider {
  const provider = (value ?? "openai").toLowerCase();
  if (!PROVIDERS.includes(provider as Provider)) throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}.`);
  return provider as Provider;
}

const USAGE = `Usage: bun agent.ts [options]

  --provider openai|anthropic|gemini   Model provider (default openai)
  --model <id>                         Override the default model for the provider
  --prompt <text>                      A user turn; repeat for a multi-turn conversation
  --interactive                        Chat in the terminal (exit or Ctrl-D to stop); turns share one conversation id
  --subagent                           Let the agent delegate policy research to a nested researcher agent
  --help                               Show this message`;

async function main(): Promise<number> {
  loadWorkspaceEnv(import.meta.url);
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      prompt: { type: "string", multiple: true },
      interactive: { type: "boolean", default: false },
      subagent: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const provider = parseProvider(values.provider);
  const missing = missingKeys([provider]);
  if (missing.length) {
    console.error(`${missing.join(", ")} is not set. Export it or add it to a .env file in this repository, then run again. Nothing was sent to Run Phantom.`);
    return 1;
  }
  const model = values.model || DEFAULT_MODELS[provider];
  const conversationId = `conv_${randomUUID()}`;
  console.log(`provider ${provider} · model ${model} · conversation ${conversationId}${values.subagent ? " · subagent on" : ""}`);

  let history: Message[] = [];
  let failures = 0;
  const turn = async (text: string) => {
    const result = await runTurn(text, { provider, model, subagent: values.subagent, conversationId, history });
    history = result.history;
    if (!result.ok || result.exportError) failures++;
    console.log(describeTurn(result));
  };

  if (values.interactive) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let inputEnded = false;
    terminal.once("close", () => { inputEnded = true; });
    terminal.setPrompt("\nyou> ");
    terminal.prompt();
    // The async iterator buffers lines that arrive while a turn is running, so piped input is not dropped.
    for await (const line of terminal) {
      const text = line.trim();
      if (text === "exit" || text === "quit") break;
      if (text) await turn(text);
      if (!inputEnded) terminal.prompt();
    }
    terminal.close();
    return failures ? 1 : 0;
  }

  const prompts = values.prompt?.length ? values.prompt : ["My order A1001 arrived with a cracked case. Can I get a refund?"];
  for (const text of prompts) {
    console.log(`\nyou: ${text}`);
    await turn(text);
  }
  return failures ? 1 : 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
