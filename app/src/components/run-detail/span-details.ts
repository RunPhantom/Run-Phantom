import type { Span } from "../../utils/types";

export type Attributes = Record<string, unknown>;

function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function toolName(entry: unknown): string | null {
  const value = decoded(entry);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name === "string") return record.name;
  const fn = record.function;
  if (fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).name === "string") return (fn as Record<string, string>).name;
  return null;
}

/**
 * Tools the model was offered, from the OTel GenAI (`gen_ai.tool.definitions`,
 * `gen_ai.request.tools`), AI SDK (`ai.prompt.tools`) and OpenInference
 * (`llm.tools.N.tool.json_schema`) spellings, in declaration order.
 */
export function availableTools(attrs: Attributes | null): string[] {
  if (!attrs) return [];
  const names: string[] = [];
  const add = (name: string | null) => { if (name && !names.includes(name)) names.push(name); };
  for (const key of ["gen_ai.tool.definitions", "gen_ai.request.tools", "ai.prompt.tools", "llm.tools"]) {
    const value = decoded(attrs[key]);
    if (Array.isArray(value)) for (const entry of value) add(toolName(entry) ?? toolName((entry as Record<string, unknown> | null)?.tool));
  }
  const indexed = Object.keys(attrs)
    .map(key => /^llm\.tools\.(\d+)\.tool\.json_schema$/.exec(key))
    .filter((match): match is RegExpExecArray => !!match)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  for (const match of indexed) add(toolName(attrs[match[0]]));
  return names;
}

const MARKDOWN_HINT = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\n\|[^\n]*\|/;

export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_HINT.test(text);
}

export type PayloadShape = { kind: "json"; value: unknown } | { kind: "text"; text: string };

export function payloadShape(payload: string): PayloadShape {
  const text = payload.trim();
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try { return { kind: "json", value: JSON.parse(text) }; } catch { /* plain text */ }
  }
  if (text.startsWith("\"") && text.endsWith("\"")) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "string") return { kind: "text", text: value };
    } catch { /* plain text */ }
  }
  return { kind: "text", text: payload };
}

/** Request settings and provider options worth showing next to the model call, keyed by their short name. */
export function providerOptions(attrs: Attributes | null): { title: string; options: Record<string, unknown> } | null {
  if (!attrs) return null;
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!(key === "ai.provider.headers" || key === "ai.request.thinking" || key === "ai.request.providerOptions"
      || key.startsWith("ai.settings.") || key.startsWith("ai.request.headers.")
      || (key.startsWith("gen_ai.request.") && key !== "gen_ai.request.model" && key !== "gen_ai.request.tools"))) continue;
    const label = key.replace("gen_ai.request.", "").replace("ai.provider.", "").replace("ai.request.", "").replace("ai.settings.", "settings.");
    let parsed = value;
    if (typeof value === "string") { try { parsed = JSON.parse(value); } catch { /* keep the string */ } }
    if (label === "providerOptions" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      const inner = entries.length === 1 ? entries[0]![1] : null;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        Object.assign(options, inner);
        continue;
      }
    }
    options[label] = parsed;
  }
  if (!Object.keys(options).length) return null;
  const provider = typeof attrs["ai.model.provider"] === "string" ? (attrs["ai.model.provider"] as string).split(".")[0]! : "";
  const name = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "";
  return { title: name ? `Provider Options (${name})` : "Provider Options", options };
}

export function previewValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 25 ? `${value.slice(0, 25)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).slice(0, 3);
    const inner = entries.map(([key, item]) => `${key}: ${item && typeof item === "object" ? (Array.isArray(item) ? `[${item.length}]` : "{...}") : previewValue(item)}`).join(", ");
    return entries.length < Object.keys(value).length ? `${inner}, …` : inner;
  }
  return String(value);
}

/** A link to one step that survives a reload: the current route with the span segment replaced. */
export function stepLink(origin: string, pathname: string, search: string, spanId: string): string {
  const base = pathname.replace(/\/(spans|span\/[^/]+|convo)$/, "");
  return `${origin}${base}/span/${encodeURIComponent(spanId)}${search}`;
}

export function stepAsJson(span: Span): string {
  const { normalized: _normalized, captureVisibility: _visibility, guardEvidence: _guard, ...stored } = span;
  return JSON.stringify(stored, null, 2);
}
