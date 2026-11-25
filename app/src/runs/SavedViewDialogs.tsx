import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { useReturnFocus } from "@/components/ui/confirm-dialog";
import { fieldClassName } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { RUNS_VIEW_LIMITS } from "../../../src/saved-views-protocol";

/** Name entry for saving or renaming a view; keeps the dialog open with the server's message on failure. */
export function ViewNameDialog({ open, onOpenChange, title, description, initialName, submitLabel, includeColumnsChoice, onSubmit, returnFocus }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  includeColumnsChoice?: boolean;
  onSubmit: (name: string, includeColumns: boolean) => Promise<void>;
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  const focus = useReturnFocus(returnFocus);
  const [name, setName] = useState(initialName);
  const [includeColumns, setIncludeColumns] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const errorId = useId();
  useEffect(() => { if (open) { setName(initialName); setIncludeColumns(true); setError(null); setBusy(false); } }, [initialName, open]);

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) { setError("Give the view a name."); return; }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim(), includeColumns);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "The view could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
      <DialogContent title={title} description={description} onOpenAutoFocus={focus.capture} onCloseAutoFocus={focus.restore}>
        <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <div>
            <label htmlFor={nameId} className="rp-field-label">View name</label>
            <input id={nameId} autoFocus value={name} maxLength={RUNS_VIEW_LIMITS.nameChars} disabled={busy}
              aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
              onChange={event => setName(event.target.value)} className={cn(fieldClassName, "mt-1.5 h-9 text-[13px]")} />
          </div>
          {includeColumnsChoice && (
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-rp-ink">
              <input type="checkbox" className="rp-checkbox" checked={includeColumns} disabled={busy} onChange={event => setIncludeColumns(event.target.checked)} />
              Also save the visible columns
            </label>
          )}
          {error && <p id={errorId} role="alert" className="rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-[13px] text-rp-danger">{error}</p>}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="secondary" disabled={busy}>Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" loading={busy}>{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
