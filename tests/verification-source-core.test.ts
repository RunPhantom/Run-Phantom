import { describe, expect, test } from "bun:test";
import { parseControlSourceObservation, sourceFile, sanitizeControlSource } from "../src/verification/build/source";
import { identifyReactControl } from "../src/verification/browser/framework/react";

const captured = { source: "sdk-reported", framework: "react", status: "captured", mechanism: "dev-stamp", scope: "control", file: "src/Checkout.tsx", line: 12, column: 5 } as const;
const attrs = new WeakMap<object, string>();
class NativeElement {
  getAttribute(name: string) { return name === "data-runphantom-source" ? attrs.get(this) ?? null : null; }
}
function control(stamp?: string, fiber?: object) {
  const el = new NativeElement();
  Object.assign(el, { ownerDocument: { defaultView: { Element: NativeElement } } });
  if (stamp) attrs.set(el, stamp);
  if (fiber) Object.defineProperty(el, "__reactFiber$fixture", { value: fiber });
  return el as unknown as Element;
}
function committed(source: unknown) {
  function CheckoutButton() { throw new Error("Component must never execute"); }
  const root = { return: null, stateNode: {} as { current?: unknown } };
  root.stateNode.current = root;
  return { type: "button", return: { type: CheckoutButton, return: root }, _debugSource: source };
}

describe("source context is bounded and never a trusted path", () => {
  test("Windows source roots canonicalize with segment boundaries while POSIX retains case", () => {
    expect(sourceFile("C:\\Work\\App\\src\\Checkout.tsx", "c:\\work\\app")).toBe("src/Checkout.tsx");
    expect(sourceFile("/work/app/src/Checkout.tsx", "/work/app")).toBe("src/Checkout.tsx");
    expect(sourceFile("src\\Checkout.tsx")).toBe("src/Checkout.tsx");
    for (const [file, root] of [["/work/App/src/A.tsx", "/work/app"], ["/work/app-other/src/A.tsx", "/work/app"], ["/elsewhere/A.tsx", "/work/app"], ["/work/app/src/A.tsx", undefined]]) expect(sourceFile(file, root)).toBeNull();
    for (const path of ["../A.tsx", "src/../A.tsx", "./src/A.tsx", "src//A.tsx", "//host/A.tsx", "C:/src/A.tsx", "https://host/A.tsx", "src/%2e%2e/A.tsx", "src/A.tsx?token=x", "src/A.tsx#x", "src/A\0.tsx", "src/A\n.tsx", "src/" + "é".repeat(260) + ".tsx"]) expect(sourceFile(path)).toBeNull();
  });
  test("closed metadata rejects hidden fields, accessors, unsafe paths and noninteger locations", () => {
    expect(parseControlSourceObservation(captured)).toEqual(captured);
    expect(parseControlSourceObservation({ source: "sdk-reported", framework: "react", status: "unavailable", reason: "source-unavailable" })).toEqual({ source: "sdk-reported", framework: "react", status: "unavailable", reason: "source-unavailable" });
    let reads = 0;
    const accessor = { ...captured, get file() { reads++; return "src/A.tsx"; } };
    for (const bad of [accessor, { ...captured, props: {} }, { ...captured, line: 0 }, { ...captured, column: 0 }, { ...captured, line: 1.1 }, { ...captured, line: 2 ** 31 }, { ...captured, file: "/private/A.tsx" }, { ...captured, component: "a".repeat(129) }, { ...captured, source: "trusted" }, { source: "sdk-reported", framework: "react", status: "unavailable", reason: "unknown" }]) expect(() => parseControlSourceObservation(bad)).toThrow();
    expect(reads).toBe(0);
    const coercion = { toString() { reads++; return "dev-stamp"; } };
    expect(() => parseControlSourceObservation({ ...captured, mechanism: coercion })).toThrow(); expect(reads).toBe(0);
  });
  test("redaction never turns a withheld filename into a source pointer", () => {
    expect(sanitizeControlSource({ ...captured, file: "src/session-secret.tsx" }, value => value.replaceAll("session-secret", "[REDACTED]"))).toEqual({ source: "sdk-reported", framework: "react", status: "unavailable", reason: "redacted" });
    expect(sanitizeControlSource({ ...captured, component: "session-secret" }, value => value.replaceAll("session-secret", "[REDACTED]"))).toEqual(captured);
    expect(sanitizeControlSource({ ...captured, file: `src/sk-proj-${"A".repeat(32)}.tsx` })).toMatchObject({ status: "unavailable", reason: "redacted" });
  });
});

