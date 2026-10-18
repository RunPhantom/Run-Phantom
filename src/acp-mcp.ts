import { randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import type { Readable, Writable } from "node:stream";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { VERIFICATION_TOOLS } from "./mcp/verification-tools";
import { parsePredicate } from "./verification/validation";
import type { VerificationService } from "./verification/service";
import type { VerificationSession } from "./verification/bridge";
import { hasDuplicateJsonKeys } from "./json-keys";
import { parseJsonEvidence } from "./evaluations/json-evidence";

const FRAME_BYTES = 16_384;
const INPUT_BYTES = 65_536;
const OUTPUT_BYTES = 65_536;
const MAX_CALLS = 8;
const MAX_GRANTS = 8;
const TTL_MS = 45_000;
let activeCalls = 0;

export class AcpMcpError extends Error {
  constructor(readonly reason: "unavailable" | "invalid" | "limit" | "busy") {
    super(`Run Phantom verification MCP ${reason}.`);
    this.name = "AcpMcpError";
  }
}

interface Grant {
  token: string;
  session: VerificationSession;
  documentGeneration: number;
  focusedRunId: string;
  isCurrent(): boolean;
  expiresAt: number;
  calls: number;
  inputBytes: number;
  outputBytes: number;
  revoked: boolean;
  pending: Set<Promise<unknown>>;
}

function current(callback: () => boolean): boolean { try { return callback(); } catch { return false; } }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AcpMcpError("invalid");
  return value as Record<string, unknown>;
}
function strictJson(raw: string): unknown {
  try {
    const value = parseJsonEvidence(raw);
    if (hasDuplicateJsonKeys(raw)) throw new Error();
    return value;
  } catch { throw new AcpMcpError("invalid"); }
}

// Native observe references at most 1,000 events from its 1 MiB ring; reports already bound
// evidence/context. Count this smaller wire envelope before whole-result serialization.
function resultBytes(value: unknown, limit: number): number {
  let bytes = 0;
  let nodes = 0;
  const add = (text: string) => { bytes += Buffer.byteLength(text); if (bytes > limit) throw new AcpMcpError("limit"); };
  const scalar = (entry: unknown) => {
    if (typeof entry === "string" && entry.length > limit) throw new AcpMcpError("limit");
    const json = JSON.stringify(entry);
    if (json === undefined) throw new AcpMcpError("unavailable");
    add(json);
  };
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 8_192 || depth > 32) throw new AcpMcpError("limit");
    if (entry === null || typeof entry !== "object") { scalar(entry); return; }
    if (Array.isArray(entry)) {
      add("["); for (let index = 0; index < entry.length; index++) { if (index) add(","); visit(entry[index], depth + 1); } add("]");
    } else {
      add("{"); let count = 0;
      for (const key of Object.keys(entry)) {
        const child = (entry as Record<string, unknown>)[key];
        if (child === undefined) continue;
        if (count++) add(","); scalar(key); add(":"); visit(child, depth + 1);
      }
      add("}");
    }
  };
  visit(value, 0); return bytes;
}

/** Issuance takes an actual daemon-owned session object, never a caller-supplied target/URL. */
export class AcpVerificationGrants {
  private readonly grants = new Map<string, Grant>();
  private closed = false;
  constructor(private readonly service: VerificationService, private readonly now: () => number = Date.now) {}

  issue(session: VerificationSession, focusedRunId: string, isCurrent: () => boolean): string {
    this.sweep();
    if (this.closed || !current(isCurrent) || !session.ws || session.ws.readyState !== 1 || session.generation < 1 || !focusedRunId || session.runId !== focusedRunId || this.service.bridge.sessions.get(session.id) !== session) throw new AcpMcpError("unavailable");
    if (this.grants.size >= MAX_GRANTS) throw new AcpMcpError("limit");
    const token = randomBytes(32).toString("hex");
    this.grants.set(token, { token, session, documentGeneration: session.generation, focusedRunId, isCurrent, expiresAt: this.now() + TTL_MS, calls: 0, inputBytes: 0, outputBytes: 0, revoked: false, pending: new Set() });
    return token;
  }

  private valid(grant: Grant): boolean {
    return !this.closed && !grant.revoked && this.now() < grant.expiresAt && current(() => grant.isCurrent())
      && this.service.bridge.sessions.get(grant.session.id) === grant.session
      && grant.session.runId === grant.focusedRunId && grant.session.generation === grant.documentGeneration && grant.session.ws?.readyState === 1;
  }

