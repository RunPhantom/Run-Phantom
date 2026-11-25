import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";

function canFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  return !!element && element.isConnected && !element.matches(":disabled") && element.getClientRects().length > 0;
}

/**
 * Focus return for dialogs opened without a Radix Trigger. Radix sends focus back to its trigger ref, which is empty
 * for a controlled dialog, so focus fell to <body>. `capture` belongs in onOpenAutoFocus (it runs before focus moves
 * into the dialog) and `restore` in onCloseAutoFocus; when the opener is gone or disabled, `fallback` decides.
 */
export function useReturnFocus(fallback?: () => HTMLElement | null | undefined) {
  const opener = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  return useMemo(() => ({
    capture: () => {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    },
    restore: (event: Event) => {
      event.preventDefault();
      const target = canFocus(opener.current) ? opener.current : fallbackRef.current?.();
      opener.current = null;
      if (canFocus(target)) target.focus({ preventScroll: true });
    },
  }), []);
}

/**
 * Accessible replacement for window.confirm(): an alertdialog whose initial focus is the safe choice, that stays
 * open with the error when the action fails, and that cannot be dismissed mid-request.
 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, busyLabel, tone = "danger", onConfirm, returnFocus, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  tone?: "danger" | "primary";
  onConfirm: () => Promise<void> | void;
  /** Where focus goes on close when the element that opened the dialog is gone or disabled. */
  returnFocus?: () => HTMLElement | null | undefined;
  children?: ReactNode;
}) {
  const focus = useReturnFocus(returnFocus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (open) { setError(null); setBusy(false); } }, [open]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
      <DialogContent
        role="alertdialog"
        title={title}
        description={description}
        hideClose
        onOpenAutoFocus={event => { focus.capture(); event.preventDefault(); cancelRef.current?.focus(); }}
        onCloseAutoFocus={focus.restore}
      >
        {children}
        {error && <p role="alert" className="mt-4 rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-[13px] text-rp-danger">{error}</p>}
        <DialogFooter>
          <DialogClose asChild>
            <Button ref={cancelRef} type="button" variant="secondary" disabled={busy}>Cancel</Button>
          </DialogClose>
          <Button type="button" variant={tone === "danger" ? "destructive" : "primary"} loading={busy} onClick={() => { void confirm(); }}>
            {busy && busyLabel ? busyLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
