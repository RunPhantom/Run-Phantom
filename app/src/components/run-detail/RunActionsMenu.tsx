import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Download, FlaskConical, MoreHorizontal, Paperclip, Pencil, ShieldCheck, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { isRunDeleting, setRunDeleting, setRunDeletionError, useRunDeletionError, useRunDeletions } from "../../hooks/use-runs";
import { deleteRun } from "../../api/runs";
import { evidenceApi } from "../../api/evaluations";
import type { Run } from "../../utils/types";

export const HEADER_ACTION = cn(buttonVariants({ variant: "secondary", size: "sm" }), "gap-1.5 px-2.5 [&_svg]:size-3.5 md:h-7 [@media(pointer:coarse)]:min-w-11");

export function MoreMenu({ runId, onAnnotate, onDownload, triggerRef: externalTriggerRef }: {
  runId?: string;
  onAnnotate?: () => void;
  onDownload?: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const ownTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef ?? ownTriggerRef;
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const queryClient = useQueryClient();
  const deletingRuns = useRunDeletions();
  const deleteError = useRunDeletionError(runId);
  const deleting = !!runId && deletingRuns.has(runId);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const handlePointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, triggerRef]);

  const handleDelete = async () => {
    if (!runId || isRunDeleting(runId) || !confirm("Delete this run and all its spans?")) return;
    setRunDeletionError(runId, null);
    setRunDeleting(runId, true);
    let deleted = false;
    try {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["run-detail", runId], exact: true }),
        queryClient.cancelQueries({ queryKey: ["conversation-runs"] }),
      ]);
      await deleteRun(runId);
      deleted = true;
      // A conversation list response may still contain the removed run. Cancel
      // it before pruning, and never invalidate the deleted detail itself.
      await queryClient.cancelQueries({ queryKey: ["conversation-runs"] });
      queryClient.setQueriesData<Run[]>({ queryKey: ["conversation-runs"] },
        runs => runs?.filter(run => run.id !== runId));
      queryClient.setQueriesData<Run[]>({ queryKey: ["runs"], exact: true },
        runs => runs?.filter(run => run.id !== runId));
      flushSync(() => {
        window.dispatchEvent(new CustomEvent("runphantom:run-removed", { detail: { runId } }));
      });
      queryClient.removeQueries({ queryKey: ["run-detail", runId], exact: true });
    } catch (error) {
      setRunDeletionError(runId, error instanceof Error ? error.message : "Could not delete run");
    } finally {
      setRunDeleting(runId, false);
      // A canceled conversation may now belong to another selected run. Restart
      // active lists for either outcome, but never refetch a deleted detail.
      const resumed = [queryClient.invalidateQueries({ queryKey: ["conversation-runs"] })];
      if (!deleted) resumed.push(queryClient.invalidateQueries({ queryKey: ["run-detail", runId], exact: true }));
      await Promise.all(resumed);
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const item = "flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-13 text-rp-ink transition-colors duration-fast hover:bg-rp-row-hover focus-visible:bg-rp-row-hover focus-visible:outline-none [&_svg]:size-3.5 [&_svg]:text-rp-ink-subtle";
  const close = () => setOpen(false);

  return (
    <div ref={ref} className="relative">
      {deleteError && <p role="alert" className="text-xs text-rp-danger">{deleteError}</p>}
      <button
        ref={triggerRef}
        type="button"
        aria-label="More actions"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        title="More actions"
        className={cn(HEADER_ACTION, "w-8 justify-center px-0")}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open && (
        <div ref={menuRef} id={menuId} role="menu" aria-label="Run actions" onKeyDown={onMenuKeyDown} className="rp-pop absolute right-0 top-full z-50 mt-1 min-w-[200px] overflow-hidden rounded-md border border-rp-line bg-rp-surface p-1 shadow-e3">
          {onAnnotate && <button type="button" role="menuitem" className={item} onClick={() => { close(); onAnnotate(); }}><Pencil aria-hidden="true" />Annotate</button>}
          {onDownload && <button type="button" role="menuitem" className={item} onClick={() => { close(); onDownload(); }}><Download aria-hidden="true" />Download</button>}
          {runId && <Link role="menuitem" className={item} to={`/verification?runId=${encodeURIComponent(runId)}`} onClick={close}><ShieldCheck aria-hidden="true" />Verify app</Link>}
          {runId && <Link role="menuitem" className={item} to={`/evaluations?runId=${encodeURIComponent(runId)}`} onClick={close}><FlaskConical aria-hidden="true" />Evaluate run</Link>}
          {runId && <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => { close(); navigate(runEvidencePath(runId)); }}
          >
            <Paperclip aria-hidden="true" />
            Attach test report
          </button>}
          {(onAnnotate || onDownload || runId) && <div role="separator" className="my-1 h-px bg-rp-line-muted" />}
          <button
            type="button"
            role="menuitem"
            className={cn(item, "text-rp-danger hover:bg-rp-danger-soft focus-visible:bg-rp-danger-soft disabled:opacity-60 [&_svg]:text-rp-danger")}
            onClick={handleDelete}
            disabled={deleting}
          >
            <Trash2 aria-hidden="true" />
            {deleting ? "Deleting…" : "Delete run"}
          </button>
        </div>
      )}
    </div>
  );
}

const runEvidencePath = (runId: string) => `/evaluations?view=evidence&anchorKind=run&anchorId=${encodeURIComponent(runId)}`;

/** Links to imported test reports only when at least one is attached to this run. */
export function AttachedReportsLink({ runId }: { runId: string }) {
  // No abort signal: switching runs must not cancel this small read (the
  // refresh-ownership specs require that only superseded detail reads fail).
  const reports = useQuery({ queryKey: ["evidence", "run-reports", runId], retry: false, staleTime: 30_000,
    queryFn: () => evidenceApi.sets({ kind: "run", id: runId }) });
  const count = reports.data?.items.length ?? 0;
  if (!count) return null;
  return <div className="flex flex-shrink-0 bg-rp-surface px-4 pb-1 sm:px-5"><Link className="inline-flex min-h-7 items-center gap-1 text-[12px] font-medium text-rp-blue underline-offset-4 transition-colors duration-250 ease-standard hover:text-rp-blue-hover hover:underline" to={runEvidencePath(runId)}>Attached test reports ({count}{reports.data?.truncated ? "+" : ""})<ArrowUpRight aria-hidden="true" className="size-3" /></Link></div>;
}

