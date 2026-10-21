import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Select } from "./PredicateEditor";
import { verificationApi, type AppCommand } from "../../api/verification";
import { SEMANTIC_REF_PATTERN, type SemanticQuery, type SemanticResult } from "../../../../src/verification/protocol";
import { C } from "../../utils/colors";

function discovery(value: unknown): SemanticResult {
  if (!value || typeof value !== "object") throw new Error("The app returned no semantic discovery result.");
  const result = value as Partial<SemanticResult>;
  const whole = (item: unknown, maximum: number) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= maximum;
  const coverage = result.coverage;
  if (result.source !== "sdk-reported" || result.nameModel !== "partial-aria" || !/^[0-9a-f]{32}$/.test(result.documentGeneration ?? "")
    || !whole(result.count, 10_000) || typeof result.countExact !== "boolean" || !Array.isArray(result.elements) || result.elements.length > 100
    || !result.elements.every(item => item && typeof item === "object" && [item.tag, item.role, item.name, item.label, item.testId].every(text => typeof text === "string" && text.length <= 240)
      && typeof item.disabled === "boolean" && typeof item.readonly === "boolean" && whole(item.depth, 64) && (item.ref === undefined || typeof item.ref === "string" && SEMANTIC_REF_PATTERN.test(item.ref)))
    || !coverage || typeof coverage !== "object" || coverage.scope !== "visible-observable-dom" || coverage.closedShadowRoots !== "unobservable"
    || typeof coverage.complete !== "boolean" || typeof coverage.truncated !== "boolean" || !whole(coverage.visitedNodes, 10_000)
    || ![coverage.openShadowRoots, coverage.sameOriginFrames, coverage.inaccessibleFrames, coverage.hiddenSubtrees, coverage.privateSubtrees].every(item => whole(item, 10_000))
    || !Array.isArray(coverage.reasons) || coverage.reasons.length > 16 || !coverage.reasons.every(reason => typeof reason === "string" && reason.length <= 128)
    || result.status !== undefined && !["unique", "ambiguous", "not-found", "inconclusive"].includes(result.status)
    || result.ref !== undefined && (!SEMANTIC_REF_PATTERN.test(result.ref) || result.status !== "unique" || result.count !== 1 || !coverage.complete || result.elements[0]?.ref !== result.ref)) {
    throw new Error("The app returned an unsupported semantic discovery result.");
  }
  return result as SemanticResult;
}

