import type { ControlSourceObservation } from "../../protocol";
import { SOURCE_ATTRIBUTE, parseControlSourceObservation, sourceFile, sourceUnavailable, sourceComponent } from "../../build/source";
import { nativeAttribute } from "../dom/realm";

const object = (value: unknown): value is object => value !== null && (typeof value === "object" || typeof value === "function");
const LIMIT = new Error("source probe limit");

/** Best-effort metadata only. No hooks, props, application values or component calls. */
export function identifyReactControl(el: Element, repoRoot?: string): ControlSourceObservation {
  try {
    let remaining = 512;
    const read = (value: unknown, key: string): unknown => {
      if (!object(value)) return undefined;
      if (--remaining < 0) throw LIMIT;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    const raw = nativeAttribute(el, SOURCE_ATTRIBUTE);
    let stamped: ControlSourceObservation | undefined;
    if (raw !== null) {
      const match = raw.length <= 540 ? /^(.*):(\d+):(\d+)$/.exec(raw) : null;
      if (!match) return sourceUnavailable("unsafe-source");
      try { stamped = parseControlSourceObservation({ source: "sdk-reported", framework: "react", status: "captured", mechanism: "dev-stamp", scope: "control", file: match[1], line: Number(match[2]), column: Number(match[3]) }); }
      catch { return sourceUnavailable("unsafe-source"); }
    }
    const keys = Object.getOwnPropertyNames(el);
    if (keys.length > 256) return stamped ?? sourceUnavailable("probe-limit");
    const key = keys.find(key => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
    let fiber = key ? read(el, key) : undefined;
    if (!object(fiber)) return stamped ?? sourceUnavailable("not-react");
    const rootOf = (start: object): object => {
      let top = start; const seen = new Set<object>();
      for (let depth = 0; depth < 40; depth++) {
        if (seen.has(top)) throw LIMIT;
        seen.add(top);
        const parent = read(top, "return");
        if (parent === null) return top;
        if (!object(parent)) throw new Error("Unresolved React ownership");
        top = parent;
      }
      throw LIMIT;
    };
    const root = rootOf(fiber);
    const current = read(read(root, "stateNode"), "current");
    if (current !== root) {
      const alternate = read(fiber, "alternate");
      if (!object(alternate) || rootOf(alternate) !== current) return stamped ?? sourceUnavailable("source-unavailable");
      fiber = alternate;
    }
    let component: string | undefined;
    let observed: ControlSourceObservation | undefined = stamped;
    const seen = new Set<object>();
    for (let depth = 0; object(fiber) && depth < 40; depth++) {
      if (seen.has(fiber)) throw LIMIT;
      seen.add(fiber);
      const type = read(fiber, "elementType") ?? read(fiber, "type");
      if (!component && object(type)) {
        const name = read(type, "displayName") ?? read(type, "name");
        component = sourceComponent(name);
      }
      if (!observed) {
        const debug = read(fiber, "_debugSource");
        if (object(debug)) {
          const file = sourceFile(read(debug, "fileName"), repoRoot);
          if (!file) observed = sourceUnavailable("unsafe-source");
          else {
            const column = read(debug, "columnNumber");
            try { observed = parseControlSourceObservation({ source: "sdk-reported", framework: "react", status: "captured", mechanism: "react-debug-source", scope: depth === 0 ? "control" : "ancestor", file, line: read(debug, "lineNumber"), ...(column === undefined || column === null ? {} : { column }) }); }
            catch { observed = sourceUnavailable("unsafe-source"); }
          }
        }
      }
      fiber = read(fiber, "return");
      if (fiber === null) break;
    }
    if (object(fiber)) throw LIMIT;
    return observed?.status === "captured" && component ? { ...observed, component } : observed ?? sourceUnavailable("source-unavailable");
  } catch (error) { return sourceUnavailable(error === LIMIT ? "probe-limit" : "probe-error"); }
}
