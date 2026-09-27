import { useMemo } from "react";
import { Star, RotateCcw } from "lucide-react";
import { C } from "../utils/colors";
import { ago, isActive, runDisplayName, uniqueRunIdPrefixes } from "../utils/helpers";
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
  const active = isActive(run);
  const saved = !!useSavedEvent(run.id);
  const replayMeta = parseReplayMetadata(run);
  const isReplay = !!replayMeta;
  const statusLabel = active ? "Run live" : (run.error_count ?? 0) > 0 ? "Run failed" : "Run finished";

  const baseName = runDisplayName(run);
  const traceIdShort = shortRunIds.get(run.id) ?? run.id;

  return (
    <div data-run-id={run.id} style={{ opacity: faded ? 0.4 : 1, transition: "opacity 150ms" }}>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className="w-full rounded-lg p-2.5 text-left transition-[background-color,border-color] duration-150"
        style={{
          background: selected ? "var(--rp-ink-a08)" : highlighted ? "var(--rp-ink-a06)" : "transparent",
          border: selected ? "1px solid var(--rp-ink-a15)" : highlighted ? "1px solid var(--rp-ink-a10)" : "1px solid transparent",
        }}
        onMouseEnter={(e) => { if (!selected && !highlighted) e.currentTarget.style.background = "var(--rp-ink-a04)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "var(--rp-ink-a08)" : highlighted ? "var(--rp-ink-a06)" : "transparent"; }}
        onClick={onClick}>
        <div className="flex items-center gap-2">
          {active && <div className="size-2 rounded-full flex-shrink-0 pulse-dot" style={{ background: C.green }} />}
          {!active && <div className="size-2 flex-shrink-0" />}
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex items-center gap-1.5">
              <span data-run-name className="text-sm font-medium truncate" style={{ color: C.fg4, opacity: saved ? 1 : 0.9 }}>
                {baseName}
              </span>
              {saved && <span className="shrink-0 flex items-center justify-center size-5 rounded-full" style={{ background: "var(--rp-accent)" }}><Star className="size-3" style={{ color: "var(--rp-canvas)", fill: "var(--rp-canvas)" }} /></span>}
            </div>
            <div className="flex items-center gap-2 mt-0.5 overflow-hidden">
              <span className="text-[10px] flex-shrink-0 font-medium" style={{ color: active ? C.green : C.fg1 }}>
                {statusLabel}
              </span>
              {/* The id tells apart runs that share a name. It sits here rather
                  than in the title so a long agent name never has to give up
                  space for it, and it follows the status so the row button's
                  accessible name reads name, status, id. */}
              <span aria-hidden="true" className="text-[10px] flex-shrink-0" style={{ color: C.fg0 }}>·</span>
              <span data-run-short-id className="min-w-0 truncate text-[10px] font-mono" style={{ color: C.fg0 }} title={run.id}>{traceIdShort}</span>
              <span aria-hidden="true" className="text-[10px] flex-shrink-0" style={{ color: C.fg0 }}>·</span>
              {isReplay && (
                <>
                  <RotateCcw className="size-2.5 shrink-0" style={{ color: C.fg0 }} />
                  <span className="text-[11px]" style={{ color: C.fg0, marginLeft: -4, marginTop: -1 }}>replay of {shortRunIds.get(replayMeta!.replay.sourceRunId) ?? replayMeta!.replay.sourceRunId}</span>
                  <span aria-hidden="true" className="text-[10px] flex-shrink-0" style={{ color: C.fg0 }}>·</span>
                </>
              )}
              <span className="text-[10px] flex-shrink-0" style={{ color: C.fg0 }}>{ago(run.last_updated_at)}</span>
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}
