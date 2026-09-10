import { useId, type ReactNode, type SelectHTMLAttributes } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { Predicate } from "../../api/verification";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="flex min-w-0 flex-col gap-1.5 text-xs text-[color:var(--rp-ink-soft)]"><span>{label}</span>{children}{hint && <span className="text-[11px] leading-relaxed text-[color:var(--rp-ink-muted)]">{hint}</span>}</label>;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`h-9 w-full min-w-0 rounded-md border border-[color:var(--rp-border)] bg-[color:var(--rp-surface)] px-2 text-xs text-[color:var(--rp-ink)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring disabled:opacity-50 ${props.className ?? ""}`} />;
}

export interface CheckDraft {
  kind: "element" | "network" | "console" | "signal" | "state";
  selector: string;
  elementState: "present" | "absent";
  url: string;
  method: string;
  status: string;
  level: "error" | "warn";
  absent: boolean;
  signal: string;
  store: string;
  path: string;
  valueType: "string" | "number" | "boolean" | "null" | "json";
  value: string;
}

export function emptyCheck(): CheckDraft {
  return { kind: "element", selector: "", elementState: "present", url: "", method: "", status: "200", level: "error", absent: true, signal: "", store: "", path: "", valueType: "string", value: "" };
}

export function buildPredicate(draft: CheckDraft): Predicate {
  const required = (value: string, label: string) => {
    if (!value.trim()) throw new Error(`${label} is required.`);
    return value.trim();
  };
  switch (draft.kind) {
    case "element": return { kind: "element", selector: required(draft.selector, "Element selector"), state: draft.elementState };
    case "network": {
      const status = draft.status.trim() ? Number(draft.status) : undefined;
      if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) throw new Error("Response status must be a whole number from 100 to 599.");
      return { kind: "network", urlContains: required(draft.url, "Request URL contains"), ...(draft.method ? { method: draft.method } : {}), ...(status === undefined ? {} : { status }) };
    }
    case "console": return { kind: "console", level: draft.level, absent: draft.absent };
    case "signal": return { kind: "signal", name: required(draft.signal, "Signal name") };
    case "state": {
      let equals: unknown = draft.value;
      if (draft.valueType === "null") equals = null;
      if (draft.valueType === "boolean") equals = draft.value === "true";
      if (draft.valueType === "number") {
        equals = Number(draft.value);
        if (!draft.value.trim() || !Number.isFinite(equals)) throw new Error("Expected value must be a finite number.");
      }
      if (draft.valueType === "json") {
        try { equals = JSON.parse(draft.value); } catch { throw new Error("Expected JSON value is invalid."); }
      }
      return { kind: "state", store: required(draft.store, "Registered store"), path: draft.path.trim(), equals };
    }
  }
}

export function describePredicate(predicate: Predicate): string {
  switch (predicate.kind) {
    case "element": return `${predicate.selector} is ${predicate.state}`;
    case "network": return `${predicate.method ?? "Any method"} ${predicate.urlContains}${predicate.status === undefined ? "" : ` returns ${predicate.status}`}`;
    case "console": return `${predicate.absent ? "No" : "Observed"} console ${predicate.level === "error" ? "errors" : "warnings"}`;
    case "signal": return `Signal “${predicate.name}” observed`;
    case "state": return `${predicate.store}${predicate.path ? `.${predicate.path}` : ""} equals expected ${predicate.equals === null ? "null" : typeof predicate.equals}`;
    case "allOf": return `All: ${predicate.predicates.map(describePredicate).join("; ")}`;
    case "anyOf": return `Any: ${predicate.predicates.map(describePredicate).join("; ")}`;
  }
}

export function PredicateEditor({ draft, onChange, index, onRemove }: { draft: CheckDraft; onChange: (draft: CheckDraft) => void; index: number; onRemove?: () => void }) {
  const id = useId();
  const change = <K extends keyof CheckDraft>(key: K, value: CheckDraft[K]) => onChange({ ...draft, [key]: value });
  return <fieldset aria-labelledby={id} className="space-y-3 border-t border-[color:var(--rp-border)] pt-4">
    <div className="flex items-center justify-between gap-3"><span id={id} className="text-xs font-semibold text-[color:var(--rp-ink)]">Expected outcome {index + 1}</span>{onRemove && <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove outcome ${index + 1}`}>Remove</Button>}</div>
    <Field label="Check type"><Select value={draft.kind} onChange={event => change("kind", event.target.value as CheckDraft["kind"])}><option value="element">Element</option><option value="network">Network response</option><option value="console">Console</option><option value="signal">Application signal</option><option value="state">Registered state</option></Select></Field>
    {draft.kind === "element" && <div className="grid gap-3 sm:grid-cols-2"><Field label="Element selector"><Input value={draft.selector} onChange={event => change("selector", event.target.value)} placeholder='[data-testid="confirmation"]' /></Field><Field label="Expected presence"><Select value={draft.elementState} onChange={event => change("elementState", event.target.value as CheckDraft["elementState"])}><option value="present">Present</option><option value="absent">Absent</option></Select></Field></div>}
    {draft.kind === "network" && <><Field label="Request URL contains"><Input value={draft.url} onChange={event => change("url", event.target.value)} placeholder="/api/checkout" /></Field><div className="grid gap-3 sm:grid-cols-2"><Field label="Request method"><Select value={draft.method} onChange={event => change("method", event.target.value)}><option value="">Any method</option>{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(method => <option key={method}>{method}</option>)}</Select></Field><Field label="Response status" hint="Leave blank to accept any response status."><Input type="number" min={100} max={599} value={draft.status} onChange={event => change("status", event.target.value)} /></Field></div></>}
    {draft.kind === "console" && <div className="grid gap-3 sm:grid-cols-2"><Field label="Console level"><Select value={draft.level} onChange={event => change("level", event.target.value as CheckDraft["level"])}><option value="error">Errors</option><option value="warn">Warnings</option></Select></Field><Field label="Expected console activity"><Select value={draft.absent ? "absent" : "present"} onChange={event => change("absent", event.target.value === "absent")}><option value="absent">None observed</option><option value="present">At least one observed</option></Select></Field></div>}
    {draft.kind === "signal" && <Field label="Signal name" hint="Emit this signal with the SDK handle in your app."><Input value={draft.signal} onChange={event => change("signal", event.target.value)} placeholder="checkout.complete" /></Field>}
    {draft.kind === "state" && <><div className="grid gap-3 sm:grid-cols-2"><Field label="Registered store"><Input value={draft.store} onChange={event => change("store", event.target.value)} placeholder="cart" /></Field><Field label="State path" hint="Dot-separated own properties; blank checks the full store."><Input value={draft.path} onChange={event => change("path", event.target.value)} placeholder="items.length" /></Field></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Expected value type"><Select value={draft.valueType} onChange={event => onChange({ ...draft, valueType: event.target.value as CheckDraft["valueType"], value: event.target.value === "boolean" ? "true" : "" })}><option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="null">Null</option><option value="json">JSON object or array</option></Select></Field>{draft.valueType === "boolean" ? <Field label="Expected value"><Select value={draft.value} onChange={event => change("value", event.target.value)}><option value="true">True</option><option value="false">False</option></Select></Field> : draft.valueType !== "null" && <Field label="Expected value"><Input type={draft.valueType === "number" ? "number" : "text"} autoComplete="off" value={draft.value} onChange={event => change("value", event.target.value)} /></Field>}</div></>}
  </fieldset>;
}
