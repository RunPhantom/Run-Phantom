import { useCallback, useEffect, useRef, useState } from "react";
import { X, Loader2, AlertCircle, RotateCcw, ArrowRight } from "lucide-react";
import { RunDetail } from "./RunDetail";
import { RunComparison } from "./RunComparison";
import { useIsCompactWorkspace } from "../hooks/use-mobile";

interface ReplayViewProps {
  originalRunId: string;
  originalName?: string;
  replayRunId: string | null;
  error?: string | null;
  isRunning?: boolean;
  isCancelled?: boolean;
  initialCompare?: boolean;
  onCancel?: () => void;
  onReplay?: () => void;
}

export function ReplayView({ originalRunId, originalName, replayRunId, error, isRunning, isCancelled, initialCompare, onCancel, onReplay }: ReplayViewProps) {
  const isCompact = useIsCompactWorkspace();
  const [showOriginal, setShowOriginal] = useState(initialCompare ?? false);
  const [leftPct, setLeftPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setLeftPct(Math.min(Math.max(pct, 25), 75));
  }, []);

  const onPointerUp = useCallback(() => { dragging.current = false; }, []);

  useEffect(() => {
    if (isCompact) setShowOriginal(false);
  }, [isCompact]);

  const comparisonVisible = showOriginal && !isCompact;
  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setLeftPct((current) => {
      if (event.key === "Home") return 25;
      if (event.key === "End") return 75;
      return Math.min(75, Math.max(25, current + (event.key === "ArrowRight" ? 5 : -5)));
    });
  };

  return (
    <div ref={containerRef} className="h-full flex flex-col" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <div className="z-10 flex flex-shrink-0 border-b border-rp-line bg-rp-canvas-blue">
        <div
          className="flex min-w-0 items-center justify-between px-4 py-2"
          style={{ width: comparisonVisible ? `${leftPct}%` : "100%" }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <RotateCcw aria-hidden="true" className="size-3 flex-shrink-0 text-rp-blue" />
            <span className="truncate text-[12px] text-rp-ink-muted">
              replay of{" "}
              <button
                className="font-medium text-rp-ink underline-offset-4 transition-colors duration-250 ease-standard hover:text-rp-blue hover:underline"
                onClick={() => { if (!isCompact) setShowOriginal(!showOriginal); }}
              >
                {originalName ?? "run"}
              </button>
            </span>
            {!comparisonVisible && !isCompact && (
              <button
                className="flex h-7 flex-shrink-0 items-center gap-1 rounded-control border border-rp-line bg-white px-2 text-[12px] font-medium text-rp-ink transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash"
                onClick={() => setShowOriginal(true)}
              >
                compare <ArrowRight aria-hidden="true" className="size-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {isRunning && onCancel && (
              <button
                className="h-7 rounded-control border border-rp-line bg-white px-2 text-[12px] font-medium text-rp-danger transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-danger-border hover:bg-rp-danger-soft"
                onClick={onCancel}
              >
                cancel
              </button>
            )}
            {!isRunning && onReplay && (
              <button
                type="button"
                aria-label="Replay again"
                className="grid min-h-7 min-w-7 place-items-center rounded-control text-rp-ink-muted transition-colors duration-250 ease-standard hover:bg-white hover:text-rp-blue"
                title="Replay"
                onClick={onReplay}
              >
                <RotateCcw aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {comparisonVisible && (
          <>
            <div className="w-6 flex-shrink-0" />
            <div className="flex min-w-0 flex-1 items-center justify-between bg-rp-surface px-4 py-2">
              <span className="truncate text-[12px] text-rp-ink-muted">
                original — <span className="text-rp-ink">{originalName ?? "run"}</span>
              </span>
              <button
                type="button"
                aria-label="Close original run comparison"
                className="grid min-h-7 min-w-7 flex-shrink-0 place-items-center rounded-control text-rp-ink-muted transition-colors duration-250 ease-standard hover:bg-rp-row-hover hover:text-rp-ink"
                onClick={() => setShowOriginal(false)}
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          </>
        )}
      </div>

      {replayRunId && <RunComparison baselineRunId={originalRunId} candidateRunId={replayRunId} />}
      <div className="flex-1 flex min-h-0">
        <div className="min-w-0 overflow-auto sb" style={{ width: comparisonVisible ? `${leftPct}%` : "100%" }}>
          {replayRunId ? (
            <RunDetail runId={replayRunId} isReplay />
          ) : error ? (
            <div className="flex h-full items-center justify-center px-6">
              <div role="alert" className="rp-fade-rise flex max-w-sm flex-col items-center gap-2 rounded-lg border border-dashed border-rp-danger-border bg-rp-danger-soft px-6 py-8 text-center">
                <AlertCircle aria-hidden="true" className="size-5 text-rp-danger" />
                <span className="font-display text-[17px] font-semibold tracking-[-0.02em] text-rp-danger">Replay error</span>
                <span className="break-words font-mono text-[12px] text-rp-ink">{error}</span>
              </div>
            </div>
          ) : isCancelled ? (
            <div className="flex items-center justify-center h-full">
              <span role="status" className="rp-eyebrow">Stopped</span>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3">
                <Loader2 aria-hidden="true" className="size-5 animate-spin text-rp-blue motion-reduce:animate-none" />
                <span role="status" className="rp-eyebrow">Replaying agent…</span>
              </div>
            </div>
          )}
        </div>

        {comparisonVisible && (
          <>
            <div
              role="separator"
              aria-label="Resize replay comparison"
              aria-orientation="vertical"
              aria-valuemin={25}
              aria-valuemax={75}
              aria-valuenow={Math.round(leftPct)}
              tabIndex={0}
              className="relative w-6 flex-shrink-0 cursor-col-resize transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-rp-line hover:bg-rp-wash active:bg-rp-wash"
              onPointerDown={onPointerDown}
              onKeyDown={resizeWithKeyboard}
            />
            <div className="min-w-0 overflow-auto sb" style={{ flex: 1 }}>
              <RunDetail runId={originalRunId} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
