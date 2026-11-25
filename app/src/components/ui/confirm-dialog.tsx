import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";

/**
 * Accessible replacement for window.confirm(): an alertdialog whose initial focus is the safe choice, that stays
 * open with the error when the action fails, and that cannot be dismissed mid-request.
 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, busyLabel, tone = "danger", onConfirm, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  tone?: "danger" | "primary";
  onConfirm: () => Promise<void> | void;
  children?: ReactNode;
}) {
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
        onOpenAutoFocus={event => { event.preventDefault(); cancelRef.current?.focus(); }}
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
