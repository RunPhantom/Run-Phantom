import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hasDuplicateJsonKeys } from "./json-keys";
import { parseJsonEvidence } from "./evaluations/json-evidence";
import type { AgentCliChatHandlers, AgentCliChatInput, AgentCliChatResult, AgentStreamEvent } from "./agent-chat";
import type { ClaudeSessionDetail, ClaudeSessionSummary } from "./claude-sessions";

const FRAME_BYTES = 65_536;
const WIRE_BYTES = 1_048_576;
const CONTENT_BYTES = 65_536;
const MAX_FRAMES = 4_096;
const MAX_CLIENT_REQUESTS = 64;
const MAX_SESSIONS = 32;
const MAX_MESSAGES = 64;
let activeProcesses = 0;

export type AcpFailure = "unavailable" | "unsupported_protocol" | "authentication_required" | "protocol_error" | "limit" | "timeout" | "cancelled" | "scope_changed" | "busy";

export class AcpSessionError extends Error {
  constructor(readonly category: AcpFailure, readonly unknownUpdate?: string) {
    super({
      unavailable: "OpenCode ACP is unavailable. Install the CLI and check its configuration.",
      unsupported_protocol: "OpenCode returned an unsupported ACP protocol version.",
      authentication_required: "OpenCode requires authentication. Sign in using its terminal CLI.",
      protocol_error: "OpenCode returned an unsupported or invalid ACP message. The response is incomplete.",
      limit: "The ACP session reached a Run Phantom size limit. The response is incomplete.",
      timeout: "OpenCode ACP exceeded the response deadline. The response is incomplete.",
      cancelled: "OpenCode ACP was cancelled.",
      scope_changed: "The selected workspace changed. The ACP response is incomplete.",
      busy: "OpenCode ACP is busy. Wait for the active turn to finish.",
    }[category]);
    this.name = "AcpSessionError";
  }
}

export interface AcpAvailability {
  available: boolean;
  authentication: "unknown" | "required";
  protocolVersion?: 1;
  version?: string;
  reason?: AcpFailure;
  sessions: "runphantom_current_daemon";
}

export interface AcpSessionDetail extends ClaudeSessionDetail {
  capture?: { status: "complete" | "incomplete"; reason?: AcpFailure; unknownUpdate?: string };
}

/** Command/environment are daemon-owned configuration, never request parameters. */
export interface AcpProcessOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onProcess?(pid: number): void;
}

