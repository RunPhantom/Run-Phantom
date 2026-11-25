import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

/** The hint sits outside the label so a control's accessible name is the label alone; the hint becomes its description. */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const hintId = useId();
  const control = hint && isValidElement(children) ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, { "aria-describedby": hintId }) : children;
  return <div className="flex min-w-0 flex-col gap-2">
    <label className="flex min-w-0 flex-col gap-2"><span className="rp-field-label">{label}</span>{control}</label>
    {hint && <span id={hintId} className="rp-field-hint">{hint}</span>}
  </div>;
}
