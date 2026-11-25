import { useEffect, useId, useMemo, useState, type RefObject } from "react";
import { Link, NavigationType, useNavigationType } from "react-router-dom";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { RunListItem } from "../components/RunList";
import { Button } from "@/components/ui/button";
import { useRunPhantomConnected } from "../hooks/use-runphantom-ws";
import { useScrollRestoration } from "../hooks/use-scroll-restoration";
import { useRegisterShortcuts } from "../shell/commands";
import { plural } from "../utils/helpers";
import { filtersFromSearchParams } from "../../../src/saved-views-protocol";
import type { RunListRow } from "../api/runs";
import { lastRunsSearch, runsTablePath } from "./last-search";
import { useRunsTable } from "./use-runs-table";

const COLLAPSED_KEY = "runphantom:runs-rail:collapsed";

function loadCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
}

export function useRailRows(paused: boolean) {
  const filters = useMemo(() => filtersFromSearchParams(new URLSearchParams(lastRunsSearch())), []);
  return { filters, data: useRunsTable(filters, paused) };
}

/**
 * The 280px run list beside an open run. It lists the runs of the table the reader came from (same filters), keeps
 * `[data-run-id]` unique on the page because the table is not rendered here, and collapses to a 40px strip.
 */
export function RunRail({ selectedId, shortRunIds, listRef, highlightedId, onSelect, rows, total, filtered, hasMore, loadingMore, loadMore, error, retry, onScrolled }: {
  selectedId: string;
  shortRunIds: ReadonlyMap<string, string>;
  listRef: RefObject<HTMLDivElement | null>;
  highlightedId: string | null;
  onSelect: (id: string) => void;
  rows: readonly RunListRow[];
  total: number | null;
  filtered: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  error: string | null;
  retry: () => void;
  onScrolled: (scrolled: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const wsConnected = useRunPhantomConnected();
  const navigationType = useNavigationType();
  const railId = useId();
  useScrollRestoration(listRef, "runs-list");

  const setRail = (next: boolean) => {
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch {}
  };
  useRegisterShortcuts([
    { id: "runs:toggle-rail", keys: "\\", scope: "Run detail", description: "Show or hide the run list", handler: () => setRail(!collapsed) },
  ], [collapsed]);

  useEffect(() => {
    // Not on Back/Forward (scroll restoration owns that) nor Replace (auto-selection): scrollIntoView moves the
    // sequential focus starting point into the list, so the first Tab would skip the skip link and the sidebar.
    if (navigationType === NavigationType.Pop || navigationType === NavigationType.Replace) return;
    const selected = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-run-id]") ?? []).find(el => el.dataset.runId === selectedId);
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedId, rows, navigationType, listRef]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const target = event.target as HTMLElement | null;
      const typing = target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable || target instanceof HTMLInputElement;
      if (typing || rows.length === 0 || !target || !listRef.current?.contains(target)) return;
      event.preventDefault();
      const current = rows.findIndex(run => run.id === selectedId);
      const next = event.key === "ArrowDown" ? Math.min(current + 1, rows.length - 1) : Math.max(current === -1 ? rows.length - 1 : current - 1, 0);
      const nextRun = rows[next];
      if (!nextRun || nextRun.id === selectedId) return;
      onSelect(nextRun.id);
      window.requestAnimationFrame(() => {
        const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-run-id]") ?? []).find(el => el.dataset.runId === nextRun.id);
        row?.querySelector<HTMLElement>("button")?.focus();
      });
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [listRef, onSelect, rows, selectedId]);

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-r border-rp-line bg-rp-surface pt-2">
        <button type="button" aria-expanded={false} aria-controls={railId} aria-label="Show run list" title="Show run list (\)"
          onClick={() => setRail(false)}
          className="flex size-8 items-center justify-center rounded-control text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-rp-blue">
          <PanelLeftOpen aria-hidden="true" className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <nav id={railId} aria-label="Run list" className="flex w-[280px] shrink-0 flex-col border-r border-rp-line bg-rp-surface">
      <div className="flex items-center justify-between gap-2 border-b border-rp-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div role="status" aria-live="polite" className="flex items-center gap-1.5">
            <span aria-hidden="true" title={wsConnected ? "Connected" : "Disconnected"} className={cn("size-1.5 rounded-full", wsConnected ? "bg-rp-mark-success" : "bg-rp-mark-danger")} />
            <span className={cn("rp-eyebrow", !wsConnected && "text-rp-danger")}>{wsConnected ? "connected" : "disconnected"}</span>
          </div>
          <Link to={runsTablePath()} className="truncate text-[12px] font-medium text-rp-blue underline-offset-4 hover:underline"
            title={filtered ? "Back to the filtered runs table" : "Back to the runs table"}>
            {total === null ? "All runs" : filtered ? `${plural(total, "matching run")}` : plural(total, "run")}
          </Link>
        </div>
        <button type="button" aria-expanded={true} aria-controls={railId} aria-label="Hide run list" title="Hide run list (\)"
          onClick={() => setRail(true)}
          className="flex size-7 shrink-0 items-center justify-center rounded-control text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-rp-blue">
          <PanelLeftClose aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div ref={listRef} className="sb flex-1 space-y-0.5 overflow-auto p-2"
        onScroll={event => {
          onScrolled(event.currentTarget.scrollTop > 8);
          const element = event.currentTarget;
          if (hasMore && !loadingMore && element.scrollTop + element.clientHeight > element.scrollHeight - 400) loadMore();
        }}>
        {error ? (
          <div role="alert" className="mx-1 mt-4 rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-3">
            <div className="text-[13px] font-medium text-rp-danger">Couldn&rsquo;t load runs</div>
            <div className="mt-1 break-words text-[12px] leading-5 text-rp-ink-muted">{error}</div>
            <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={retry}>Retry</Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="mx-1 mt-4 rounded-sm border border-dashed border-rp-line-dashed px-3 py-5 text-center text-[13px] text-rp-ink-muted">
            {filtered ? "No matching runs" : "No runs"}
          </div>
        ) : rows.map(run => (
          <RunListItem key={run.id} run={run} shortRunIds={shortRunIds}
            selected={run.id === selectedId}
            highlighted={run.id === highlightedId}
            faded={!!highlightedId && run.id !== highlightedId}
            onClick={() => onSelect(run.id)} />
        ))}
        {loadingMore && <p role="status" className="px-2 py-2 text-[12px] text-rp-ink-subtle">Loading more runs…</p>}
      </div>
    </nav>
  );
}
