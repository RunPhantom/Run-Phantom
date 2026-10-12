import type { ControlSourceObservation } from "../protocol";
import { sanitizeWithReport } from "../serialization";

export const SOURCE_ATTRIBUTE = "data-runphantom-source";
const unsafeText = (value: string) => Array.from(value).some(character => {
  const code = character.codePointAt(0)!;
  return code < 32 || code === 127 || code >= 0xd800 && code <= 0xdfff;
});
const encoder = new TextEncoder();
export function sourceComponent(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && encoder.encode(value).byteLength <= 128 && !unsafeText(value) ? value : undefined;
}
const unavailableReasons = ["not-react", "source-unavailable", "unsafe-source", "probe-limit", "probe-error", "redacted"] as const;
export const sourceUnavailable = (reason: Extract<ControlSourceObservation, { status: "unavailable" }>["reason"]): ControlSourceObservation =>
  ({ source: "sdk-reported", framework: "react", status: "unavailable", reason });

/** Textual repo containment only; this never asserts filesystem or source authenticity. */
export function sourceFile(raw: unknown, root?: string): string | null {
  if (typeof raw !== "string" || raw.length > 4096 || (unsafeText(raw) || /[%?#]/.test(raw))) return null;
  let file = raw.replace(/\\/g, "/");
  if (file.startsWith("//")) return null;
  if (file.startsWith("/") || /^[A-Za-z]:\//.test(file)) {
    if (typeof root !== "string" || !root || root.length > 4096 || (unsafeText(root) || /[%?#]/.test(root))) return null;
    const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalizedRoot || normalizedRoot.split("/").some(part => part === "." || part === "..")) return null;
    const windows = /^[A-Za-z]:\//.test(file) && /^[A-Za-z]:\//.test(normalizedRoot);
    const prefix = `${normalizedRoot}/`;
    if (!(windows ? file.toLowerCase().startsWith(prefix.toLowerCase()) : file.startsWith(prefix))) return null;
    file = file.slice(prefix.length);
  }
  if (file.length > 384 || encoder.encode(file).byteLength > 512 || file.startsWith("/") || file.includes(":")) return null;
  if (file.split("/").some(part => !part || part === "." || part === "..") || !/\.(?:[cm]?js|jsx|ts|tsx)$/.test(file)) return null;
  return file;
}

export function parseControlSourceObservation(raw: unknown): ControlSourceObservation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![null, Object.prototype].includes(Object.getPrototypeOf(raw))) throw new Error("Source context must be plain data");
  const fields = Reflect.ownKeys(raw);
  if (fields.length > 10) throw new Error("Source context exceeds its field limit");
  const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor)) throw new Error("Source context cannot contain accessors");
    value[key] = descriptor.value;
  }
  const allowed = value.status === "captured" ? ["source", "framework", "status", "mechanism", "scope", "file", "line", "column", "component"] : ["source", "framework", "status", "reason"];
  if (fields.some(key => typeof key !== "string" || !allowed.includes(key)) || value.source !== "sdk-reported" || value.framework !== "react") throw new Error("Unsupported source context");
  if (value.status === "unavailable") {
    if (!unavailableReasons.includes(value.reason as typeof unavailableReasons[number])) throw new Error("Unsupported source availability reason");
    return sourceUnavailable(value.reason as typeof unavailableReasons[number]);
  }
  const location = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 0x7fffffff;
  if (value.status !== "captured" || (value.mechanism !== "dev-stamp" && value.mechanism !== "react-debug-source") || (value.scope !== "control" && value.scope !== "ancestor")
    || typeof value.file !== "string" || sourceFile(value.file) !== value.file || !location(value.line) || Object.hasOwn(value, "column") && !location(value.column)
    || Object.hasOwn(value, "component") && (typeof value.component !== "string" || !value.component.trim() || unsafeText(value.component) || encoder.encode(value.component).byteLength > 128)) throw new Error("Unsafe or oversized source context");
  const result = { source: "sdk-reported", framework: "react", status: "captured", mechanism: value.mechanism, scope: value.scope,
    file: value.file, line: value.line, ...(Object.hasOwn(value, "column") ? { column: value.column } : {}), ...(Object.hasOwn(value, "component") ? { component: value.component } : {}) } as ControlSourceObservation;
  if (encoder.encode(JSON.stringify(result)).byteLength > 1024) throw new Error("Source context exceeds its byte limit");
  return result;
}

/** A withheld/expanded field is not a valid source pointer. Revalidate after redaction. */
export function sanitizeControlSource(raw: unknown, scrub?: (value: string) => string): ControlSourceObservation {
  try {
    const source = parseControlSourceObservation(raw);
    if (source.status === "unavailable") return source;
    const clean = (value: string) => sanitizeWithReport(value, { scrubString: scrub });
    const file = clean(source.file);
    if (file.redacted || file.truncation || file.value !== source.file) return sourceUnavailable("redacted");
    const component = source.component === undefined ? undefined : clean(source.component);
    const { component: _component, ...rest } = source;
    return parseControlSourceObservation({ ...rest, ...(component && !component.redacted && !component.truncation && component.value === source.component ? { component: component.value } : {}) });
  } catch { return sourceUnavailable("unsafe-source"); }
}
