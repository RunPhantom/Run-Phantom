import type { ReactNode } from "react";

export { Select } from "../ui/input";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="flex min-w-0 flex-col gap-2"><span className="rp-field-label">{label}</span>{children}{hint && <span className="rp-field-hint">{hint}</span>}</label>;
}

/**
 * The visible reason a nearby button is disabled. Pass the same id to the button's
 * aria-describedby; nothing renders while the action is available.
 */
export function DisabledReason({ id, reason }: { id: string; reason: string | null | false | undefined }) {
  if (!reason) return null;
  return <p id={id} className="evaluation-hint" data-disabled-reason>{reason}</p>;
}
