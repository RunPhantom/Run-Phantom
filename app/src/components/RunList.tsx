import { Star, RotateCcw } from "lucide-react";
import { C } from "../utils/colors";
import { ago, isActive, runDisplayName } from "../utils/helpers";
import { useSavedEvent } from "../api/saved-runs";
import { parseReplayMetadata } from "../utils/types";
import type { Run } from "../utils/types";

export function RunListItem({ run, selected, highlighted, faded, onClick }: {
  run: Run;
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

  const baseName = runDisplayName(run, 5);
  const traceIdShort = run.id.slice(0, 5);
  const displayTitle = `${baseName} (${traceIdShort})`;

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
              <span className="text-sm font-medium truncate" style={{ color: C.fg4, opacity: saved ? 1 : 0.9 }}>
                {displayTitle}
              </span>
              {saved && <span className="shrink-0 flex items-center justify-center size-5 rounded-full" style={{ background: "var(--rp-accent)" }}><Star className="size-3" style={{ color: "var(--rp-canvas)", fill: "var(--rp-canvas)" }} /></span>}
            </div>
            <div className="flex items-center gap-2 mt-0.5 overflow-hidden">
              <span className="text-[10px] flex-shrink-0 font-medium" style={{ color: active ? C.green : C.fg1 }}>
                {statusLabel}
              </span>
              {isReplay && (
                <>
                  <RotateCcw className="size-2.5 shrink-0" style={{ color: C.fg0 }} />
                  <span className="text-[11px]" style={{ color: C.fg0, marginLeft: -4, marginTop: -1 }}>replay of {replayMeta!.replay.sourceRunId.slice(0, 5)}</span>
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
