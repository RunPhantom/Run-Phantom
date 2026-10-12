/** Independent host-controlled browser protocol. Page SDK authority is never accepted here. */
import { validateOrigin } from "./validation";
import { sanitizeWithReport } from "./serialization";
import type { Coverage, RuntimeEvent } from "./protocol";

export const BROWSER_LIMITS = { FRAME_BYTES: 128 * 1024, SESSIONS: 2, ACTION_MS: 5000, START_MS: 15000,
  CLOSE_MS: 10000, PAGES: 32, REQUESTS: 1000, SECRET_COUNT: 100, SECRET_BYTES: 64 * 1024,
  WIDTH: 1920, HEIGHT: 1080, PNG_BYTES: 8 * 1024 * 1024, VIDEO_MS: 60000, VIDEO_BYTES: 32 * 1024 * 1024,
  ARTIFACTS: 100, ARTIFACT_BYTES: 256 * 1024 * 1024 } as const;
export type BrowserEngine = "chromium" | "firefox" | "webkit";
export type BrowserTarget = { kind: "css"; selector: string } | { kind: "role"; role: string; name?: string; exact: true }
  | { kind: "label"; label: string; exact: true } | { kind: "test-id"; testId: string };
export type BrowserAction = { type: "click" | "hover" | "focus"; target: BrowserTarget }
  | { type: "fill"; target: BrowserTarget; value: string }
  | { type: "press"; target: BrowserTarget; key: string }
  | { type: "select"; target: BrowserTarget; value: string }
  | { type: "drag"; target: BrowserTarget; to: BrowserTarget };
