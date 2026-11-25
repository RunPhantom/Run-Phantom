import { useMemo } from "react";
import { Bookmark, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ago, runDisplayName, runStatus, runStatusTone, uniqueRunIdPrefixes } from "../utils/helpers";
import { useSavedEvent } from "../api/saved-runs";
import { parseReplayMetadata } from "../utils/types";
import type { Run } from "../utils/types";

/**
 * Short ids for a list of runs, unique within that list. Replay sources are
 * included because a replay row names its source run by the same short id.
 */
export function useShortRunIds(runs: readonly Run[] | undefined): ReadonlyMap<string, string> {
  return useMemo(() => {
    const ids: string[] = [];
    for (const run of runs ?? []) {
      ids.push(run.id);
      const sourceRunId = parseReplayMetadata(run)?.replay.sourceRunId;
      if (sourceRunId) ids.push(sourceRunId);
    }
    return uniqueRunIdPrefixes(ids);
  }, [runs]);
}

export function RunListItem({ run, shortRunIds, selected, highlighted, faded, onClick }: {
  run: Run;
  /** From `useShortRunIds` over the list this row belongs to. */
  shortRunIds: ReadonlyMap<string, string>;
  selected: boolean;
  highlighted?: boolean;
  faded?: boolean;
  onClick: () => void;
}) {
  const status = runStatus(run);
  const pulsing = status.status === "live";
  const saved = !!useSavedEvent(run.id);
  const replayMeta = parseReplayMetadata(run);
  const isReplay = !!replayMeta;

  const baseName = runDisplayName(run);
  const traceIdShort = shortRunIds.get(run.id) ?? run.id;

  const statusTone = { success: "text-rp-success", warning: "text-rp-warning", danger: "text-rp-danger", neutral: "text-rp-ink-muted" }[runStatusTone(status.status)];

  return (
    <div data-run-id={run.id} className="transition-opacity duration-250 ease-standard" style={{ opacity: faded ? 0.4 : 1 }}>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className={cn(
          "group/run w-full rounded-sm border px-3 py-2.5 text-left transition-[background-color,border-color,color] duration-250 ease-standard",
          selected
            ? "border-transparent bg-rp-wash"
            : highlighted
              ? "border-rp-wash-border bg-rp-wash"
              : "border-transparent hover:bg-rp-row-hover",
        )}
        onClick={onClick}>
        <div className="flex items-start gap-2">
          <span aria-hidden="true" className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", pulsing ? "pulse-dot bg-rp-success" : "bg-transparent")} />
          {/* The age sits last in the DOM so the row's accessible name reads
              name, status, id, age, while the grid places it on the title line. */}
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-1.5 overflow-hidden">
            <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-1.5">
              <span data-run-name className={cn("truncate text-[13px] font-medium leading-5", selected ? "text-rp-blue" : "text-rp-ink")}>
                {baseName}
              </span>
              {saved && <Bookmark aria-hidden="true" className="size-3 shrink-0 fill-rp-blue text-rp-blue" />}
            </div>
            <div className="col-span-2 row-start-2 mt-0.5 flex items-center gap-1.5 overflow-hidden text-[11px] leading-4">
              <span data-run-list-status={status.status} title={status.detail} className={cn("flex-shrink-0 font-medium", statusTone)}>
                {status.label}
              </span>
              {/* The id tells apart runs that share a name. It sits here rather
                  than in the title so a long agent name never has to give up
                  space for it. The age moved to the title line so a
                  "Completed · 2 tool errors" status still leaves the id room. */}
              <span aria-hidden="true" className="flex-shrink-0 text-rp-ink-faint">·</span>
              <span data-run-short-id className="rp-meta min-w-0 truncate text-[11px]" title={run.id}>{traceIdShort}</span>
            </div>
            {/* A sidebar row has no room for the replay source beside the
                status and id: on the meta line it wrapped over three lines
                and squeezed the short id to nothing. */}
            {isReplay && (
              <div className="col-span-2 row-start-3 mt-0.5 flex items-center gap-1 text-rp-ink-muted">
                <RotateCcw aria-hidden="true" className="size-2.5 shrink-0" />
                <span className="min-w-0 truncate text-[11px] leading-4" title={replayMeta!.replay.sourceRunId}>
                  replay of <span className="font-mono">{shortRunIds.get(replayMeta!.replay.sourceRunId) ?? replayMeta!.replay.sourceRunId}</span>
                </span>
              </div>
            )}
            <span data-run-age className="col-start-2 row-start-1 shrink-0 text-[11px] leading-5 text-rp-ink-muted">{ago(run.last_updated_at)}</span>
          </div>
        </div>
      </button>
    </div>
  );
}
