import { useMemo } from "react";
import { Bookmark, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ago, runDisplayName, runStatus, uniqueRunIdPrefixes } from "../utils/helpers";
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
  const status = runStatus(run, run.error_count ?? 0);
  const active = status === "live";
  const saved = !!useSavedEvent(run.id);
  const replayMeta = parseReplayMetadata(run);
  const isReplay = !!replayMeta;
  const statusLabel = run.capture_completion === "unavailable" ? "Completion unavailable" : { live: "Run live", failed: "Run failed", cancelled: "Run cancelled", complete: "Run complete" }[status];

  const baseName = runDisplayName(run);
  const traceIdShort = shortRunIds.get(run.id) ?? run.id;

  const statusTone = active ? "text-rp-success" : status === "failed" ? "text-rp-danger" : "text-rp-ink-muted";

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
          <span aria-hidden="true" className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", active ? "pulse-dot bg-rp-success" : "bg-transparent")} />
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex items-center gap-1.5">
              <span data-run-name className={cn("truncate text-[13px] font-medium leading-5", selected ? "text-rp-blue" : "text-rp-ink")}>
                {baseName}
              </span>
              {saved && <Bookmark aria-hidden="true" className="size-3 shrink-0 fill-rp-blue text-rp-blue" />}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 overflow-hidden text-[11px] leading-4">
              <span className={cn("flex-shrink-0 font-medium", statusTone)}>
                {statusLabel}
              </span>
              {/* The id tells apart runs that share a name. It sits here rather
                  than in the title so a long agent name never has to give up
                  space for it, and it follows the status so the row button's
                  accessible name reads name, status, id. */}
              <span aria-hidden="true" className="flex-shrink-0 text-rp-ink-faint">·</span>
              <span data-run-short-id className="rp-meta min-w-0 truncate text-[11px]" title={run.id}>{traceIdShort}</span>
              <span aria-hidden="true" className="flex-shrink-0 text-rp-ink-faint">·</span>
              <span className="flex-shrink-0 text-rp-ink-muted">{ago(run.last_updated_at)}</span>
            </div>
            {/* A sidebar row has no room for the replay source beside the
                status, id and age: on the meta line it wrapped over three lines
                and squeezed the short id to nothing. */}
            {isReplay && (
              <div className="mt-0.5 flex items-center gap-1 text-rp-ink-muted">
                <RotateCcw aria-hidden="true" className="size-2.5 shrink-0" />
                <span className="min-w-0 truncate text-[11px] leading-4" title={replayMeta!.replay.sourceRunId}>
                  replay of <span className="font-mono">{shortRunIds.get(replayMeta!.replay.sourceRunId) ?? replayMeta!.replay.sourceRunId}</span>
                </span>
              </div>
            )}
          </div>
        </div>
      </button>
    </div>
  );
}
