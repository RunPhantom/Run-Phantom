import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TeachingEmptyState } from "../empty/TeachingEmptyState";
import { listPlaygroundHistory, recordedColumn, type PlaygroundHistoryRun } from "../../api/playground";
import type { RunSearchRun } from "../../api/runs";
import { groupHistory, orderByColumn, recordedCostUsd, type HistoryGroup } from "./playground-model";
import { fmtCost } from "../../utils/costs";
import { ago } from "../../utils/helpers";

export const PLAYGROUND_HISTORY_KEY = ["playground", "history"] as const;

/** The model the Playground asked for (the run name), not the dated id the provider answered with. */
function runModel(run: RunSearchRun): string {
  const requested = run.name?.startsWith("Playground: ") ? run.name.slice("Playground: ".length) : null;
  return requested || run.model || "Unknown model";
}

/** Compare runs start together, so their column order is read from each run's recorded target index. */
function useColumnOrder(group: HistoryGroup): PlaygroundHistoryRun[] {
  const compare = group.runs.length > 1;
  const order = useQuery({
    queryKey: ["playground", "history-order", ...group.runs.map(run => run.id)],
    queryFn: async ({ signal }) => new Map((await Promise.all(group.runs.map(run => recordedColumn(run.id, signal)))).map(column => [column.runId, column.index])),
    enabled: compare,
    staleTime: Infinity,
  });
  return compare && order.data ? orderByColumn(group.runs, order.data) : group.runs;
}

function HistoryRow({ group, loading, onLoad }: { group: HistoryGroup; loading: string | null; onLoad: (runs: RunSearchRun[]) => void }) {
  const runs = useColumnOrder(group);
  const failed = runs.filter(run => (run.error_count ?? 0) > 0).length;
  const costs = runs.map(run => run.est_cost_usd);
  const total = costs.every((cost): cost is number => typeof cost === "number") ? costs.reduce((sum, cost) => sum + cost, 0) : null;
  return (
    <li className="flex items-center gap-3 py-2.5" data-playground-history={group.key}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-rp-ink" data-playground-history-models>{runs.map(runModel).join(" · ")}</p>
        {runs[0]?.input_preview && <p className="mt-0.5 truncate text-[13px] text-rp-ink-soft" title={runs[0].input_preview}>{runs[0].input_preview}</p>}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-rp-ink-muted">
          <span>{ago(group.startedAt)}</span>
          <span aria-hidden="true">·</span>
          <span>{runs.length === 1 ? "1 model" : `${runs.length} models compared`}</span>
          {total !== null && <><span aria-hidden="true">·</span><span className="font-mono" title="Estimated from list prices, as in Runs">{fmtCost(recordedCostUsd(total))} est.</span></>}
          {failed > 0 && <><span aria-hidden="true">·</span><span className="text-rp-danger">{failed === 1 ? "1 call failed" : `${failed} calls failed`}</span></>}
          {runs.map(run => (
            <Link key={run.id} to={`/runs/${run.id}`} className="inline-flex items-center gap-0.5 font-mono text-rp-blue underline-offset-2 hover:underline" aria-label={`Open run ${run.id.slice(0, 8)} (${runModel(run)})`}>
              {run.id.slice(0, 6)}<ArrowUpRight aria-hidden="true" className="size-3" />
            </Link>
          ))}
        </p>
      </div>
      <Button variant="outline" size="sm" loading={loading === group.key} disabled={loading !== null} onClick={() => onLoad(runs)}>
        Load
      </Button>
    </li>
  );
}

/** Illustrative rows for the labelled ghost only. */
const GHOST_HISTORY = [
  { models: "GPT-5 nano · Claude Haiku 4.5", input: "Summarise this support ticket in one line", meta: "4m ago · 2 models compared · $0.0004 est." },
  { models: "Gemini 3.8 Flash", input: "Classify: refund, shipping or warranty?", meta: "1h ago · 1 model · $0.0001 est." },
];

function HistoryGhost() {
  return (
    <ul className="divide-y divide-rp-line-muted border-y border-rp-line-muted">
      {GHOST_HISTORY.map(row => (
        <li key={row.models} className="flex items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-13 font-medium text-rp-ink">{row.models}</p>
            <p className="mt-0.5 truncate text-13 text-rp-ink-soft">{row.input}</p>
            <p className="mt-0.5 text-12 text-rp-ink-muted">{row.meta}</p>
          </div>
          <span className="inline-flex h-8 items-center rounded-control border border-rp-line px-3 text-12">Load</span>
        </li>
      ))}
    </ul>
  );
}

export function PlaygroundHistory({ open, onOpenChange, onLoad, onStart }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoad: (runs: RunSearchRun[]) => Promise<void>;
  /** Called after the empty history closes, to put the cursor where a first prompt goes. */
  onStart?: () => void;
}) {
  const history = useQuery({ queryKey: PLAYGROUND_HISTORY_KEY, queryFn: ({ signal }) => listPlaygroundHistory(60, signal), enabled: open, staleTime: 0 });
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = history.data ? groupHistory(history.data) : [];
  const startAfterClose = useRef(false);

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) { setError(null); setLoading(null); } onOpenChange(value); }}>
      <DialogContent
        title="Recent Playground runs"
        description="Every Playground call is a recorded run. Load one to edit and run it again."
        className="max-w-2xl"
        onCloseAutoFocus={event => {
          if (!startAfterClose.current) return;
          startAfterClose.current = false;
          event.preventDefault();
          onStart?.();
        }}
      >
        {error && <p role="alert" className="mt-4 rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-[13px] text-rp-danger">{error}</p>}
        <div className="mt-4">
          {history.isPending && <p className="text-[13px] text-rp-ink-muted">Loading recent runs…</p>}
          {history.isError && <p role="alert" className="text-[13px] text-rp-danger">Recent runs could not be loaded: {history.error instanceof Error ? history.error.message : "unknown error"}.</p>}
          {history.isSuccess && groups.length === 0 && (
            <TeachingEmptyState
              size="inline"
              ghost={<HistoryGhost />}
              title="No Playground runs yet"
              titleId="playground-history-empty"
              titleAs="h3"
              lede="Each prompt you run is saved here with its model, cost and output, ready to load again."
              actions={<Button type="button" size="sm" className="h-11 [@media(pointer:fine)]:h-8" onClick={() => { startAfterClose.current = true; onOpenChange(false); }}>Write a prompt</Button>}
              data-playground-history-empty
            />
          )}
          {groups.length > 0 && (
            <ul className="divide-y divide-rp-line-muted border-y border-rp-line-muted" aria-label="Recent Playground runs">
              {groups.map(group => (
                <HistoryRow
                  key={group.key}
                  group={group}
                  loading={loading}
                  onLoad={runs => {
                    setLoading(group.key); setError(null);
                    onLoad(runs).then(() => onOpenChange(false)).catch((reason: unknown) => {
                      setError(reason instanceof Error ? reason.message : "This run could not be loaded.");
                    }).finally(() => setLoading(null));
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