export interface AcpMcpServer {
  name: "runphantom_verification";
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface AcpScope {
  isCurrent(): boolean;
  abortSignal?: AbortSignal;
  mcpServers?: AcpMcpServer[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AcpSessionError("protocol_error");
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || Buffer.byteLength(value) > max) throw new AcpSessionError("protocol_error");
  return value;
}

function sessionId(value: unknown): string {
  const id = text(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new AcpSessionError("protocol_error");
  return id;
}

function canonicalWorkspace(cwd: string): string {
  try {
    const result = realpathSync(cwd);
    if (!statSync(result).isDirectory()) throw new Error();
    return result;
  } catch { throw new AcpSessionError("unavailable"); }
}

class AcpConnection {
  readonly child: ChildProcessWithoutNullStreams;
  private pending: { id: number; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private nextId = 0;
  private frames = 0;
  private bytes = 0;
  private stderrBytes = 0;
  private clientRequests = 0;
  private clientRequestIds = new Set<string>();
  private buffer = Buffer.alloc(0);
  private failure: AcpSessionError | null = null;
  private stopped = false;
  private closed = false;
  private readonly exit: Promise<void>;
  private readonly lifetime: ReturnType<typeof setTimeout>;
  private forceKill: ReturnType<typeof setTimeout> | undefined;
  onUpdate: (params: Record<string, unknown>) => void = () => { throw new AcpSessionError("protocol_error"); };
  onPermission: (params: Record<string, unknown>) => boolean = () => false;

  constructor(cwd: string, private readonly options: AcpProcessOptions) {
    this.child = spawn(options.command ?? process.env.RUNPHANTOM_OPENCODE_BIN ?? "opencode",
      options.args ?? ["acp", "--cwd", cwd, "--hostname", "127.0.0.1", "--port", "0"], {
        cwd, env: options.env ?? { ...process.env }, stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    this.exit = new Promise<void>((resolve) => {
      this.child.once("close", () => {
        this.closed = true;
        clearTimeout(this.forceKill);
        if (!this.stopped) this.fail(new AcpSessionError(this.buffer.length ? "protocol_error" : "unavailable"));
        resolve();
      });
    });
    this.lifetime = setTimeout(() => this.fail(new AcpSessionError("timeout")), 180_000);
    this.child.on("error", () => this.fail(new AcpSessionError("unavailable")));
    this.child.stdin.on("error", () => this.fail(new AcpSessionError("unavailable")));
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.stopped || this.failure) return;
      try { this.consume(chunk); } catch (error) {
        this.fail(error instanceof AcpSessionError ? error : new AcpSessionError("protocol_error"));
      }
    });
    // Native diagnostics can contain credentials, paths and prompts. They are counted, not reflected.
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 16_384) this.fail(new AcpSessionError("limit"));
    });
    if (this.child.pid !== undefined) {
      try { options.onProcess?.(this.child.pid); } catch { this.fail(new AcpSessionError("unavailable")); }
    }
  }

  private consume(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > WIRE_BYTES) throw new AcpSessionError("limit");
    // Limit each complete or partial frame before allocating the next buffer.
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      const part = chunk.subarray(start, index);
      if (this.buffer.length + part.length > FRAME_BYTES) throw new AcpSessionError("limit");
      const frame = Buffer.concat([this.buffer, part]);
      this.buffer = Buffer.alloc(0);
      this.handle(frame);
      if (this.failure || this.stopped) return;
      start = index + 1;
    }
    if (this.buffer.length + chunk.length - start > FRAME_BYTES) throw new AcpSessionError("limit");
    this.buffer = Buffer.concat([this.buffer, chunk.subarray(start)]);
  }

  private handle(bytes: Buffer): void {
    if (++this.frames > MAX_FRAMES) throw new AcpSessionError("limit");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const frame = object(parseJsonEvidence(raw));
    if (hasDuplicateJsonKeys(raw) || frame.jsonrpc !== "2.0") throw new AcpSessionError("protocol_error");
    if (typeof frame.method === "string") {
      if ("result" in frame || "error" in frame) throw new AcpSessionError("protocol_error");
      const params = object(frame.params);
      if ("id" in frame) {
        const id = frame.id;
        if ((typeof id !== "string" && (typeof id !== "number" || !Number.isSafeInteger(id))) || (typeof id === "string" && (!id || id.length > 128))) throw new AcpSessionError("protocol_error");
        const key = `${typeof id}:${String(id)}`;
        if (++this.clientRequests > MAX_CLIENT_REQUESTS || this.clientRequestIds.has(key)) throw new AcpSessionError("limit");
        this.clientRequestIds.add(key);
        if (frame.method === "session/request_permission") {
          const acceptedSession = this.onPermission(params);
          const options = params.options;
          if (!Array.isArray(options) || options.length > 16) throw new AcpSessionError("protocol_error");
          const reject = options.map(object).find((option) => option.kind === "reject_once" || option.kind === "reject_always");
          const outcome = acceptedSession && !this.stopped && reject
            ? { outcome: "selected", optionId: text(reject.optionId, 128) }
            : { outcome: "cancelled" };
          this.send({ jsonrpc: "2.0", id, result: { outcome } });
        } else {
          // No client filesystem or terminal capability is advertised.
          this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Client capability unavailable" } });
        }
        return;
      }
      if (frame.method !== "session/update") throw new AcpSessionError("protocol_error");
      this.onUpdate(params);
      return;
    }
    if (frame.id !== this.pending?.id || (("result" in frame) === ("error" in frame))) throw new AcpSessionError("protocol_error");
    const pending = this.pending;
    if (!pending) throw new AcpSessionError("protocol_error");
    clearTimeout(pending.timer);
    this.pending = null;
    if ("error" in frame) {
      const error = object(frame.error);
      // ACP auth_required is -32000; provider error text/data never leaves this boundary.
      pending.reject(new AcpSessionError(error.code === -32000 ? "authentication_required" : "unavailable"));
    } else pending.resolve(frame.result);
  }

  private send(frame: unknown): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new AcpSessionError("unavailable");
    const bytes = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(bytes) > FRAME_BYTES || this.child.stdin.writableLength > FRAME_BYTES) throw new AcpSessionError("limit");
    this.child.stdin.write(bytes);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.stopped || this.pending) return Promise.reject(new AcpSessionError("busy"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new AcpSessionError("timeout")), this.options.requestTimeoutMs ?? timeoutMs);
      this.pending = { id, resolve, reject, timer };
      try { this.send({ jsonrpc: "2.0", id, method, params }); } catch (error) {
        this.fail(error instanceof AcpSessionError ? error : new AcpSessionError("unavailable"));
      }
    });
  }

  assertHealthy(): void { if (this.failure) throw this.failure; }

  cancel(id?: string, reason: "cancelled" | "scope_changed" = "cancelled"): void {
    if (this.stopped) return;
    if (id && !this.failure && !this.closed) {
      try { this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } }); } catch { /* Failure still fences every future update. */ }
    }
    this.fail(new AcpSessionError(reason));
  }

  private fail(error: AcpSessionError): void {
    this.failure ??= error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = null;
    }
    this.stop();
  }

  private kill(signal: NodeJS.Signals): void {
    if (this.closed || this.child.pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch { /* An already reaped owned process has nothing left to signal. */ }
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.lifetime);
    this.child.stdin.end();
    this.kill("SIGTERM");
    if (!this.closed) this.forceKill = setTimeout(() => this.kill("SIGKILL"), 1_000);
  }

  async close(): Promise<void> { this.stop(); await this.exit; }
}

