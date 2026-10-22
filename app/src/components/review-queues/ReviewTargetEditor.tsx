import { Field, Select } from "../verification/PredicateEditor";
import { Input } from "../ui/input";
import type { ReviewDraft, ReviewField, ReviewSchema, ReviewScalar } from "./client";
export const reviewTextarea = "min-h-24 w-full rounded-md border border-[color:var(--rp-border)] bg-[color:var(--rp-surface)] p-3 text-sm text-[color:var(--rp-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-accent)] disabled:opacity-60";
export function ReviewTargetEditor({ schema, draft, disabled, onChange }: { schema: ReviewSchema; draft: ReviewDraft; disabled: boolean; onChange: (draft: ReviewDraft) => void }) {
  const target = (field: ReviewField, value?: ReviewScalar) => {
    const next = { ...draft.target }; if (value === undefined) delete next[field.key]; else next[field.key] = value;
    onChange({ ...draft, target: next });
  };
  return <fieldset disabled={disabled} className="space-y-4" aria-label="Structured review target">
    {schema.fields.map(field => <Field key={field.key} label={`${field.label}${field.required ? " (required)" : " (optional)"}`} hint={field.mapping.kind === "output" ? "Exact expected response text" : `Expected JSON value at ${field.mapping.path || "the root"}`}>
      {field.type === "string" ? <textarea className={reviewTextarea} maxLength={4096} value={typeof draft.target[field.key] === "string" ? draft.target[field.key] as string : ""} onChange={event => target(field, event.target.value)} />
        : field.type === "number" ? <Input type="number" step="any" min={field.minimum} max={field.maximum} value={typeof draft.target[field.key] === "number" ? draft.target[field.key] as number : ""} onChange={event => target(field, Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : undefined)} />
          : field.type === "boolean" ? <Select value={draft.target[field.key] === undefined ? "" : draft.target[field.key] ? "true" : "false"} onChange={event => target(field, event.target.value === "" ? undefined : event.target.value === "true")}><option value="">Choose a value</option><option value="true">True</option><option value="false">False</option></Select>
            : <Select value={draft.target[field.key] === undefined ? "" : String(field.choices!.findIndex(value => Object.is(value, draft.target[field.key])))} onChange={event => target(field, event.target.value === "" ? undefined : field.choices![Number(event.target.value)])}><option value="">Choose a value</option>{field.choices!.map((value, index) => <option key={index} value={index}>{String(value)}</option>)}</Select>}
    </Field>)}
  </fieldset>;
}
