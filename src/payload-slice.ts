import { JSONPath } from "jsonpath-plus";

export interface SlicePayloadOpts {
  payload: string;
  jsonpath?: string;
  range?: [number, number];
  maxChars?: number;
  format?: "json" | "text";
}

export interface SlicePayloadResult {
  format: "json" | "text";
  value: unknown;
  total_chars: number;
  returned_range: [number, number];
  truncated: boolean;
  next_offset?: number;
}

const DEFAULT_MAX = 8000;
const HARD_MAX = 32000;

export function sliceSpanPayload(opts: SlicePayloadOpts): SlicePayloadResult {
  const requestedCap = (opts.maxChars !== undefined && Number.isFinite(opts.maxChars))
    ? opts.maxChars
    : DEFAULT_MAX;
  const cap = Math.max(1, Math.min(HARD_MAX, requestedCap));
  const total = opts.payload.length;

  if (opts.jsonpath) {
    let parsed: unknown;
    try { parsed = JSON.parse(opts.payload); }
    catch { throw new Error("payload is not valid JSON"); }
    const matches = JSONPath({ path: opts.jsonpath, json: parsed as object });
    if (!matches || (Array.isArray(matches) && matches.length === 0)) {
      throw new Error(`jsonpath ${opts.jsonpath} matched nothing`);
    }
    const value = Array.isArray(matches) && matches.length === 1 ? matches[0] : matches;
    const stringified = JSON.stringify(value);
    if (stringified.length <= cap) {
      return {
        format: "json",
        value,
        total_chars: total,
        returned_range: [0, stringified.length],
        truncated: false,
      };
    }
    return {
      format: "text",
      value: stringified.slice(0, cap),
      total_chars: total,
      returned_range: [0, cap],
      truncated: true,
      next_offset: cap,
    };
  }

  const start = Math.max(0, opts.range?.[0] ?? 0);
  const requestedEnd = opts.range?.[1] ?? Math.min(total, start + cap);
  const end = Math.max(start, Math.min(total, Math.min(requestedEnd, start + cap)));
  const slice = opts.payload.slice(start, end);

  if (opts.format === "json" && start === 0 && end === total) {
    try {
      return {
        format: "json",
        value: JSON.parse(slice),
        total_chars: total,
        returned_range: [start, end],
        truncated: false,
      };
    } catch { /* fall through to text */ }
  }

  return {
    format: "text",
    value: slice,
    total_chars: total,
    returned_range: [start, end],
    truncated: end < total,
    next_offset: end < total ? end : undefined,
  };
}