async function initialize(connection: AcpConnection): Promise<{ version?: string; loadSession: boolean }> {
  const result = object(await connection.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "runphantom", title: "Run Phantom", version: "0.1.0" },
  }, 15_000));
  connection.assertHealthy();
  if (result.protocolVersion !== 1) throw new AcpSessionError("unsupported_protocol");
  const capabilities = object(result.agentCapabilities ?? {});
  const agent = result.agentInfo === undefined ? {} : object(result.agentInfo);
  return { version: agent.version === undefined ? undefined : text(agent.version, 64), loadSession: capabilities.loadSession === true };
}

export class OpenCodeAcpSessions {
  private readonly sessions = new Map<string, AcpSessionDetail>();
  private readonly active = new Map<string, () => void>();
  private readonly turns = new Set<AcpConnection>();
  private closed = false;
  private draining: Promise<void> | null = null;

  constructor(private readonly options: AcpProcessOptions = {}) {}

  async availability(cwd: string, scope?: AcpScope): Promise<AcpAvailability> {
    if (this.closed || scope?.abortSignal?.aborted || scope && !scope.isCurrent()) return { available: false, authentication: "unknown", reason: "unavailable", sessions: "runphantom_current_daemon" };
    if (this.draining) return { available: false, authentication: "unknown", reason: "busy", sessions: "runphantom_current_daemon" };
    if (activeProcesses >= 2) return { available: false, authentication: "unknown", reason: "busy", sessions: "runphantom_current_daemon" };
    activeProcesses++;
    let connection: AcpConnection | undefined;
    const abort = () => connection?.cancel();
    const guard = setInterval(() => { if (scope && !scope.isCurrent()) connection?.cancel(undefined, "scope_changed"); }, 100);
    scope?.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      connection = new AcpConnection(canonicalWorkspace(cwd), this.options);
      this.turns.add(connection);
      const initialized = await initialize(connection);
      if (this.closed || scope?.abortSignal?.aborted) throw new AcpSessionError("cancelled");
      if (scope && !scope.isCurrent()) throw new AcpSessionError("scope_changed");
      return { available: true, authentication: "unknown", protocolVersion: 1, version: initialized.version, sessions: "runphantom_current_daemon" };
    } catch (error) {
      const reason = error instanceof AcpSessionError ? error.category : "unavailable";
      return { available: false, authentication: reason === "authentication_required" ? "required" : "unknown", reason, sessions: "runphantom_current_daemon" };
    } finally {
      clearInterval(guard); scope?.abortSignal?.removeEventListener("abort", abort);
      if (connection) { await connection.close(); this.turns.delete(connection); } activeProcesses--;
    }
  }

  list(cwd: string): ClaudeSessionSummary[] {
    const canonical = canonicalWorkspace(cwd);
    return [...this.sessions.values()].filter((session) => session.cwd === canonical)
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
      .map(({ messages: _messages, ...summary }) => ({ ...summary }));
  }

  get(cwd: string, id: string): AcpSessionDetail | null {
    const result = this.sessions.get(`${canonicalWorkspace(cwd)}\0${id}`);
    return result ? structuredClone(result) : null;
  }

  cancel(cwd: string, id: string): boolean {
    const cancel = this.active.get(`${canonicalWorkspace(cwd)}\0${id}`);
    if (!cancel) return false;
    cancel();
    return true;
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    const connections = [...this.turns];
    connections.forEach((connection) => connection.cancel(undefined, "scope_changed"));
    const task = Promise.all(connections.map((connection) => connection.close())).then(() => {});
    this.draining = task.finally(() => { this.draining = null; });
    return this.draining;
  }

  async close(): Promise<void> { this.closed = true; await this.drain(); }

  async chat(input: AgentCliChatInput, handlers: AgentCliChatHandlers, scope?: AcpScope): Promise<AgentCliChatResult> {
    if (this.closed) throw new AcpSessionError("unavailable");
    if (this.draining) throw new AcpSessionError("busy");
    if (scope && !scope.isCurrent()) throw new AcpSessionError("scope_changed");
    if (input.abortSignal?.aborted) throw new AcpSessionError("cancelled");
    if (!input.content.trim() || Buffer.byteLength(input.content) > 16_384) throw new AcpSessionError("limit");
    const cwd = canonicalWorkspace(input.cwd);
    let id = input.resumeSessionId ? sessionId(input.resumeSessionId) : undefined;
    let key = id ? `${cwd}\0${id}` : randomUUID();
    if (id && !this.sessions.has(key)) throw new AcpSessionError("unavailable");
    if (this.active.has(key) || activeProcesses >= 2) throw new AcpSessionError("busy");
    if (!id && this.sessions.size >= MAX_SESSIONS) throw new AcpSessionError("limit");
    const previous = this.sessions.get(key);
    const retainedBytes = previous?.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0) ?? 0;
    if ((previous?.messages.length ?? 0) + 2 > MAX_MESSAGES || retainedBytes + Buffer.byteLength(input.content) > CONTENT_BYTES) throw new AcpSessionError("limit");
    activeProcesses++;
    let connection: AcpConnection | undefined;
    let content = "";
    let contentBytes = 0;
    let replaying = Boolean(id);
    let promptSent = false;
    let turnFailure: AcpSessionError | undefined;
    let completed = false;
    const tools = new Map<string, boolean>();
    const abort = () => connection?.cancel(id);
    this.active.set(key, abort);
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    const emit = (event: AgentStreamEvent) => { if (!input.abortSignal?.aborted) handlers.onEvent?.(event); };
    const checkScope = () => {
      if (scope && !scope.isCurrent()) { connection?.cancel(id, "scope_changed"); throw new AcpSessionError("scope_changed"); }
      if (this.closed || input.abortSignal?.aborted) throw new AcpSessionError("cancelled");
    };
    const guard = setInterval(() => { if (scope && !scope.isCurrent()) connection?.cancel(id, "scope_changed"); }, 100);
    try {
      connection = new AcpConnection(cwd, this.options);
      this.turns.add(connection);
      connection.onPermission = (params) => {
        checkScope();
        if (params.sessionId !== id || !id) throw new AcpSessionError("protocol_error");
        const tool = object(params.toolCall);
        if (!input.abortSignal?.aborted) emit({ type: "permission_denied", tool: text(tool.title ?? "ACP tool", 256), reason: "ACP permissions are denied in Run Phantom." });
        return !input.abortSignal?.aborted;
      };
      connection.onUpdate = (params) => {
        checkScope();
        // session/new can advertise commands before its response supplies the ID.
        const incomingId = sessionId(params.sessionId);
        const update = object(params.update);
        if (!id && update.sessionUpdate === "available_commands_update") return;
        if (incomingId !== id) throw new AcpSessionError("protocol_error");
        if (input.abortSignal?.aborted) return;
        const kind = text(update.sessionUpdate, 64);
        switch (kind) {
          case "agent_message_chunk":
          case "agent_thought_chunk":
          case "user_message_chunk": {
            const block = object(update.content);
            if (block.type !== "text") throw new AcpSessionError("protocol_error");
            const value = text(block.text, CONTENT_BYTES, true);
            if (replaying || kind === "user_message_chunk") return;
            contentBytes += Buffer.byteLength(value);
            if (retainedBytes + Buffer.byteLength(input.content) + contentBytes > CONTENT_BYTES) throw new AcpSessionError("limit");
            if (kind === "agent_message_chunk") { content += value; handlers.onText(content); }
            else emit({ type: "thinking_delta", content: value });
            return;
          }
          case "tool_call":
          case "tool_call_update": {
            const toolId = text(update.toolCallId, 128);
            const status = update.status;
            if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "failed") throw new AcpSessionError("protocol_error");
            if (replaying) return;
            if (!tools.has(toolId)) {
              if (tools.size >= 64) throw new AcpSessionError("limit");
              tools.set(toolId, false);
              emit({ type: "tool_start", id: toolId, name: text(update.title ?? "ACP tool", 256) });
            }
            if ((status === "completed" || status === "failed") && !tools.get(toolId)) {
              tools.set(toolId, true);
              emit({ type: "tool_finish", id: toolId, ok: status === "completed" });
            }
            return;
          }
          case "plan": {
            if (!Array.isArray(update.entries) || update.entries.length > 32) throw new AcpSessionError("protocol_error");
            for (const value of update.entries) {
              const entry = object(value);
              text(entry.content, 1_024);
              if (!["pending", "in_progress", "completed"].includes(String(entry.status)) || !["high", "medium", "low"].includes(String(entry.priority))) throw new AcpSessionError("protocol_error");
            }
            if (!replaying) emit({ type: "status", content: "OpenCode updated its plan." });
            return;
          }
          case "available_commands_update": {
            if (!Array.isArray(update.availableCommands) || update.availableCommands.length > 64) throw new AcpSessionError("protocol_error");
            const commands = update.availableCommands.map((value) => text(object(value).name, 128));
            if (!replaying) emit({ type: "loadout", tools: [], mcps: [], skills: [], plugins: [], slash_commands: commands });
            return;
          }
          case "current_mode_update": text(update.currentModeId, 128); return;
          default: throw new AcpSessionError("protocol_error", /^[a-z_]{1,64}$/.test(kind) ? kind : "unrecognized");
        }
      };
      const initialized = await initialize(connection);
      checkScope();
      const mcpServers = scope?.mcpServers ?? [];
      if (input.abortSignal?.aborted) throw new AcpSessionError("cancelled");
      if (id) {
        if (!initialized.loadSession) throw new AcpSessionError("unsupported_protocol");
        await connection.request("session/load", { cwd, sessionId: id, mcpServers }, 30_000);
        connection.assertHealthy();
        checkScope();
      } else {
        id = sessionId(object(await connection.request("session/new", { cwd, mcpServers }, 30_000)).sessionId);
        connection.assertHealthy();
        checkScope();
        const nextKey = `${cwd}\0${id}`;
        if (this.sessions.has(nextKey) || this.active.has(nextKey)) throw new AcpSessionError("protocol_error");
        if (this.sessions.size >= MAX_SESSIONS) throw new AcpSessionError("limit");
        this.active.delete(key);
        key = nextKey;
        this.active.set(key, abort);
        const timestamp = new Date().toISOString();
        this.sessions.set(key, { id, path: "", cwd, created_at: timestamp, updated_at: timestamp, message_count: 0, last_prompt: null, preview: null, messages: [] });
      }
      handlers.onProviderSession(id);
      if (mcpServers.length) emit({ type: "loadout", tools: ["runphantom_verification.app_observe", "runphantom_verification.app_assert"], mcps: ["runphantom_verification"], skills: [], plugins: [], slash_commands: [] });
      replaying = false;
      if (input.abortSignal?.aborted) throw new AcpSessionError("cancelled");
      promptSent = true;
      const result = object(await connection.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: input.content }] }, 120_000));
      connection.assertHealthy();
      checkScope();
      if (input.abortSignal?.aborted || result.stopReason === "cancelled") throw new AcpSessionError("cancelled");
      if (result.stopReason !== "end_turn") throw new AcpSessionError(result.stopReason === "max_tokens" || result.stopReason === "max_turn_requests" ? "limit" : "protocol_error");
      completed = true;
    } catch (error) {
      const failure = error instanceof AcpSessionError ? error : new AcpSessionError("unavailable");
      turnFailure = failure;
    } finally {
      if (connection) { await connection.close(); this.turns.delete(connection); }
      clearInterval(guard);
      if (completed && (scope && !scope.isCurrent() || this.closed || input.abortSignal?.aborted)) {
        turnFailure = new AcpSessionError(scope && !scope.isCurrent() ? "scope_changed" : "cancelled");
      }
      if (id && promptSent) {
        const session = this.sessions.get(key);
        if (session) {
          const timestamp = new Date().toISOString();
          session.messages.push({ id: randomUUID(), role: "user", content: input.content, timestamp });
          if (content) session.messages.push({ id: randomUUID(), role: "assistant", content, timestamp, ...(turnFailure ? { error: turnFailure.message } : {}) });
          session.updated_at = timestamp;
          session.message_count = session.messages.length;
          session.last_prompt = input.content.slice(0, 160);
          session.preview = content.slice(0, 160) || null;
          session.capture = turnFailure
            ? { status: "incomplete", reason: turnFailure.category, ...(turnFailure.unknownUpdate ? { unknownUpdate: turnFailure.unknownUpdate } : {}) }
            : { status: "complete" };
        }
      }
      input.abortSignal?.removeEventListener("abort", abort);
      this.active.delete(key);
      activeProcesses--;
    }
    if (turnFailure) {
      if (turnFailure.category !== "cancelled") { handlers.onError?.(turnFailure.message); emit({ type: "error", content: turnFailure.message }); }
      throw turnFailure;
    }
    emit({ type: "done" });
    return { code: 0, signal: null, stderr: "" };
  }
}
