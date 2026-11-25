import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCompare, Download, FlaskConical, Trash2, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, useReturnFocus } from "@/components/ui/confirm-dialog";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { fieldClassName } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { deleteRun, type RunListRow } from "../api/runs";
import { evaluationsApi, type DatasetCaseDraft, type DatasetRevision } from "../api/evaluations";
import { plural, runDisplayName } from "../utils/helpers";
import { EVALUATION_LIMITS } from "../../../src/evaluations/protocol";
import { exportRowsJson } from "./table-model";

const MAX_CASES = EVALUATION_LIMITS.MAX_CASES;
/** Deletes in flight at once; a select-all over thousands of rows must not open thousands of requests. */
const DELETE_BATCH = 6;

export function RunsBulkBar({ rows, shortIds, onCompare, onClear, onDeleted, announce, returnFocus }: {
  rows: readonly RunListRow[];
  shortIds: ReadonlyMap<string, string>;
  onCompare: (baseline: string, candidate: string) => void;
  onClear: () => void;
  onDeleted: (ids: string[]) => void;
  announce: (message: string) => void;
  /** Focus target once the bar's own buttons are gone (the selection was cleared or deleted). */
  returnFocus: () => HTMLElement | null | undefined;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [datasetOpen, setDatasetOpen] = useState(false);
  const queryClient = useQueryClient();
  const count = rows.length;
  const canCompare = count === 2;

  const exportJson = () => {
    const now = Date.now();
    const blob = new Blob([exportRowsJson(rows, now)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `runphantom-runs-${new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce(`Exported ${plural(count, "run")} as JSON`);
  };

  const remove = async () => {
    const ids = rows.map(row => row.id);
    const deleted: string[] = [];
    for (let start = 0; start < ids.length; start += DELETE_BATCH) {
      const batch = ids.slice(start, start + DELETE_BATCH);
      const results = await Promise.allSettled(batch.map(id => deleteRun(id)));
      batch.forEach((id, index) => { if (results[index]!.status === "fulfilled") deleted.push(id); });
    }
    if (deleted.length) {
      const gone = new Set(deleted);
      queryClient.setQueriesData<{ id: string }[]>({ queryKey: ["runs"], exact: true }, list => list?.filter(run => !gone.has(run.id)));
      window.dispatchEvent(new CustomEvent("runphantom:run-removed", { detail: { runIds: deleted, ...(deleted.length === 1 ? { runId: deleted[0] } : {}) } }));
      onDeleted(deleted);
    }
    const failed = ids.length - deleted.length;
    if (failed > 0) throw new Error(`${plural(failed, "run")} could not be deleted. ${deleted.length ? `${plural(deleted.length, "run")} were deleted.` : ""}`.trim());
    announce(`Deleted ${plural(deleted.length, "run")}`);
  };

  const ordered = [...rows].sort((a, b) => a.started_at - b.started_at);

  return (
    <div role="region" aria-label="Selected runs" className="flex flex-wrap items-center gap-2 border-t border-rp-line bg-rp-canvas-blue px-4 py-2 sm:px-6">
      <span className="text-[13px] font-medium text-rp-ink" aria-live="polite">{plural(count, "run")} selected</span>
      <span aria-hidden="true" className="text-rp-ink-faint">·</span>
      <Button type="button" size="sm" variant="secondary" disabled={!canCompare}
        title={canCompare ? "Compare the older run (baseline) with the newer one" : "Select exactly 2 runs to compare"}
        onClick={() => onCompare(ordered[0]!.id, ordered[1]!.id)}>
        <GitCompare aria-hidden="true" />Compare
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={exportJson}><Download aria-hidden="true" />Export JSON</Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => setDatasetOpen(true)}><FlaskConical aria-hidden="true" />Add to test set</Button>
      <Button type="button" size="sm" variant="destructive-outline" onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden="true" />Delete</Button>
      <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
        <X aria-hidden="true" />Clear selection<kbd aria-hidden="true" className="rp-kbd ml-1">esc</kbd>
      </Button>
      {!canCompare && <span className="sr-only">Compare needs exactly 2 selected runs.</span>}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${plural(count, "run")}?`}
        description="Their steps, events and notes are removed from this machine. Saved copies stay in Saved."
        confirmLabel={`Delete ${plural(count, "run")}`}
        busyLabel="Deleting…"
        onConfirm={remove}
        returnFocus={returnFocus}
      >
        <ul className="mt-4 max-h-40 space-y-1 overflow-auto rounded-sm border border-rp-line bg-rp-canvas p-2 text-[13px]">
          {rows.slice(0, 20).map(row => (
            <li key={row.id} className="flex min-w-0 items-center gap-2">
              <span className="truncate text-rp-ink">{runDisplayName(row)}</span>
              <span className="shrink-0 font-mono text-[11px] text-rp-ink-subtle">{shortIds.get(row.id) ?? row.id}</span>
            </li>
          ))}
          {rows.length > 20 && <li className="text-rp-ink-subtle">and {rows.length - 20} more</li>}
        </ul>
      </ConfirmDialog>
      <AddToDatasetDialog open={datasetOpen} onOpenChange={setDatasetOpen} rows={rows} shortIds={shortIds} announce={announce} returnFocus={returnFocus} />
    </div>
  );
}

function toDraft(item: DatasetRevision["cases"][number]): DatasetCaseDraft {
  return { id: item.id, name: item.name, ...(item.input === null ? {} : { input: item.input }), ...(item.sourceRunId ? { sourceRunId: item.sourceRunId } : {}),
    ...(item.sourceSpanId ? { sourceSpanId: item.sourceSpanId } : {}), tags: item.tags, rules: item.rules };
}

function AddToDatasetDialog({ open, onOpenChange, rows, shortIds, announce, returnFocus }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: readonly RunListRow[];
  shortIds: ReadonlyMap<string, string>;
  announce: (message: string) => void;
  returnFocus: () => HTMLElement | null | undefined;
}) {
  const focus = useReturnFocus(returnFocus);
  const datasets = useQuery({ queryKey: ["evaluation-datasets"], queryFn: evaluationsApi.datasets, enabled: open });
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<string>("new");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const nameId = useId();
  useEffect(() => {
    if (!open) return;
    setError(null); setDone(null); setBusy(false);
    setName(`Runs ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
  }, [open]);
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (open) { setTouched(false); setTarget("new"); } }, [open]);
  useEffect(() => { if (open && !touched && datasets.data?.length) setTarget(datasets.data[0]!.id); }, [datasets.data, open, touched]);

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      let revision: DatasetRevision;
      if (target === "new") {
        if (!name.trim()) throw new Error("Name the new test set.");
        revision = await evaluationsApi.createDataset(name.trim());
      } else {
        revision = await evaluationsApi.revision(target);
      }
      const existing = new Set(revision.cases.map(item => item.sourceRunId).filter(Boolean));
      const fresh = rows.filter(row => !existing.has(row.id));
      if (revision.cases.length + fresh.length > MAX_CASES) {
        throw new Error(`A test set holds up to ${MAX_CASES} cases; ${revision.datasetName} has ${revision.cases.length}. Select fewer runs.`);
      }
      if (fresh.length > 0) {
        const cases = [...revision.cases.map(toDraft), ...fresh.map(row => ({
          name: `${runDisplayName(row)} ${shortIds.get(row.id) ?? row.id}`.slice(0, 200),
          sourceRunId: row.id,
          tags: [],
          rules: [{ kind: "errors" as const, max: 0 }],
        }))];
        await evaluationsApi.saveRevision(revision.datasetId, revision.version, cases);
      }
      void queryClient.invalidateQueries({ queryKey: ["evaluation-datasets"] });
      const skipped = rows.length - fresh.length;
      const message = `Added ${plural(fresh.length, "run")} to ${revision.datasetName}${skipped ? ` (${plural(skipped, "run")} already there)` : ""}`;
      setDone(message);
      announce(message);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "Could not add the runs.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
      <DialogContent title={`Add ${plural(rows.length, "run")} to a test set`} onOpenAutoFocus={focus.capture} onCloseAutoFocus={focus.restore}
        description="Each run becomes a test case that checks the run finishes with no errors. Add more checks in Evaluations.">
        {done ? (
          <>
            <p role="status" className="mt-4 text-[13px] text-rp-ink">{done}.</p>
            <DialogFooter>
              <Button asChild variant="secondary"><Link to="/evaluations" onClick={() => onOpenChange(false)}>Open Evaluations</Link></Button>
              <DialogClose asChild><Button type="button" variant="primary">Done</Button></DialogClose>
            </DialogFooter>
          </>
        ) : rows.length > MAX_CASES ? (
          <>
            <p role="alert" className="mt-4 text-[13px] text-rp-ink">A test set holds up to {MAX_CASES} cases. Select {MAX_CASES} runs or fewer.</p>
            <DialogFooter><DialogClose asChild><Button type="button" variant="secondary">Close</Button></DialogClose></DialogFooter>
          </>
        ) : (
          <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="rp-field-label">Test set</legend>
              {datasets.isLoading && <p className="text-[13px] text-rp-ink-subtle">Loading test sets…</p>}
              {datasets.isError && <p className="text-[13px] text-rp-danger">Existing test sets could not load. You can still create a new one.</p>}
              {datasets.data?.map(dataset => (
                <label key={dataset.id} className="flex cursor-pointer items-center gap-2 text-[13px] text-rp-ink">
                  <input type="radio" name="dataset" className="rp-checkbox" checked={target === dataset.id} onChange={() => { setTouched(true); setTarget(dataset.id); }} />
                  <span className="truncate">{dataset.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-rp-ink-subtle">{plural(dataset.caseCount, "case")}</span>
                </label>
              ))}
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-rp-ink">
                <input type="radio" name="dataset" className="rp-checkbox" checked={target === "new"} onChange={() => { setTouched(true); setTarget("new"); }} />
                New test set
              </label>
              {target === "new" && (
                <div className="pl-6">
                  <label htmlFor={nameId} className="sr-only">New test set name</label>
                  <input id={nameId} value={name} onChange={event => setName(event.target.value)} maxLength={200} className={cn(fieldClassName, "h-9 text-[13px]")} />
                </div>
              )}
            </fieldset>
            {error && <p role="alert" className="rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-[13px] text-rp-danger">{error}</p>}
            <DialogFooter>
              <DialogClose asChild><Button type="button" variant="secondary" disabled={busy}>Cancel</Button></DialogClose>
              <Button type="submit" variant="primary" loading={busy}>Add {plural(rows.length, "run")}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