describe("React source probing is descriptor-only and fails soft", () => {
  test("own stamps use the actual realm intrinsic and do not read overridden instance methods", () => {
    const el = control("src/Checkout.tsx:12:5"); let invoked = 0;
    Object.defineProperty(el, "getAttribute", { get() { invoked++; throw new Error("Do not read target method"); } });
    expect(identifyReactControl(el)).toEqual(captured);
    expect(invoked).toBe(0);
    const plain = control(); Object.assign(plain, { closest() { throw new Error("No ancestor stamp search"); } });
    expect(identifyReactControl(plain)).toMatchObject({ status: "unavailable", reason: "not-react" });
  });
  test("committed React18 source is contained to consent root without reading private values", () => {
    const fiber = committed({ fileName: "/repo/src/Checkout.tsx", lineNumber: 12, columnNumber: 5 }); let invoked = 0;
    for (const key of ["memoizedState", "memoizedProps", "_debugOwner"]) Object.defineProperty(fiber, key, { get() { invoked++; throw new Error("Private data must not be read"); } });
    expect(identifyReactControl(control(undefined, fiber), "/repo")).toEqual({ ...captured, mechanism: "react-debug-source", component: "CheckoutButton" });
    expect(identifyReactControl(control(undefined, fiber))).toMatchObject({ status: "unavailable", reason: "unsafe-source" });
    expect(invoked).toBe(0);
  });
  test("missing/null/cyclic internals and throwing Proxy reflection cannot escape the probe", () => {
    expect(identifyReactControl(control(undefined, committed(null)))).toMatchObject({ status: "unavailable", reason: "source-unavailable" });
    let getters = 0;
    const fiber = committed(null); Object.defineProperty(fiber, "_debugSource", { get() { getters++; throw new Error("No accessor"); } });
    expect(identifyReactControl(control(undefined, fiber))).toMatchObject({ status: "unavailable" }); expect(getters).toBe(0);
    const cycle: { return?: unknown } = {}; cycle.return = cycle;
    expect(identifyReactControl(control(undefined, cycle))).toMatchObject({ status: "unavailable", reason: "probe-limit" });
    let traps = 0; const proxy = new Proxy({}, { getOwnPropertyDescriptor() { traps++; throw new Error("Caught proxy trap"); } });
    expect(identifyReactControl(control(undefined, proxy))).toMatchObject({ status: "unavailable", reason: "probe-error" }); expect(traps).toBeGreaterThan(0);
  });
  test("alternate ownership selects committed metadata and depth/key exhaustion is explicit", () => {
    const old = committed({ fileName: "/repo/src/Old.tsx", lineNumber: 2 });
    const current = committed({ fileName: "/repo/src/New.tsx", lineNumber: 7 });
    Object.assign(old, { alternate: current });
    old.return.return.stateNode.current = current.return.return;
    expect(identifyReactControl(control(undefined, old), "/repo")).toMatchObject({ file: "src/New.tsx", line: 7 });
    let chain: object = { return: null }; for (let i = 0; i < 45; i++) chain = { return: chain };
    expect(identifyReactControl(control(undefined, chain))).toMatchObject({ status: "unavailable", reason: "probe-limit" });
    const many = control(); for (let i = 0; i < 260; i++) Object.defineProperty(many, `field${i}`, { value: i });
    expect(identifyReactControl(many)).toMatchObject({ status: "unavailable", reason: "probe-limit" });
  });
});