  private sweep(): void {
    for (const [token, grant] of this.grants) if (!this.valid(grant)) {
      grant.revoked = true;
      if (!grant.pending.size) this.grants.delete(token);
    }
  }

  async invoke(token: string, raw: string): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new AcpMcpError("unavailable");
    const grant = this.grants.get(token);
    if (!grant || !this.valid(grant)) throw new AcpMcpError("unavailable");
    const bytes = Buffer.byteLength(raw);
    if (bytes > FRAME_BYTES || grant.inputBytes + bytes > INPUT_BYTES || grant.calls >= MAX_CALLS) throw new AcpMcpError("limit");
    if (activeCalls >= 2 || grant.pending.size) throw new AcpMcpError("busy");
    const call = record(strictJson(raw));
    if (Object.keys(call).some((key) => key !== "name" && key !== "arguments")) throw new AcpMcpError("invalid");
    const args = record(call.arguments ?? {});
    // A grant is a credential, never a predicate/name or persisted report payload.
    if (JSON.stringify(call).includes(grant.token)) throw new AcpMcpError("invalid");
    if (call.name !== "app_observe" && call.name !== "app_assert") throw new AcpMcpError("invalid");
    const allowed = call.name === "app_observe" ? ["since"] : ["since", "predicate", "name"];
    if (Object.keys(args).some((key) => !allowed.includes(key))) throw new AcpMcpError("invalid");
    if (args.since !== undefined && (typeof args.since !== "number" || !Number.isSafeInteger(args.since) || args.since < grant.session.generationCursor || args.since > grant.session.cursor)) throw new AcpMcpError("invalid");
    if (args.name !== undefined && (typeof args.name !== "string" || !args.name.trim() || args.name.includes("\0") || Buffer.byteLength(args.name) > 256)) throw new AcpMcpError("invalid");
    let predicate: ReturnType<typeof parsePredicate> | undefined;
    if (call.name === "app_assert") {
      try { predicate = parsePredicate(args.predicate); } catch { throw new AcpMcpError("invalid"); }
    }
    // Admission is spent before any callback/await. No caller can retry through a revoked grant.
    grant.calls++;
    grant.inputBytes += bytes;
    activeCalls++;
    const task = Promise.resolve().then(async () => {
      if (!this.valid(grant)) throw new AcpMcpError("unavailable");
      const result: unknown = call.name === "app_observe"
        ? this.service.bridge.observe(grant.session, args.since as number | undefined ?? grant.session.generationCursor)
        : await this.service.assert(grant.session.id, predicate, args.since as number | undefined, typeof args.name === "string" ? args.name : "ACP application check");
      if (!this.valid(grant)) throw new AcpMcpError("unavailable");
      const outputBytes = resultBytes(result, OUTPUT_BYTES - grant.outputBytes);
      if (grant.outputBytes + outputBytes > OUTPUT_BYTES) throw new AcpMcpError("limit");
      grant.outputBytes += outputBytes;
      return result;
    });
    grant.pending.add(task);
    try { return await task; }
    catch (error) { throw error instanceof AcpMcpError ? error : new AcpMcpError("unavailable"); }
    finally { grant.pending.delete(task); activeCalls--; if (grant.revoked) this.grants.delete(token); }
  }

  async revoke(token: string): Promise<void> {
    const grant = this.grants.get(token);
    if (!grant) return;
    grant.revoked = true;
    await Promise.allSettled([...grant.pending]);
    this.grants.delete(token);
  }

  async revokeAll(): Promise<void> { await Promise.all([...this.grants.keys()].map((token) => this.revoke(token))); }

  async close(): Promise<void> { this.closed = true; await this.revokeAll(); }
}

function scopedTools(): Tool[] {
  return VERIFICATION_TOOLS.filter((tool) => tool.name === "app_observe" || tool.name === "app_assert").map((tool) => {
    const selected: Tool = structuredClone(tool);
    if (selected.inputSchema.properties) delete selected.inputSchema.properties.sessionId;
    selected.inputSchema.required = selected.inputSchema.required?.filter((name) => name !== "sessionId");
    selected.description = `${tool.description} Target is fixed to this grant's selected application session. Do not supply sessionId.`;
    return selected;
  });
}

/** Limited registration is opt-in; ordinary Run Phantom MCP registration stays untouched. */
export function registerAcpMcpTools(mcp: Server, invoke: (raw: string) => Promise<unknown>): void {
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: scopedTools() }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await invoke(JSON.stringify({ name: request.params.name, arguments: request.params.arguments ?? {} }));
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, error instanceof AcpMcpError ? error.message : "Run Phantom verification MCP unavailable.");
    }
  });
}

