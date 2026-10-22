// Observe only schema paths and duplicate carrier keys; JSON.parse remains the
// syntax/value parser. No raw values or business strings survive this scan.
export const OTLP_TAG_SOURCE_LIMITS = { bytes: 50 * 1024 * 1024, depth: 64, tokens: 250_000, paths: 10_000, keyUnits: 128 } as const;
export interface OtlpTagSourceEvidence { readonly complete: boolean; readonly unavailablePaths: ReadonlySet<string> }
type Context = "root" | "resources" | "resource" | "scopes" | "scope" | "spans" | "span" | "attributes" | "attribute" | "carrier" | "other";
interface Attribute { path: string; tags: boolean; ambiguous: boolean }
interface Frame { object: boolean; context: Context; path: number[]; index: number; key?: string; seen: number; attribute?: Attribute }
const carrierKeys = ["key", "value", "stringValue", "boolValue", "intValue", "doubleValue", "arrayValue", "kvlistValue", "bytesValue", "values"];
const incomplete = (): OtlpTagSourceEvidence => ({ complete: false, unavailablePaths: new Set() });
export const unavailableOtlpTagSource = incomplete;
const whitespace = (character: string | undefined) => character === " " || character === "\t" || character === "\r" || character === "\n";

export function observeOtlpTagSource(text: string): OtlpTagSourceEvidence {
  const L = OTLP_TAG_SOURCE_LIMITS;
  if (text.length > L.bytes || Buffer.byteLength(text) > L.bytes) return incomplete();
  const frames: Frame[] = [], unavailablePaths = new Set<string>();
  let tokens = 0;
  function mark(path: string): boolean {
    if (!unavailablePaths.has(path) && unavailablePaths.size >= L.paths) return false;
    unavailablePaths.add(path); return true;
  }
  function child(parent: Frame | undefined, object: boolean): Frame {
    const frame: Frame = { object, context: "other", path: parent?.path ?? [], index: 0, seen: 0 };
    if (!parent) { if (object) frame.context = "root"; return frame; }
    if (parent.context === "carrier") { frame.context = "carrier"; frame.attribute = parent.attribute; }
    else if (parent.context === "attribute" && parent.key === "value") { frame.context = "carrier"; frame.attribute = parent.attribute; }
    else if (parent.object && !object) {
      if (parent.context === "root" && parent.key === "resourceSpans") frame.context = "resources";
      else if (parent.context === "resource" && parent.key === "scopeSpans") frame.context = "scopes";
      else if (parent.context === "scope" && parent.key === "spans") frame.context = "spans";
      else if (parent.context === "span" && parent.key === "attributes") frame.context = "attributes";
    } else if (!parent.object && object) {
      if (parent.context === "resources") { frame.context = "resource"; frame.path = [parent.index]; }
      else if (parent.context === "scopes") { frame.context = "scope"; frame.path = [...parent.path, parent.index]; }
      else if (parent.context === "spans") { frame.context = "span"; frame.path = [...parent.path, parent.index]; }
      else if (parent.context === "attributes") { frame.context = "attribute"; frame.attribute = { path: parent.path.join("/"), tags: false, ambiguous: false }; }
    }
    return frame;
  }
  for (let index = 0; index < text.length; index++) {
    const character = text[index], frame = frames[frames.length - 1];
    if (whitespace(character)) continue;
    if (++tokens > L.tokens) return incomplete();
    if (character === "{" || character === "[") {
      if (frames.length >= L.depth || frame && !Number.isSafeInteger(frame.index)) return incomplete();
      frames.push(child(frame, character === "{"));
    } else if (character === "}" || character === "]") {
      const closed = frames.pop();
      if (!closed || closed.object !== (character === "}")) return incomplete();
      if (closed.context === "attribute" && closed.attribute?.tags && closed.attribute.ambiguous && !mark(closed.attribute.path)) return incomplete();
    } else if (character === ",") {
      if (!frame) return incomplete();
      frame.key = undefined;
      if (!frame.object && (!Number.isSafeInteger(++frame.index) || frame.index > L.tokens)) return incomplete();
    } else if (character === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') { if (text[index] === "\\") index++; index++; }
      if (index >= text.length) return incomplete();
      let next = index + 1;
      while (whitespace(text[next])) next++;
      if (text[next] === ":" && frame?.object) {
        let key = "";
        // A UTF16 unit can occupy six raw JSON characters; quotes are excluded.
        if (index - start - 1 <= L.keyUnits * 6) {
          try {
            const decoded = JSON.parse(text.slice(start, index + 1)) as string;
            if (decoded.length <= L.keyUnits) key = decoded;
          } catch { return incomplete(); }
        }
        frame.key = key;
        if (frame.context === "attribute" || frame.context === "carrier") {
          const bit = carrierKeys.indexOf(key);
          if (bit >= 0) {
            if (frame.seen & (1 << bit)) frame.attribute!.ambiguous = true;
            frame.seen |= 1 << bit;
          }
        } else {
          const structural = frame.context === "root" ? ["resourceSpans"] : frame.context === "resource" ? ["scopeSpans"]
            : frame.context === "scope" ? ["spans"] : frame.context === "span" ? ["attributes", "droppedAttributesCount"] : [];
          const bit = structural.indexOf(key);
          if (bit >= 0) {
            if ((frame.seen & (1 << bit)) && !mark(frame.path.join("/"))) return incomplete();
            frame.seen |= 1 << bit;
          }
        }
      } else if (frame?.context === "attribute" && frame.key === "key" && index - start - 1 <= L.keyUnits * 6) {
        try { frame.attribute!.tags ||= JSON.parse(text.slice(start, index + 1)) === "tags"; } catch { return incomplete(); }
      }
    } else if (character !== ":") {
      // Primitive tokens have no authority or schema indices. Their exact
      // numeric meaning and syntax are handled by the existing parser.
      while (index + 1 < text.length && !whitespace(text[index + 1]) && !",]}".includes(text[index + 1])) index++;
    }
  }
  return frames.length ? incomplete() : { complete: true, unavailablePaths };
}

export function ambiguousOtlpTagSpans(body: any, evidence: OtlpTagSourceEvidence): WeakSet<object> {
  const spans = new WeakSet<object>();
  if (!Array.isArray(body?.resourceSpans)) return spans;
  body.resourceSpans.forEach((resource: any, r: number) => {
    if (!Array.isArray(resource?.scopeSpans)) return;
    resource.scopeSpans.forEach((scope: any, s: number) => {
      if (!Array.isArray(scope?.spans)) return;
      scope.spans.forEach((span: unknown, p: number) => {
        if (span && typeof span === "object" && (!evidence.complete || evidence.unavailablePaths.has("")
          || evidence.unavailablePaths.has(String(r)) || evidence.unavailablePaths.has(`${r}/${s}`) || evidence.unavailablePaths.has(`${r}/${s}/${p}`))) spans.add(span);
      });
    });
  });
  return spans;
}
