import type { NormalizedMessage } from "../normalized";

/**
 * Flatten a content value (string, content-block array, or {content}-object)
 * to a plain string. Drops non-text blocks (`tool_use`, `tool_result`, image
 * blocks) — those are preserved on `NormalizedMessage.raw` for renderers
 * that want full fidelity.
 */
export function extractContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractContentBlock).filter(Boolean).join("");
  }
  if (typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
  }
  return "";
}

function extractContentBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (block && typeof block === "object") {
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") return b.text;
    // tool_use / tool_result / image — intentionally skipped here.
    if (b.type === "tool_use" || b.type === "tool_result") return "";
    if (typeof b.text === "string") return b.text;
    if (typeof b.content === "string") return b.content;
  }
  return "";
}

/** Convenience: last user-role message text from a normalized message list. */
export function lastUserText(messages: NormalizedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].content) return messages[i].content;
  }
  return "";
}

/**
 * Try to parse a string as JSON; return the raw string if it isn't valid JSON.
 * Used by tool adapters where args / results are *usually* JSON but the SDK
 * isn't strict about it. Beats `JSON.parse(x) || x` because that swallows
 * `null` / falsy parses.
 */
export function parseJsonOrRaw(s: string | undefined): unknown {
  if (s == null) return undefined;
  try { return JSON.parse(s); } catch { return s; }
}

/** Cheap "does this look like a JSON literal" test — used to disambiguate adapters. */
export function looksLikeJson(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[") || t.startsWith("\"");
}

export function roleOrUnknown(role: string): NormalizedMessage["role"] {
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") return role;
  return "user";
}