/** The MCP child can call only this fixed loopback grant endpoint, with no redirects/retry. */
export function acpMcpInvoker(origin: string, token: string): (raw: string) => Promise<unknown> {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new AcpMcpError("invalid"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535 || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password || !/^[a-f0-9]{64}$/.test(token)) throw new AcpMcpError("invalid");
  const endpoint = `${parsed.origin}/api/agent/acp/mcp/${token}`;
  return async (raw) => {
    if (Buffer.byteLength(raw) > FRAME_BYTES) throw new AcpMcpError("limit");
    const signal = AbortSignal.timeout(10_000);
    let response: Response;
    try { response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: raw, signal }); }
    catch { throw new AcpMcpError("unavailable"); }
    if (!response.ok) { await response.body?.cancel(); throw new AcpMcpError("unavailable"); }
    const reader = response.body?.getReader();
    if (!reader) throw new AcpMcpError("unavailable");
    let buffer = Buffer.alloc(0);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (buffer.length + value.length > OUTPUT_BYTES) throw new AcpMcpError("limit");
        buffer = Buffer.concat([buffer, value]);
      }
      return strictJson(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    } catch (error) { throw error instanceof AcpMcpError ? error : new AcpMcpError("unavailable"); }
    finally { await reader.cancel().catch(() => {}); }
  };
}

class StrictMcpInput extends Transform {
  private buffer = Buffer.alloc(0);
  private total = 0;
  private frames = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.total += chunk.length;
      if (this.total > INPUT_BYTES) throw new AcpMcpError("limit");
      let start = 0;
      for (let index = 0; index < chunk.length; index++) if (chunk[index] === 10) {
        if (++this.frames > 128 || this.buffer.length + index - start > FRAME_BYTES) throw new AcpMcpError("limit");
        const frame = Buffer.concat([this.buffer, chunk.subarray(start, index)]);
        strictJson(new TextDecoder("utf-8", { fatal: true }).decode(frame));
        this.push(Buffer.concat([frame, Buffer.from("\n")]));
        this.buffer = Buffer.alloc(0); start = index + 1;
      }
      if (this.buffer.length + chunk.length - start > FRAME_BYTES) throw new AcpMcpError("limit");
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(start)]);
      callback();
    } catch { callback(new Error("Invalid or excessive ACP MCP protocol input")); }
  }
  override _flush(callback: TransformCallback): void { callback(this.buffer.length ? new Error("Incomplete ACP MCP protocol input") : null); }
}

export class BoundedAcpMcpTransport extends StdioServerTransport {
  private readonly guarded: StrictMcpInput;
  private outputBytes = 0;
  private closed = false;
  private readonly pending = new Set<(error: Error) => void>();
  constructor(private readonly input: Readable, private readonly output: Writable) {
    const guard = new StrictMcpInput();
    super(guard, output, { maxBufferSize: FRAME_BYTES + 1 });
    this.guarded = guard;
    guard.on("error", () => { void this.close(); });
    guard.on("end", () => { void this.close(); });
    input.on("error", () => { void this.close(); });
    input.pipe(guard);
  }
  override async send(message: Parameters<StdioServerTransport["send"]>[0]): Promise<void> {
    const frame = JSON.stringify(message) + "\n";
    const bytes = Buffer.byteLength(frame);
    if (this.closed) throw new AcpMcpError("unavailable");
    if (this.outputBytes + bytes > 262_144) throw new AcpMcpError("limit");
    this.outputBytes += bytes;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error | null) => {
        clearTimeout(timer); this.output.off("error", failed); this.output.off("close", unavailable); this.pending.delete(failed);
        if (error) reject(new AcpMcpError("unavailable")); else resolve();
      };
      const failed = (error: Error) => finish(error);
      const unavailable = () => failed(new Error("MCP output unavailable"));
      const timer = setTimeout(() => { unavailable(); void this.close(); }, 10_000);
      timer.unref();
      this.pending.add(failed); this.output.once("error", failed); this.output.once("close", unavailable);
      try { this.output.write(frame, finish); } catch { unavailable(); }
    });
  }
  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const fail of this.pending) fail(new Error("MCP closed"));
    this.input.unpipe(this.guarded); this.input.pause(); await super.close(); this.guarded.destroy();
  }
}
