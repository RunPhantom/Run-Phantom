import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

type Labelled = ReactElement<{ id?: string; "aria-describedby"?: string }>;

/**
 * Labels its single form control with htmlFor/id rather than by nesting. A nested textarea's current value
 * becomes part of its own accessible name in Chromium, so "Reference input" stopped matching its label once filled.
 * The hint stays outside the label and is linked as the description. Pass htmlFor when the child wraps the control.
 */
export function Field({ label, children, hint, htmlFor }: { label: string; children: ReactNode; hint?: string; htmlFor?: string }) {
  const controlId = useId(), hintId = useId();
  if (htmlFor) return <div className="flex min-w-0 flex-col gap-2"><label className="rp-field-label" htmlFor={htmlFor}>{label}</label>{children}</div>;
  if (!isValidElement(children)) return <label className="flex min-w-0 flex-col gap-2"><span className="rp-field-label">{label}</span>{children}</label>;
  const control = cloneElement(children as Labelled, { id: (children as Labelled).props.id ?? controlId, ...(hint ? { "aria-describedby": hintId } : {}) });
  return <div className="flex min-w-0 flex-col gap-2">
    <label className="rp-field-label" htmlFor={(children as Labelled).props.id ?? controlId}>{label}</label>
    {control}
    {hint && <span id={hintId} className="rp-field-hint">{hint}</span>}
  </div>;
}
