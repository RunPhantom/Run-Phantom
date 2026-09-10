import { useLocation, useNavigate } from "react-router-dom";
import { Compass } from "lucide-react";
import { C } from "../utils/colors";

/**
 * Shown for a URL that matches no route.
 *
 * Unknown routes used to redirect straight to /runs, which then auto-selected a
 * trace — so a typo'd or stale link opened an unrelated run and looked like it
 * had worked. Naming the path that failed is the difference between "this link
 * is dead" and "this is the wrong trace and I cannot tell".
 */
export function NotFoundPage() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border border-[color:var(--rp-border)] bg-[color:var(--rp-ink-wash)]">
          <Compass className="h-5 w-5" style={{ color: C.fg1 }} />
        </div>
        <h1 className="text-[15px] font-medium" style={{ color: C.fg4 }}>Page not found</h1>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: C.fg1 }}>
          Nothing in Run Phantom matches this address.
        </p>
        <code
          className="mt-3 block truncate rounded-md border border-[color:var(--rp-border)] bg-[color:var(--rp-ink-wash)] px-2 py-1.5 text-[11px]"
          style={{ color: C.fg0 }}
        >
          {location.pathname}
        </code>
        <button
          type="button"
          className="rp-hover-wash mt-4 rounded-md border border-[color:var(--rp-border)] bg-[color:var(--rp-ink-wash)] px-3 py-1.5 text-xs font-medium text-[color:var(--rp-ink-strong)] transition-colors"
          onClick={() => navigate("/runs", { replace: true })}
        >
          Back to traces
        </button>
      </div>
    </div>
  );
}
