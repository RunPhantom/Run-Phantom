const INACTIVE_MS = 30_000;
// Short post-finish window where the activity pulse is still shown, so a
// run that completes between sidebar glances doesn't appear inert.
const AFTERGLOW_MS = 3_000;

export function fmt(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;

  // Minutes were the largest unit, so a long agent run read as "205.0m" — a
  // number the reader has to divide themselves. Rounding is normalised upward
  // first so 23h 60m becomes 1d rather than "24h".
  let minutes = Math.round(ms / 60000);
  let hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  const days = Math.floor(hours / 24);
  hours -= days * 24;

  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * `3 spans`, `1 span`. Counts were interpolated straight into a fixed plural
 * noun, so a single item read as "1 spans" — including inside aria-labels,
 * where a screen reader announces it verbatim.
 */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function ago(t: number): string {
  const d = Date.now() - t;
  // A clock-skewed exporter can stamp a run in the future, which made every
  // branch below read as an elapsed time that had not happened yet.
  if (d < -5000) return "in the future";
  if (d < 5000) return "just now";
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  if (d < 2592000000) return `${Math.floor(d / 86400000)}d ago`;
  if (d < 31536000000) return `${Math.floor(d / 2592000000)}mo ago`;
  return `${Math.floor(d / 31536000000)}y ago`;
}

export function isActive(run: {
  last_updated_at: number;
  finished?: number | null;
  live_event_count?: number | null;
}): boolean {
  const recencyMs = Date.now() - run.last_updated_at;
  if (recencyMs < AFTERGLOW_MS) return true;
  if ((run.live_event_count ?? 0) > 0) return recencyMs < INACTIVE_MS;
  if (run.finished) return false;
  // Time-based fallback for SDKs that never emit a finish() / root-span close.
  return recencyMs < INACTIVE_MS;
}

export function runDisplayName(
  run: { id: string; display_name?: string | null; event_name: string | null; name: string | null },
  fallbackLength = 12,
): string {
  return run.display_name?.trim()
    || run.event_name?.replace(/^replay:/i, "").trim()
    || run.name?.trim()
    || run.id.slice(0, fallbackLength);
}

export function trunc(s: string | null | undefined, n = 300): string | null {
  if (!s) return null;
  if (s.length <= n) return s;
  return s.slice(0, n) + "\u2026";
}

export function tryJson(s: string | null | undefined): string | null {
  if (!s) return null;
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}

// Rendering a multi-MB payload verbatim into the DOM (a <pre>, a tooltip, a
// markdown block) costs time and memory linear in the payload size and, on a
// pathological trace, can settle a page in seconds. Cap what is rendered inline;
// copy/download paths keep using the full string via tryJson.
export const MAX_INLINE_PAYLOAD = 100_000;
export function displayPayload(s: string | null | undefined, cap = MAX_INLINE_PAYLOAD): string | null {
  if (!s) return null;
  if (s.length <= cap) return tryJson(s);
  const omitted = (s.length - cap).toLocaleString();
  return s.slice(0, cap) + `\n\n… [truncated — ${omitted} more characters omitted for performance; use copy/download for the full payload]`;
}

/**
 * Compact one-line summary of an args object for inline pills, e.g.
 * `query: "search…", limit: 10`. Accepts a JSON string or a parsed value.
 * Returns null when there's nothing useful to render.
 */
export function argsPreview(input: unknown): string | null {
  if (input == null) return null;
  let obj: unknown = input;
  if (typeof input === "string") {
    try { obj = JSON.parse(input); }
    catch { return input.length > 40 ? input.slice(0, 40) + "\u2026" : input; }
  }
  if (typeof obj !== "object" || obj === null) return null;
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) return null;
  const parts = entries.slice(0, 3).map(([k, v]) => {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}: ${val.length > 30 ? val.slice(0, 30) + "\u2026" : val}`;
  });
  if (entries.length > 3) parts.push("\u2026");
  return parts.join(", ");
}

/** Derive a provider label from a model name or provider string */
export function detectProvider(model: string | null | undefined, provider: string | null | undefined): { label: string } | null {
  const s = (model ?? provider ?? "").toLowerCase();
  if (s.includes("claude") || s.includes("anthropic")) return { label: "Anthropic" };
  if (s.includes("gpt") || s.includes("openai") || s.includes("o1") || s.includes("o3") || s.includes("o4")) return { label: "OpenAI" };
  if (s.includes("gemini") || s.includes("google")) return { label: "Google" };
  if (s.includes("cohere") || s.includes("command")) return { label: "Cohere" };
  if (s.includes("mistral")) return { label: "Mistral" };
  if (s.includes("llama") || s.includes("meta")) return { label: "Meta" };
  return null;
}

/**
 * ISO timestamp for display, or an em dash when the value cannot be one.
 *
 * `Date.prototype.toISOString` throws RangeError outside ±8.64e15 ms, unlike the
 * toLocale* family which degrades to "Invalid Date". A single skewed span
 * timestamp — clock drift, a bad exporter, a hostile trace — would otherwise
 * throw during render and take the view down with it.
 */
export function isoTimestamp(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    // Marked UTC because toISOString() is UTC while every relative time in the
    // app ("2m ago") is local — an unmarked absolute stamp reads as local and is
    // silently wrong by the reader's offset. The ISO shape is kept so the value
    // can be pasted straight into a log query.
    return `${d.toISOString().replace("T", " ").slice(0, 23)} UTC`;
  } catch {
    return "—";
  }
}

/**
 * Decode a URL path parameter, falling back to the raw value.
 *
 * `decodeURIComponent` throws URIError on a malformed escape (a bare `%`, or a
 * truncated `%E0%A4`). React Router hands route params through unvalidated, so a
 * hand-typed or truncated deep link would throw during render.
 */
export function safeDecodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