export interface BrowserOpen { engine: BrowserEngine; url: string; runId?: string; recordVideo: boolean; rawConsent?: true }
export interface ExecutionContext {
  formatVersion: 1; backend: "trusted-browser"; engine: BrowserEngine; providerVersion: string;
  ownership: "owned" | "attached"; generation: number; inputMode: "trusted-browser" | "none" | "unknown";
  dispatch: "not-dispatched" | "completed" | "unknown"; actionId?: string; artifactIds?: string[];
}
export interface BrowserSummary {
  id: string; origin: string | null; runId: string | null; ownership: "owned" | "attached";
  engine: BrowserEngine; providerVersion: string; engineVersion: string; generation: number;
  state: "opening" | "selecting" | "ready" | "busy" | "closed" | "unavailable";
  coverage: Coverage; history: "from-open" | "from-selection"; loss: boolean; pending: number;
  reason?: string; video: "off" | "recording" | "stopped";
}
export interface BrowserActionResult {
  actionId: string; generationBefore: number; generationAfter: number;
  dispatch: ExecutionContext["dispatch"]; inputMode: ExecutionContext["inputMode"]; reason?: string;
}
export interface BrowserObservation { session: BrowserSummary; events: RuntimeEvent[]; cursor: number; complete: boolean; dropped: number }
export class BrowserInputError extends Error { constructor(public status: number, message: string) { super(message); } }
const invalid = (message: string): never => { throw new BrowserInputError(400, message); };
export const OPAQUE_ID = /^[0-9a-f]{32}$/;
export const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function browserObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Object required");
  const object = value as Record<string, unknown>;
  const proto = Object.getPrototypeOf(object) as unknown;
  if (proto !== Object.prototype && proto !== null) invalid("Plain data object required");
  const names = Reflect.ownKeys(object);
  if (names.some(key => typeof key !== "string" || !keys.includes(key))) invalid("Unexpected browser field");
  for (const key of names) if (!("value" in Object.getOwnPropertyDescriptor(object, key)!)) invalid("Browser fields must be data");
  return object;
}
export function browserArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) invalid("Bounded data array required");
  const array = value as unknown[];
  if (Reflect.ownKeys(array).length !== array.length + 1) invalid("Dense data array required");
  return Array.from({ length: array.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (!descriptor || !("value" in descriptor)) invalid("Array fields must be data");
    return descriptor!.value as unknown;
  });
}
export function browserText(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /\0/.test(value)) invalid("Invalid bounded browser text");
  return value as string;
}
export function browserGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid("Current browser generation required");
  return value as number;
}
export function browserId(value: unknown): string { const id = browserText(value, 32); if (!OPAQUE_ID.test(id)) invalid("Invalid opaque browser ID"); return id; }
export function browserEngine(value: unknown): BrowserEngine {
  if (value !== "chromium" && value !== "firefox" && value !== "webkit") invalid("Unsupported browser engine");
  return value as BrowserEngine;
}
function safeQuery(value: unknown, max = 1024): string {
  const text = browserText(value, max);
  const safe = sanitizeWithReport(text);
  if (safe.redacted || safe.truncation) invalid("Browser targets cannot contain credentials");
  return text;
}
export function parseBrowserTarget(value: unknown): BrowserTarget {
  const body = browserObject(value, ["kind", "selector", "role", "name", "exact", "label", "testId"]);
  switch (body.kind) {
    case "css": {
      browserObject(body, ["kind", "selector"]); const selector = safeQuery(body.selector);
      if (selector.includes(">>") || /^\s*[\w-]+=/.test(selector) || selector.includes("internal:")) invalid("Literal CSS selector required");
      return { kind: "css", selector };
    }
    case "role": {
      browserObject(body, ["kind", "role", "name", "exact"]);
      if (body.exact !== undefined && body.exact !== true) invalid("Browser semantic matching must be exact");
      return { kind: "role", role: safeQuery(body.role, 64), ...(body.name === undefined ? {} : { name: safeQuery(body.name) }), exact: true };
    }
    case "label": browserObject(body, ["kind", "label", "exact"]); if (body.exact !== undefined && body.exact !== true) invalid("Browser semantic matching must be exact"); return { kind: "label", label: safeQuery(body.label), exact: true };
    case "test-id": browserObject(body, ["kind", "testId"]); return { kind: "test-id", testId: safeQuery(body.testId) };
    default: return invalid("Unsupported browser target");
  }
}
const KEYS = new Set(["Tab", "Shift+Tab", "Enter", "Space", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);
export function parseBrowserAction(value: unknown): BrowserAction {
  const body = browserObject(value, ["type", "target", "value", "key", "to"]);
  const target = parseBrowserTarget(body.target);
  switch (body.type) {
    case "click": case "hover": case "focus": browserObject(body, ["type", "target"]); return { type: body.type, target };
    case "fill": browserObject(body, ["type", "target", "value"]); return { type: "fill", target, value: browserText(body.value, 4096, true) };
    case "press": browserObject(body, ["type", "target", "key"]); if (!KEYS.has(body.key as string)) invalid("Unsupported browser key"); return { type: "press", target, key: body.key as string };
    case "select": browserObject(body, ["type", "target", "value"]); return { type: "select", target, value: safeQuery(body.value, 256) };
    case "drag": browserObject(body, ["type", "target", "to"]); return { type: "drag", target, to: parseBrowserTarget(body.to) };
    default: return invalid("Unsupported browser action");
  }
}
export function parseBrowserOpen(value: unknown): BrowserOpen {
  const body = browserObject(value, ["engine", "url", "runId", "recordVideo", "rawConsent"]);
  const rawUrl = browserText(body.url, 2048);
  let url: URL;
  try { url = new URL(rawUrl); } catch { return invalid("Valid local HTTP(S) URL required"); }
  if (url.username || url.password) invalid("URL credentials are forbidden");
  validateOrigin(url.origin);
  const safe = sanitizeWithReport(url.href);
  if (safe.redacted || safe.truncation) invalid("URL credentials are forbidden");
  if (body.recordVideo !== undefined && typeof body.recordVideo !== "boolean" || body.rawConsent !== undefined && body.rawConsent !== true) invalid("Explicit raw consent required");
  if (body.recordVideo && body.rawConsent !== true) invalid("Video requires explicit private raw consent");
  return { engine: browserEngine(body.engine), url: url.href, ...(body.runId === undefined ? {} : { runId: browserText(body.runId, 256) }), recordVideo: body.recordVideo === true, ...(body.rawConsent ? { rawConsent: true } : {}) };
}
export function parseExecutionContext(value: unknown): ExecutionContext {
  const b = browserObject(value, ["formatVersion", "backend", "engine", "providerVersion", "ownership", "generation", "inputMode", "dispatch", "actionId", "artifactIds"]);
  if (b.formatVersion !== 1 || b.backend !== "trusted-browser" || !["owned", "attached"].includes(b.ownership as string)
    || !["trusted-browser", "none", "unknown"].includes(b.inputMode as string) || !["not-dispatched", "completed", "unknown"].includes(b.dispatch as string)) invalid("Invalid saved browser observation");
  const result: ExecutionContext = { formatVersion: 1, backend: "trusted-browser", engine: browserEngine(b.engine), providerVersion: browserText(b.providerVersion, 32), ownership: b.ownership as ExecutionContext["ownership"], generation: browserGeneration(b.generation), inputMode: b.inputMode as ExecutionContext["inputMode"], dispatch: b.dispatch as ExecutionContext["dispatch"], ...(b.actionId === undefined ? {} : { actionId: browserId(b.actionId) }) };
  if (b.artifactIds !== undefined) {
    const ids = browserArray(b.artifactIds, 3);
    if (ids.some(id => typeof id !== "string" || !ARTIFACT_ID.test(id))) invalid("Invalid saved artifact identifiers");
    result.artifactIds = ids as string[];
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 1024) invalid("Browser observation context exceeds budget");
  return result;
}
export type WorkerOperation = "open" | "list" | "select" | "observe" | "action" | "read" | "capture" | "close";
export interface WorkerFrame { formatVersion: 1; nonce: string; id: string; generation: number; operation: WorkerOperation; data: unknown }
export function parseWorkerFrame(raw: string, nonce: string): WorkerFrame {
  if (Buffer.byteLength(raw) > BROWSER_LIMITS.FRAME_BYTES) invalid("Browser worker frame exceeds budget");
  let value: unknown; try { value = JSON.parse(raw); } catch { return invalid("Invalid browser worker JSON"); }
  const body = browserObject(value, ["formatVersion", "nonce", "id", "generation", "operation", "data"]);
  if (body.formatVersion !== 1 || body.nonce !== nonce || !["open", "list", "select", "observe", "action", "read", "capture", "close"].includes(body.operation as string)) invalid("Invalid browser worker authority");
  return { formatVersion: 1, nonce, id: browserId(body.id), generation: browserGeneration(body.generation), operation: body.operation as WorkerOperation, data: body.data };
}
