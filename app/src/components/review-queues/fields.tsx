import type { ReactNode } from "react";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="flex min-w-0 flex-col gap-2"><span className="rp-field-label">{label}</span>{children}{hint && <span className="rp-field-hint">{hint}</span>}</label>;
}
