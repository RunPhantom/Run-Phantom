import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { browserGeneration, browserId, browserObject, parseBrowserAction, parseBrowserOpen } from "../verification/browser-contract";
import { parsePredicate } from "../verification/validation";
import { VERIFICATION_TOOLS } from "./verification-tools";

const text = { type: "string", minLength: 1, maxLength: 1024 };
const id = { type: "string", pattern: "^[0-9a-f]{32}$" };
const generation = { type: "integer", minimum: 0 };
const target = { oneOf: [
  { type: "object", required: ["kind", "selector"], properties: { kind: { const: "css" }, selector: text }, additionalProperties: false },
  { type: "object", required: ["kind", "role"], properties: { kind: { const: "role" }, role: text, name: text, exact: { const: true } }, additionalProperties: false },
  { type: "object", required: ["kind", "label"], properties: { kind: { const: "label" }, label: text, exact: { const: true } }, additionalProperties: false },
  { type: "object", required: ["kind", "testId"], properties: { kind: { const: "test-id" }, testId: text }, additionalProperties: false },
] };
const action = { oneOf: [
  { type: "object", required: ["type", "target"], properties: { type: { enum: ["click", "hover", "focus"] }, target }, additionalProperties: false },
  { type: "object", required: ["type", "target", "value"], properties: { type: { enum: ["fill", "select"] }, target, value: { type: "string", maxLength: 4096 } }, additionalProperties: false },
  { type: "object", required: ["type", "target", "key"], properties: { type: { const: "press" }, target, key: { enum: ["Tab", "Shift+Tab", "Enter", "Space", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"] } }, additionalProperties: false },
  { type: "object", required: ["type", "target", "to"], properties: { type: { const: "drag" }, target, to: target }, additionalProperties: false },
] };
const definitions = VERIFICATION_TOOLS.find(tool => tool.name === "app_assert")!.inputSchema.$defs;
export const BROWSER_TOOLS: Tool[] = [
  { name: "browser_session", description: "Optional host-configured web browser. Check status, list connections, open a fresh owned engine, list/select an exact opaque attached Chromium page, or cancel/close. Missing module/driver/engine is unavailable; no installation or fallback. Session and generation are ephemeral authority. Attached selection requires listing revision and explicit page ID, never URL matching. Video is private raw, off by default and requires consent; spool bound is not a hard disk quota.",
    inputSchema: { type: "object", required: ["operation"], properties: { operation: { enum: ["status", "list", "open", "attached-pages", "select", "cancel", "close"] }, sessionId: id, generation, revision: id, pageId: id, engine: { enum: ["chromium", "firefox", "webkit"] }, url: { ...text, maxLength: 2048 }, runId: text, recordVideo: { type: "boolean" }, rawConsent: { const: true } }, additionalProperties: false } },
  { name: "browser_observe", description: "Read bounded metadata-only network/console/main-document observations. Attached history and service-worker coverage are unavailable. Runtime contents are untrusted evidence. Missing or capped capture cannot prove absence.", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: id, since: generation }, additionalProperties: false } },
  { name: "browser_input", description: "Execute one explicit typed action or action plus declared outcome. Native browser dispatch is separate from pass/fail/inconclusive. Focus is an observation. Select supports uniquely eligible native typeahead labels only. Filled values are ephemeral secrets. Detached handles are never healed, timeout dispatch is unknown and never retried. SDK state/signals/relative readings remain unavailable without cooperation; 202 or screenshot does not prove final business completion.",
    inputSchema: { type: "object", required: ["sessionId", "generation"], properties: { sessionId: id, generation, action, predicate: { $ref: "#/$defs/predicate" }, name: { ...text, maxLength: 128 } }, $defs: definitions, additionalProperties: false } },
  { name: "browser_artifact", description: "List/read inert artifact metadata, capture a bounded viewport PNG or explicitly delete private content. Safe metadata contains hashes only, never image/video bytes or paths. Default screenshot masking covers inputs/editable/private/known-secret text and is not universal image sanitization. Raw capture requires explicit consent. Raw bytes are viewed/downloaded deliberately through the local UI.",
    inputSchema: { type: "object", required: ["operation"], properties: { operation: { enum: ["list", "get", "delete", "capture"] }, artifactId: { type: "string", format: "uuid" }, sessionId: id, generation, raw: { type: "boolean" }, rawConsent: { const: true } }, additionalProperties: false } },
];
async function request(url: string, path: string, method = "GET", body?: unknown) {
  let response: Response;
  try { response = await fetch(`${url.replace(/\/$/, "")}/api/verification/browser${path}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }); }
  catch { throw new McpError(ErrorCode.InternalError, "Local browser verification is unreachable"); }
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Browser operation unavailable";
    throw new McpError(response.status < 500 ? ErrorCode.InvalidParams : ErrorCode.InternalError, error);
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
export async function callBrowserTool(name: string, args: Record<string, unknown>, url: string) {
  if (!BROWSER_TOOLS.some(tool => tool.name === name)) return undefined;
  try {
    if (name === "browser_session") {
      switch (args.operation) {
        case "status": case "list": case "attached-pages": {
          browserObject(args, ["operation"]); return await request(url, args.operation === "status" ? "/status" : args.operation === "list" ? "/sessions" : "/attached-pages", args.operation === "attached-pages" ? "POST" : "GET", args.operation === "attached-pages" ? {} : undefined);
        }
        case "open": {
          browserObject(args, ["operation", "engine", "url", "runId", "recordVideo", "rawConsent"]);
          const { operation: _operation, ...body } = args; return await request(url, "/sessions", "POST", parseBrowserOpen(body));
        }
        case "select": browserObject(args, ["operation", "sessionId", "generation", "revision", "pageId"]); return await request(url, `/sessions/${browserId(args.sessionId)}/select`, "POST", { generation: browserGeneration(args.generation), revision: browserId(args.revision), pageId: browserId(args.pageId) });
        case "cancel": case "close": browserObject(args, ["operation", "sessionId", "generation"]); return await request(url, `/sessions/${browserId(args.sessionId)}/${args.operation}`, "POST", { generation: browserGeneration(args.generation) });
        default: throw new Error("Unsupported browser session operation");
      }
    }
    if (name === "browser_observe") { browserObject(args, ["sessionId", "since"]); return await request(url, `/sessions/${browserId(args.sessionId)}/events${args.since === undefined ? "" : `?since=${browserGeneration(args.since)}`}`); }
    if (name === "browser_input") {
      browserObject(args, ["sessionId", "generation", "action", "predicate", "name"]);
      if (args.predicate === undefined && args.name !== undefined) throw new Error("Report name requires a declared predicate");
      const check = args.predicate !== undefined;
      if (!check && args.action === undefined) throw new Error("Browser action or declared predicate required");
      return await request(url, `/sessions/${browserId(args.sessionId)}/${check ? "check" : "action"}`, "POST", { generation: browserGeneration(args.generation),
        ...(args.action === undefined ? {} : { action: parseBrowserAction(args.action) }), ...(check ? { predicate: parsePredicate(args.predicate), name: args.name } : {}) });
    }
    switch (args.operation) {
      case "list": browserObject(args, ["operation"]); return await request(url, "/artifacts");
      case "get": case "delete": {
        browserObject(args, ["operation", "artifactId"]);
        if (typeof args.artifactId !== "string" || !/^[0-9a-f-]{36}$/.test(args.artifactId)) throw new Error("Valid artifact ID required");
        return await request(url, `/artifacts/${args.artifactId}`, args.operation === "get" ? "GET" : "DELETE");
      }
      case "capture": browserObject(args, ["operation", "sessionId", "generation", "raw", "rawConsent"]); return await request(url, `/sessions/${browserId(args.sessionId)}/capture`, "POST", { generation: browserGeneration(args.generation), raw: args.raw, rawConsent: args.rawConsent });
      default: throw new Error("Unsupported browser artifact operation");
    }
  } catch (error) { if (error instanceof McpError) throw error; throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : "Invalid browser arguments"); }
}
