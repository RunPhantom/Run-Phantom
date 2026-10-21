import {
  PROTOCOL_VERSION, CAUSAL_PROTOCOL_VERSION, CAUSAL_CAPABILITY, SEMANTIC_PROTOCOL_VERSION, SEMANTIC_CAPABILITY, SOURCE_PROTOCOL_VERSION, SOURCE_CAPABILITY, TREE_PROTOCOL_VERSION, TREE_CAPABILITY, SEMANTIC_REF_PATTERN, normalizeSemanticText, relativeTargetKey, relativeTargets, VERIFICATION_LIMITS as L,
  type AppCommand, type BrowserMessage, type Coverage, type FlowStep, type Predicate, type RelativeTarget, type SemanticQuery, type VerificationCapability,
} from "./protocol";
import { parseFlowAnchor } from "./flow-anchors";
import { isSensitiveKey } from "./redaction";
import { sanitizeWithReport } from "./serialization";
import { parseControlSourceObservation } from "./build/source";
import { parsePerformancePredicate } from "./performance";
import { PERFORMANCE_PROTOCOL_VERSION, PERFORMANCE_CAPABILITY } from "./protocol";

export class VerificationInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message.slice(0, L.MAX_REASON_LENGTH));
    this.name = "VerificationInputError";
  }
}

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
function invalid(message: string): never { throw new VerificationInputError(message); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(`${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return invalid(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || forbiddenKeys.has(key)) return invalid(`${label} contains an unsupported key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return invalid(`${label} cannot contain accessors`);
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${label} has unsupported field ${key}`);
}
function text(value: unknown, label: string, max: number = L.MAX_TEXT_LENGTH, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && value.trim().length === 0) || value.includes(String.fromCharCode(0))) {
    return invalid(`${label} must be ${empty ? "a" : "a nonempty"} string of at most ${max} characters`);
  }
  return value;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalid(`${label} must be boolean`);
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return invalid(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}
function jsonValue(value: unknown, label: string, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 12 || ++budget.nodes > 1500) invalid(`${label} exceeds the structured value limit`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string") { text(value, label, L.MAX_FRAME_BYTES, true); return; }
  if (Array.isArray(value)) {
    if (value.length > 1000) invalid(`${label} contains too many items`);
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !("value" in d)) invalid(`${label} must contain JSON array values`);
      jsonValue(d.value, label, depth + 1, budget);
    }
    return;
  }
  const obj = record(value, label);
  const names = Object.keys(obj);
  if (names.length > 1000) invalid(`${label} contains too many fields`);
  for (const key of names) {
    text(key, `${label} key`, 256);
    jsonValue(obj[key], label, depth + 1, budget);
  }
}
function size(value: unknown, max: number, label: string): void {
  jsonValue(value, label);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > max) invalid(`${label} exceeds its byte limit`);
}
function optionalString(obj: Record<string, unknown>, key: string, max: number): string | undefined {
  return Object.hasOwn(obj, key) ? text(obj[key], key, max) : undefined;
}

export function validateOrigin(value: unknown): string {
  const raw = text(value, "origin", L.MAX_TEXT_LENGTH);
  let url: URL;
  try { url = new URL(raw); } catch { return invalid("origin must be a loopback HTTP(S) origin"); }
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return invalid("origin must be a loopback HTTP(S) origin without credentials, path, query or fragment");
  }
  return url.origin;
}

export function parseCommand(value: unknown): AppCommand {
  const obj = record(value, "command");
  switch (obj.type) {
    case "performance":
      keys(obj, ["type", "phase"], "performance command");
      if (obj.phase !== "begin" && obj.phase !== "capture") invalid("performance phase must be begin or capture");
      return { type: "performance", phase: obj.phase };
    case "snapshot": {
      keys(obj, ["type", "selector"], "snapshot command");
      const selector = optionalString(obj, "selector", L.MAX_SELECTOR_LENGTH);
      return selector === undefined ? { type: "snapshot" } : { type: "snapshot", selector };
    }
    case "click":
      keys(obj, ["type", "selector"], "click command");
      return { type: "click", selector: text(obj.selector, "selector", L.MAX_SELECTOR_LENGTH) };
    case "fill":
      keys(obj, ["type", "selector", "value"], "fill command");
      return { type: "fill", selector: text(obj.selector, "selector", L.MAX_SELECTOR_LENGTH), value: text(obj.value, "fill value", L.MAX_TEXT_LENGTH, true) };
    case "state":
      keys(obj, ["type", "store"], "state command");
      return { type: "state", store: text(obj.store, "store", L.MAX_NAME_LENGTH) };
    case "find":
      keys(obj, ["type", "query"], "semantic query command");
      return { type: "find", query: parseSemanticQuery(obj.query) };
    case "semantic-snapshot":
      keys(obj, ["type"], "semantic snapshot command");
      return { type: "semantic-snapshot" };
    case "semantic-tree":
      keys(obj, ["type"], "semantic tree command");
      return { type: "semantic-tree" };
    case "ref-click": case "ref-fill": {
      keys(obj, obj.type === "ref-fill" ? ["type", "ref", "value"] : ["type", "ref"], "live reference command");
      const ref = text(obj.ref, "live reference", 38);
      if (!SEMANTIC_REF_PATTERN.test(ref)) invalid("invalid opaque live reference");
      return obj.type === "ref-click" ? { type: "ref-click", ref } : { type: "ref-fill", ref, value: text(obj.value, "fill value", L.MAX_TEXT_LENGTH, true) };
    }
    case "causal-click": {
      keys(obj, ["type", "selector", "targets"], "causal click command");
      const selector = text(obj.selector, "selector", L.MAX_SELECTOR_LENGTH);
      assertSafeSelector(selector);
      if (!Array.isArray(obj.targets) || obj.targets.length === 0 || obj.targets.length > L.MAX_BASELINE_TARGETS) invalid("causal click requires 1 to 20 targets");
      const targets = obj.targets.map(parseRelativeTarget);
      if (new Set(targets.map(relativeTargetKey)).size !== targets.length) invalid("causal targets must be distinct");
      return { type: "causal-click", selector, targets };
    }
    default: return invalid("unsupported command type");
  }
}

export function parseSemanticQuery(value: unknown): SemanticQuery {
  const obj = record(value, "semantic query");
  const literal = (raw: unknown, label: string): string => {
    const input = text(raw, label, 256);
    if ([...input].some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) invalid("query contains an unpaired surrogate");
    const output = normalizeSemanticText(input);
    if (!output || new TextEncoder().encode(output).byteLength > 1024) invalid("query text is empty or exceeds its UTF-8 bound");
    const safe = sanitizeWithReport(output);
    if (safe.redacted || safe.truncation) invalid("semantic queries cannot contain credentials");
    return output;
  };
  if (obj.kind === "test-id") {
    keys(obj, ["kind", "testId"], "test-id query");
    return { kind: "test-id", testId: literal(obj.testId, "test id") };
  }
  const exact = Object.hasOwn(obj, "exact") ? bool(obj.exact, "query exact") : true;
  if (obj.kind === "role") {
    keys(obj, ["kind", "role", "name", "exact"], "role query");
    const role = literal(obj.role, "role").toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(role)) invalid("invalid semantic role");
    return { kind: "role", role, exact, ...(Object.hasOwn(obj, "name") ? { name: literal(obj.name, "name") } : {}) };
  }
  if (obj.kind === "name") { keys(obj, ["kind", "name", "exact"], "name query"); return { kind: "name", name: literal(obj.name, "name"), exact }; }
  if (obj.kind === "label") { keys(obj, ["kind", "label", "exact"], "label query"); return { kind: "label", label: literal(obj.label, "label"), exact }; }
  return invalid("unsupported semantic query strategy");
}

export function parseRelativeTarget(raw: unknown): RelativeTarget {
  const obj = record(raw, "relative target");
  if (obj.kind === "element") {
    keys(obj, ["kind", "selector"], "relative element target");
    const selector = text(obj.selector, "selector", L.MAX_SELECTOR_LENGTH);
    assertSafeSelector(selector);
    const safe = sanitizeWithReport(selector);
    if (safe.redacted || safe.truncation) invalid("relative targets cannot contain credentials");
    return { kind: "element", selector };
  }
  if (obj.kind === "state") {
    keys(obj, ["kind", "store", "path"], "relative state target");
    const store = text(obj.store, "store", L.MAX_NAME_LENGTH);
    const path = text(obj.path, "state path", L.MAX_SELECTOR_LENGTH, true);
    const segments = path === "" ? [] : path.split(".");
    if (segments.length > 32 || segments.some((segment) => !segment || forbiddenKeys.has(segment))) invalid("state path contains an unsupported segment");
    if ([store, ...segments].some(isSensitiveKey)) invalid("relative targets cannot contain credential-bearing paths");
    const safe = sanitizeWithReport({ store, path });
    if (safe.redacted || safe.truncation) invalid("relative targets cannot contain credentials");
    return { kind: "state", store, path };
  }
  return invalid("unsupported relative target");
}

export function parsePredicate(value: unknown): Predicate {
  let nodes = 0;
  function parse(raw: unknown, depth: number): Predicate {
    if (depth > L.MAX_PREDICATE_DEPTH || ++nodes > L.MAX_PREDICATE_NODES) invalid("predicate exceeds its complexity limit");
    const obj = record(raw, "predicate");
    switch (obj.kind) {
      case "performance":
        try { return parsePerformancePredicate(obj); } catch { return invalid("unsupported or invalid numeric performance lab predicate"); }
      case "relative": {
        keys(obj, ["kind", "target", "relation", "equals"], "relative predicate");
        const target = parseRelativeTarget(obj.target);
        if (obj.relation === "becomes") {
          if (!Object.hasOwn(obj, "equals")) invalid("becomes requires an expected value");
          size(obj.equals, L.MAX_EVENT_BYTES, "relative expectation");
          if (target.kind === "element" && (typeof obj.equals !== "number" || !Number.isSafeInteger(obj.equals) || obj.equals < 0)) invalid("relative element expectations must be nonnegative whole counts");
          return { kind: "relative", target, relation: "becomes", equals: obj.equals };
        }
        if (!["changed", "increased", "decreased"].includes(String(obj.relation)) || Object.hasOwn(obj, "equals")) invalid("unsupported relative comparison or expectation");
        return { kind: "relative", target, relation: obj.relation as "changed" | "increased" | "decreased" };
      }
      case "network": {
        keys(obj, ["kind", "urlContains", "method", "status"], "network predicate");
        const method = optionalString(obj, "method", 16);
        if (method !== undefined && !/^[A-Za-z]+$/.test(method)) invalid("network method must contain only letters");
        return { kind: "network", urlContains: text(obj.urlContains, "urlContains", L.MAX_TEXT_LENGTH),
          ...(method === undefined ? {} : { method: method.toUpperCase() }),
          ...(Object.hasOwn(obj, "status") ? { status: integer(obj.status, "status", 100, 599) } : {}) };
      }
      case "console":
        keys(obj, ["kind", "level", "absent"], "console predicate");
        if (obj.level !== "error" && obj.level !== "warn") invalid("console level must be error or warn");
        return { kind: "console", level: obj.level, absent: bool(obj.absent, "absent") };
      case "signal":
        keys(obj, ["kind", "name"], "signal predicate");
        return { kind: "signal", name: text(obj.name, "signal name", L.MAX_NAME_LENGTH) };
      case "state": {
        keys(obj, ["kind", "store", "path", "equals"], "state predicate");
        if (!Object.hasOwn(obj, "equals")) invalid("state predicate requires equals");
        const path = text(obj.path, "state path", L.MAX_SELECTOR_LENGTH, true);
        const parts = path === "" ? [] : path.split(".");
        if (parts.length > 32 || parts.some((p) => !p || forbiddenKeys.has(p))) invalid("state path contains an unsupported segment");
        size(obj.equals, L.MAX_EVENT_BYTES, "state expectation");
        return { kind: "state", store: text(obj.store, "store", L.MAX_NAME_LENGTH), path, equals: obj.equals };
      }
      case "element":
        keys(obj, ["kind", "selector", "state"], "element predicate");
        if (obj.state !== "present" && obj.state !== "absent") invalid("element state must be present or absent");
        return { kind: "element", selector: text(obj.selector, "selector", L.MAX_SELECTOR_LENGTH), state: obj.state };
      case "allOf": case "anyOf":
        keys(obj, ["kind", "predicates"], "composite predicate");
        if (!Array.isArray(obj.predicates) || obj.predicates.length === 0 || obj.predicates.length > 20) invalid("composite predicate requires 1 to 20 predicates");
        return { kind: obj.kind, predicates: obj.predicates.map((p) => parse(p, depth + 1)) };
      default: return invalid("unsupported predicate kind");
    }
  }
  const parsed = parse(value, 0);
  if (relativeTargets(parsed).length > L.MAX_BASELINE_TARGETS) invalid("relative predicate exceeds its 20 target limit");
  return parsed;
}

function assertSafeSelector(selector: string): void {
  // A persisted selector can carry credential values in attribute selectors as well as
  // name a credential field. Refuse both instead of rewriting its meaning on disk.
  if (selector.includes("\\")) invalid("saved flows cannot contain escaped selectors; use an ordinary selector so credential fields remain identifiable");
  const parts = selector.split(/[^A-Za-z0-9_-]+/).filter(Boolean);
  if (parts.some(isSensitiveKey)) invalid("saved flows cannot target credential-bearing selectors");
}
function assertSafePredicate(predicate: Predicate): void {
  if (predicate.kind === "allOf" || predicate.kind === "anyOf") {
    predicate.predicates.forEach(assertSafePredicate);
  } else if (predicate.kind === "element") {
    assertSafeSelector(predicate.selector);
  } else if (predicate.kind === "state" && [...predicate.path.split("."), predicate.store].some(isSensitiveKey)) {
    invalid("saved flows cannot assert credential-bearing state paths");
  }
}
export function parseFlowSteps(value: unknown): FlowStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > L.MAX_STEPS) invalid(`flow requires 1 to ${L.MAX_STEPS} steps`);
  size(value, L.MAX_FRAME_BYTES, "flow steps");
  return value.map((raw) => {
    const obj = record(raw, "flow step");
    keys(obj, ["command", "predicate", "anchor"], "flow step");
    const predicate = parsePredicate(obj.predicate);
    assertSafePredicate(predicate);
    const command = Object.hasOwn(obj, "command") ? parseCommand(obj.command) : undefined;
    if (command && ["find", "semantic-snapshot", "semantic-tree", "ref-click", "ref-fill"].includes(command.type)) invalid("semantic discovery and live references cannot be saved in flows; refresh them in the current session");
    const targets = relativeTargets(predicate);
    if (targets.length && command?.type !== "click" && command?.type !== "causal-click") invalid("saved relative checks require an explicit click action");
    if (targets.length && command?.type === "causal-click"
      && (command.targets.length !== targets.length || command.targets.some(target => !targets.some(expected => relativeTargetKey(expected) === relativeTargetKey(target))))) {
      invalid("saved causal targets must match their declared relative checks");
    }
    if (command?.type === "fill") invalid("saved flows cannot contain fill commands; use live fill so entered values are never persisted");
    if (command?.type === "state" && isSensitiveKey(command.store)) invalid("saved flows cannot read credential-bearing stores");
    if (command && "selector" in command && command.selector !== undefined) assertSafeSelector(command.selector);
    const anchor = Object.hasOwn(obj, "anchor") ? parseFlowAnchor(obj.anchor) : undefined;
    if (anchor && command?.type !== "click" && command?.type !== "causal-click") invalid("durable anchors require a saved click action");
    if (anchor?.kind === "css" && command && "selector" in command && anchor.selector !== command.selector) invalid("CSS anchor must preserve the exact action selector");
    if (anchor?.kind === "semantic" && targets.length) invalid("semantic anchors do not support CSS-addressed relative baselines; keep the CSS action");
    const step = { ...(command === undefined ? {} : { command }), predicate, ...(anchor ? { anchor } : {}) };
    const sanitized = sanitizeWithReport(step);
    if (sanitized.redacted || sanitized.truncation) invalid("saved flow contains a secret or exceeds the safe persistence limits");
    return step;
  });
}

export function parseCoverage(value: unknown): Coverage {
  const obj = record(value, "coverage");
  keys(obj, ["network", "console", "dom", "state", "signal", "route"], "coverage");
  return { network: bool(obj.network, "network coverage"), console: bool(obj.console, "console coverage"),
    dom: bool(obj.dom, "dom coverage"), state: bool(obj.state, "state coverage"),
    signal: bool(obj.signal, "signal coverage"), route: bool(obj.route, "route coverage") };
}

const eventFields: Record<string, string[]> = {
  "network.start": ["requestId", "url", "method", "initiator"],
  network: ["requestId", "url", "method", "status", "ok", "durationMs", "initiator", "error", "requestBody", "responseBody"],
  console: ["level", "message", "stack"], route: ["url"], signal: ["name", "data"],
  state: ["store", "value"], dom: ["selector", "count"],
  "observer.error": ["observer", "message"], "capture.loss": ["reason"], "action.boundary": [],
  "action.reading": ["phase", "target", "value", "available"],
  "action.source": ["observation"],
};
function parseEvent(raw: unknown): Extract<BrowserMessage, { type: "event" }>["event"] {
  const obj = record(raw, "event");
  keys(obj, ["type", "data", "actionId", "truncated"], "event");
  const type = text(obj.type, "event type", 64);
  if (!Object.hasOwn(eventFields, type)) invalid("unsupported event type");
  const data = record(obj.data, "event data");
  keys(data, eventFields[type], "event data");
  if (type === "network.start" || type === "network") {
    text(data.requestId, "requestId", L.MAX_NAME_LENGTH);
    text(data.url, "network URL", L.MAX_TEXT_LENGTH);
    text(data.method, "network method", 16);
    if (data.initiator !== "fetch" && data.initiator !== "xhr") invalid("network initiator must be fetch or xhr");
    if (type === "network") {
      integer(data.status, "network status", 0, 599);
      bool(data.ok, "network ok");
      if (typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs) || data.durationMs < 0 || data.durationMs > 86_400_000) invalid("network duration is out of bounds");
      for (const field of ["error", "requestBody", "responseBody"]) {
        if (Object.hasOwn(data, field)) text(data[field], field, L.MAX_TEXT_LENGTH, true);
      }
    }
  } else if (type === "console") {
    if (!["log", "info", "debug", "warn", "error"].includes(String(data.level))) invalid("unsupported console level");
    text(data.message, "console message", L.MAX_TEXT_LENGTH, true);
    if (Object.hasOwn(data, "stack")) text(data.stack, "console stack", L.MAX_TEXT_LENGTH, true);
  } else if (type === "signal") text(data.name, "signal name", L.MAX_NAME_LENGTH);
  else if (type === "route") text(data.url, "route URL", L.MAX_TEXT_LENGTH);
  else if (type === "state") {
    text(data.store, "store", L.MAX_NAME_LENGTH);
    if (!Object.hasOwn(data, "value")) invalid("state event requires value");
  } else if (type === "dom") {
    text(data.selector, "selector", L.MAX_SELECTOR_LENGTH);
    integer(data.count, "DOM match count", 0, 1_000_000);
  } else if (type === "observer.error") {
    if (!["network", "console", "dom", "state", "signal", "route"].includes(String(data.observer))) invalid("unsupported observer");
    text(data.message, "observer error", L.MAX_TEXT_LENGTH, true);
  } else if (type === "capture.loss") text(data.reason, "capture loss reason", L.MAX_TEXT_LENGTH);
  else if (type === "action.source") {
    if (Object.hasOwn(obj, "truncated")) invalid("source context cannot claim a truncated pointer");
    try { data.observation = parseControlSourceObservation(data.observation); }
    catch { invalid("invalid control source context"); }
  } else if (type === "action.reading") {
    if (data.phase !== "before" && data.phase !== "after") invalid("unsupported action reading phase");
    data.target = parseRelativeTarget(data.target);
    const available = bool(data.available, "reading available");
    if (available && !Object.hasOwn(data, "value")) invalid("available action readings require a value");
    if (!available && Object.hasOwn(data, "value")) invalid("unavailable action readings cannot claim a value");
  }
  const actionId = optionalString(obj, "actionId", L.MAX_NAME_LENGTH);
  if (["action.boundary", "action.reading", "action.source"].includes(type) && actionId === undefined) invalid("action capture requires actionId");
  size(obj, L.MAX_EVENT_BYTES, "event");
  return { type, data, ...(actionId === undefined ? {} : { actionId }),
    ...(Object.hasOwn(obj, "truncated") ? { truncated: bool(obj.truncated, "truncated") } : {}) };
}

export function parseBrowserMessage(value: unknown): BrowserMessage {
  size(value, L.MAX_FRAME_BYTES, "browser message");
  const obj = record(value, "browser message");
  switch (obj.type) {
    case "hello": {
      if (obj.version === TREE_PROTOCOL_VERSION) {
        keys(obj, ["type", "version", "token", "coverage", "capabilities"], "hello message");
        if (!Array.isArray(obj.capabilities) || obj.capabilities.length > 4 || !obj.capabilities.includes(TREE_CAPABILITY)
          || new Set(obj.capabilities).size !== obj.capabilities.length || obj.capabilities.some(entry => ![CAUSAL_CAPABILITY, SEMANTIC_CAPABILITY, SOURCE_CAPABILITY, TREE_CAPABILITY].includes(entry))) invalid("unsupported or duplicate tree capabilities");
        return { type: "hello", version: TREE_PROTOCOL_VERSION, token: text(obj.token, "token", 512), coverage: parseCoverage(obj.coverage), capabilities: obj.capabilities as VerificationCapability[] };
      }
      if (obj.version === PERFORMANCE_PROTOCOL_VERSION) {
        keys(obj, ["type", "version", "token", "coverage", "capabilities"], "hello");
        if (!Array.isArray(obj.capabilities) || obj.capabilities.length > 5 || !obj.capabilities.includes(PERFORMANCE_CAPABILITY)
          || new Set(obj.capabilities).size !== obj.capabilities.length || obj.capabilities.some(entry => ![CAUSAL_CAPABILITY, SEMANTIC_CAPABILITY, SOURCE_CAPABILITY, TREE_CAPABILITY, PERFORMANCE_CAPABILITY].includes(entry))) invalid("unsupported or duplicate performance capabilities");
        return { type: "hello", version: PERFORMANCE_PROTOCOL_VERSION, token: text(obj.token, "token", 512), coverage: parseCoverage(obj.coverage), capabilities: obj.capabilities as VerificationCapability[] };
      }
      if (obj.version === SOURCE_PROTOCOL_VERSION) {
        keys(obj, ["type", "version", "token", "coverage", "capabilities"], "hello");
        if (!Array.isArray(obj.capabilities) || obj.capabilities.length > 3 || !obj.capabilities.includes(SOURCE_CAPABILITY)
          || new Set(obj.capabilities).size !== obj.capabilities.length || obj.capabilities.some(entry => ![CAUSAL_CAPABILITY, SEMANTIC_CAPABILITY, SOURCE_CAPABILITY].includes(entry))) invalid("unsupported or duplicate source capabilities");
        return { type: "hello", version: SOURCE_PROTOCOL_VERSION, token: text(obj.token, "token", 512), coverage: parseCoverage(obj.coverage), capabilities: obj.capabilities as VerificationCapability[] };
      }
      if (obj.version === PROTOCOL_VERSION) {
        keys(obj, ["type", "version", "token", "coverage"], "hello");
        return { type: "hello", version: PROTOCOL_VERSION, token: text(obj.token, "token", 512), coverage: parseCoverage(obj.coverage) };
      }
      if (obj.version === SEMANTIC_PROTOCOL_VERSION) {
        keys(obj, ["type", "version", "token", "coverage", "capabilities"], "hello");
        if (!Array.isArray(obj.capabilities) || obj.capabilities.length > 2 || new Set(obj.capabilities).size !== obj.capabilities.length
          || obj.capabilities.some((entry) => entry !== CAUSAL_CAPABILITY && entry !== SEMANTIC_CAPABILITY)) invalid("unsupported or duplicate verification capabilities");
        return { type: "hello", version: SEMANTIC_PROTOCOL_VERSION, token: text(obj.token, "token", 512), coverage: parseCoverage(obj.coverage), capabilities: obj.capabilities as VerificationCapability[] };
      }
      if (obj.version !== CAUSAL_PROTOCOL_VERSION) invalid("unsupported verification protocol version");
      keys(obj, ["type", "version", "token", "coverage", "capabilities"], "hello");
      if (!Array.isArray(obj.capabilities) || obj.capabilities.length > 1 || obj.capabilities.some((entry) => entry !== CAUSAL_CAPABILITY)) invalid("unsupported causal capabilities");
      return { type: "hello", version: CAUSAL_PROTOCOL_VERSION, token: text(obj.token, "token", 512), coverage: parseCoverage(obj.coverage), capabilities: obj.capabilities as Array<typeof CAUSAL_CAPABILITY> };
    }
    case "event":
      keys(obj, ["type", "event"], "event message");
      return { type: "event", event: parseEvent(obj.event) };
    case "result": {
      keys(obj, ["type", "id", "ok", "result", "error", "truncated"], "result message");
      const error = optionalString(obj, "error", L.MAX_REASON_LENGTH);
      return { type: "result", id: text(obj.id, "command id", L.MAX_NAME_LENGTH), ok: bool(obj.ok, "ok"),
        ...(Object.hasOwn(obj, "result") ? { result: obj.result } : {}),
        ...(error === undefined ? {} : { error }),
        ...(Object.hasOwn(obj, "truncated") ? { truncated: bool(obj.truncated, "truncated") } : {}) };
    }
    default: return invalid("unsupported browser message type");
  }
}