export function SemanticInspector({ sessionId, connected, capable, disabled = false, onAction }: {
  sessionId: string; connected: boolean; capable: boolean; disabled?: boolean; onAction: (cursor: number) => void;
}) {
  const [kind, setKind] = useState<SemanticQuery["kind"]>("role");
  const [role, setRole] = useState("button");
  const [term, setTerm] = useState("");
  const [exact, setExact] = useState(true);
  const [result, setResult] = useState<SemanticResult | null>(null);
  const [selected, setSelected] = useState("");
  const [fill, setFill] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const running = useRef(false);
  useEffect(() => () => { sequence.current++; running.current = false; }, []);
  const scope = `${sessionId}:${connected}:${capable}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    sequence.current++; running.current = false; setResult(null); setSelected(""); setFill(""); setNotice(""); setError(""); setBusy(false);
  }, [scope]);
  const unavailable = !connected || !capable;
  async function execute(command: AppCommand) {
    if (running.current || disabled || unavailable) return;
    running.current = true;
    const ownedScope = currentScope.current;
    const ticket = ++sequence.current;
    const current = () => currentScope.current === ownedScope && sequence.current === ticket;
    setBusy(true); setError(""); setNotice(""); setFill("");
    if (command.type === "find" || command.type === "semantic-snapshot") { setSelected(""); setResult(null); }
    try {
      const response = await verificationApi.command(sessionId, command);
      if (!current()) return;
      if (!response.ok) throw new Error(response.error ?? "The app refused this command.");
      if (command.type === "find" || command.type === "semantic-snapshot") {
        const output = discovery(response.result);
        setResult(output);
        if (!response.truncated && output.coverage.complete && output.status === "unique" && output.ref && SEMANTIC_REF_PATTERN.test(output.ref)) setSelected(output.ref);
        setNotice(output.status === "ambiguous" ? "Multiple matches. Use a more precise query before acting." : output.status === "not-found" ? "No match in the visible observable scope." : "Discovery complete. Review the observed scope before acting.");
      } else {
        setSelected(""); setResult(null);
        onAction(response.cursor);
        setNotice("App acknowledged the action. Check its outcome next.");
      }
    } catch (cause) { if (current()) { setSelected(""); setError(cause instanceof Error ? cause.message : "Semantic command failed."); } }
    finally { if (current()) { running.current = false; setBusy(false); } }
  }
  function query(): SemanticQuery {
    if (kind === "role") return { kind, role, ...(term.trim() ? { name: term } : {}), exact };
    if (kind === "name") return { kind, name: term, exact };
    if (kind === "label") return { kind, label: term, exact };
    return { kind, testId: term };
  }
  const chosen = result?.elements.find(item => item.ref === selected);
  return <section aria-labelledby="semantic-heading" className="space-y-4 rounded-md border p-4" style={{ borderColor: C.border, background: C.surface }}>
    <h2 id="semantic-heading" className="text-sm font-semibold" style={{ color: C.fg3 }}>Find a live element</h2>
    <p className="text-xs leading-relaxed" style={{ color: C.fg1 }}>Search visible labels and roles, then act on the exact element found. Handles expire after 60 seconds and disappear on reconnect. Names use a partial ARIA approximation; observations are SDK-reported.</p>
    {unavailable && <p role="status" className="text-xs" style={{ color: C.orange }}>{connected ? "This runtime has no semantic reference capability. Reconnect with the current SDK." : "Connect an app to discover live elements."}</p>}
    <fieldset disabled={busy || disabled || unavailable} className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <div className="min-w-32 flex-1"><Field label="Find by"><Select value={kind} onChange={event => { setKind(event.target.value as SemanticQuery["kind"]); setSelected(""); setResult(null); }}><option value="role">Role and name</option><option value="name">Name</option><option value="label">Label</option><option value="test-id">Test id</option></Select></Field></div>
        {kind === "role" && <div className="min-w-32 flex-1"><Field label="Element role"><Input value={role} maxLength={64} onChange={event => setRole(event.target.value)} /></Field></div>}
        <div className="min-w-40 flex-[2]"><Field label={kind === "test-id" ? "Element test id" : kind === "label" ? "Element label" : "Element name"} hint={kind === "role" ? "Optional: narrow the role by its visible name." : "Literal text; Unicode and whitespace are normalized."}><Input value={term} maxLength={256} onChange={event => setTerm(event.target.value)} /></Field></div>
      </div>
      {kind !== "test-id" && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={exact} onChange={event => setExact(event.target.checked)} />Exact text match</label>}
      <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => void execute({ type: "find", query: query() })} disabled={kind !== "role" && !term.trim()}>Find element</Button><Button size="sm" variant="outline" onClick={() => void execute({ type: "semantic-snapshot" })}>Inspect visible elements</Button></div>
    </fieldset>
    <div role="status" aria-live="polite" className="text-xs" style={{ color: C.fg1 }}>{busy ? "Reading the connected app…" : notice}</div>
    {error && <p role="alert" className="break-words text-xs" style={{ color: C.red }}>{error}</p>}
    {result && <div aria-label="Semantic discovery" className="space-y-3 text-xs">
      <p>{result.countExact ? "Observed" : "At least"} {result.count} matches · {result.source} · partial ARIA names</p>
      <p style={{ color: result.coverage.complete ? C.fg1 : C.orange }}>{result.coverage.complete ? "Complete within the visible observable scope." : `Partial coverage: ${result.coverage.reasons.join(", ")}. No unique selection is established.`} Closed shadow roots are unobservable. Open shadow roots: {result.coverage.openShadowRoots}; same-origin frames: {result.coverage.sameOriginFrames}; inaccessible frames: {result.coverage.inaccessibleFrames}.</p>
      {result.query && <p aria-label="Normalized semantic query">Normalized query: {JSON.stringify(result.query)}</p>}
      <ul className="max-h-64 space-y-2 overflow-auto">{result.elements.slice(0, 100).map((item, index) => <li key={item.ref ?? index} className="flex items-start justify-between gap-3">
        <span className="min-w-0 break-words">{item.role || item.tag} · {item.name || item.testId || "Unnamed element"}{item.disabled ? " (disabled)" : ""}{item.readonly ? " (readonly)" : ""}</span>
        {!result.query && result.coverage.complete && item.ref && SEMANTIC_REF_PATTERN.test(item.ref) && <Button size="sm" variant="ghost" disabled={busy || disabled || unavailable || item.disabled || item.truncated} onClick={() => setSelected(item.ref!)} aria-label={`Choose ${item.name || item.testId || item.tag}`}>Choose</Button>}
      </li>)}</ul>
    </div>}
    {chosen && <fieldset disabled={busy || disabled || unavailable} className="space-y-3 border-t pt-3" style={{ borderColor: C.border }}>
      <p className="text-xs">Selected: {chosen.name || chosen.testId || chosen.role}</p>
      <Button size="sm" variant="outline" disabled={chosen.disabled || chosen.readonly} onClick={() => void execute({ type: "ref-click", ref: selected })}>Click selected element</Button>
      <Field label="Live element fill value" hint="Sent once, cleared immediately and excluded from saved flows."><Input type="password" autoComplete="new-password" value={fill} onChange={event => setFill(event.target.value)} /></Field>
      <Button size="sm" variant="outline" disabled={chosen.disabled || chosen.readonly} onClick={() => void execute({ type: "ref-fill", ref: selected, value: fill })}>Fill selected element</Button>
    </fieldset>}
  </section>;
}
