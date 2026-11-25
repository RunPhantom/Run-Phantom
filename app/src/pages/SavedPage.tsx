import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Download, Loader2, Trash2, FolderPlus, Folder, Check, Search, X, SlidersHorizontal, MessageSquareText } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { SavePopover } from "../components/SavePopover";
import { SavedRunSummary } from "../components/SavedRunSummary";
import { RunDetail, TraceNotFound } from "../components/RunDetail";
import {
  addFolder,
  annotationKindLabel,
  getFolderColor,
  getFolders,
  getSavedAnnotationPreview,
  getSavedEvents,
  removeFolder,
  savedSummarySource,
  mapLimited,
  removeSavedEvent,
  removeSavedEvents,
  SAVED_RUNS_REFRESH_EVENT,
  type SavedAnnotationPreview,
  type SavedEvent,
  updateSavedEvent,
} from "../api/saved-runs";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import type { RunListRow } from "../api/runs";
import { useRuns } from "../hooks/use-runs";
import { useRunPhantomEvent } from "../hooks/use-runphantom-ws";
import { STATUS_DOT } from "../runs/RunsTable";
import { costCell, modelCell } from "../runs/table-model";
import { Button } from "@/components/ui/button";
import { EmptyPanel } from "@/components/ui/empty-panel";
import { fieldClassName, Select } from "@/components/ui/input";
import { Eyebrow } from "@/components/ui/typography";
import { useScrollRestoration } from "../hooks/use-scroll-restoration";
import { tracePath } from "../utils/navigation";
import { useIsMobile } from "../hooks/use-mobile";
import { ago, plural, runDisplayName, runStatus, runStatusTone, safeDecodeParam } from "../utils/helpers";

const FILTERS_KEY = "runphantom:saved-runs:filters:v1";

export interface SavedFilters {
  search: string;
  folder: string | null;     // null = all, "" = unfiled
  agent: string;             // "" = all
  status: "all" | "problems" | "clean" | "missing";
}

const DEFAULT_FILTERS: SavedFilters = {
  search: "",
  folder: null,
  agent: "",
  status: "all",
};

function loadFilters(): SavedFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw);
    return {
      search: typeof parsed.search === "string" ? parsed.search : "",
      folder: parsed.folder === null || typeof parsed.folder === "string" ? parsed.folder : null,
      agent: typeof parsed.agent === "string" ? parsed.agent : "",
      status: ["problems", "clean", "missing"].includes(parsed.status) ? parsed.status : "all",
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function useFilters() {
  const [filters, setFilters] = useState<SavedFilters>(loadFilters);
  useEffect(() => {
    try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch {
      // localStorage may be disabled (private browsing); filters just won't persist.
    }
  }, [filters]);
  const update = useCallback((patch: Partial<SavedFilters>) => {
    setFilters(prev => ({ ...prev, ...patch }));
  }, []);
  const reset = useCallback(() => setFilters(DEFAULT_FILTERS), []);
  const resetSecondary = useCallback(() => setFilters(prev => ({ ...prev, agent: "", status: "all" })), []);
  return { filters, update, reset, resetSecondary };
}

function FolderPills({ folders, selected, onSelect, onCreate, onDelete }: {
  folders: string[];
  selected: string | null;
  onSelect: (folder: string | null) => void;
  onCreate: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmDelete) return;
    const t = window.setTimeout(() => setConfirmDelete(null), 2500);
    return () => window.clearTimeout(t);
  }, [confirmDelete]);

  const submitNew = () => {
    const trimmed = newName.trim();
    if (!trimmed) { setShowNew(false); return; }
    onCreate(trimmed);
    setNewName("");
    setShowNew(false);
  };

  const pill = (active: boolean) => `rp-ease flex h-7 shrink-0 items-center gap-1.5 rounded-sm border px-2 text-xs font-medium ${active ? "border-rp-wash-border bg-rp-wash text-rp-blue" : "border-transparent text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink"}`;

  return (
    <div
      className="flex items-center gap-1 overflow-x-auto sb"
      style={{ scrollbarWidth: "none" }}
      onWheel={(e) => {
        if (e.deltaY !== 0 && e.deltaX === 0) {
          e.currentTarget.scrollLeft += e.deltaY;
        }
      }}
      data-testid="folder-pills"
    >
      <button
        type="button"
        aria-pressed={selected === null}
        className={pill(selected === null)}
        onClick={() => onSelect(null)}
      >All</button>
      {folders.map(f => {
        const fc = getFolderColor(f);
        const isActive = selected === f;
        const isConfirming = confirmDelete === f;
        return (
          <div key={f} className="relative flex shrink-0 items-center">
            <button
              type="button"
              aria-pressed={isActive}
              className={pill(isActive)}
              onClick={() => onSelect(isActive ? null : f)}
            >
              <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: fc }} />
              {f}
            </button>
            {isActive && (
              <button
                type="button"
                aria-label={isConfirming ? `Confirm delete folder ${f}` : `Delete folder ${f}`}
                className={`rp-ease ml-0.5 grid size-7 place-items-center rounded-sm border ${isConfirming ? "border-rp-danger-border bg-rp-danger-soft text-rp-danger" : "border-transparent text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink"}`}
                onClick={() => {
                  if (isConfirming) { onDelete(f); setConfirmDelete(null); }
                  else { setConfirmDelete(f); }
                }}
                title={isConfirming ? "Click again to confirm" : "Delete folder"}
              >{isConfirming ? <Check aria-hidden="true" className="size-3.5" /> : <X aria-hidden="true" className="size-3.5" />}</button>
            )}
          </div>
        );
      })}
      {showNew ? (
        <input
          autoFocus
          className={`${fieldClassName} h-7 w-28 shrink-0 px-2 text-xs`}
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onBlur={submitNew}
          onKeyDown={e => {
            if (e.key === "Enter") submitNew();
            if (e.key === "Escape") { setNewName(""); setShowNew(false); }
          }}
          placeholder="Folder name"
          aria-label="New folder name"
        />
      ) : (
        <button
          type="button"
          className="rp-ease grid size-7 shrink-0 place-items-center rounded-sm text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-blue"
          aria-label="Add folder"
          title="Add folder"
          onClick={() => setShowNew(true)}
        ><FolderPlus aria-hidden="true" className="size-3.5" /></button>
      )}
    </div>
  );
}

function FilterBar({ filters, agents, statusReady, onUpdate, onResetSecondary }: {
  filters: SavedFilters;
  statusReady: boolean;
  agents: string[];
  onUpdate: (patch: Partial<SavedFilters>) => void;
  onResetSecondary: () => void;
}) {
  const [popOpen, setPopOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const activeCount = (filters.agent ? 1 : 0) + (filters.status !== "all" ? 1 : 0);

  useEffect(() => {
    if (!popOpen) return;
    const h = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setPopOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [popOpen]);

  return (
    <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-rp-ink-muted" />
        <input
          id="saved-search"
          aria-label="Search saved runs"
          className={`${fieldClassName} h-8 pl-8 pr-8 text-[13px]`}
          placeholder="Search saved runs"
          value={filters.search}
          onChange={e => onUpdate({ search: e.target.value })}
        />
        {filters.search && (
          <button
            aria-label="Clear search"
            className="rp-ease absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-control text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink"
            onClick={() => onUpdate({ search: "" })}
          ><X aria-hidden="true" className="size-3" /></button>
        )}
      </div>
      <button
        ref={btnRef}
        aria-label="Open filters"
        aria-expanded={popOpen}
        className={`rp-ease flex h-8 shrink-0 items-center gap-1.5 rounded-control border px-2.5 text-xs font-medium ${activeCount > 0 ? "border-rp-wash-border bg-rp-wash text-rp-blue" : "border-rp-line bg-rp-surface text-rp-ink hover:border-rp-wash-border hover:bg-rp-wash"}`}
        onClick={() => setPopOpen(v => !v)}
      >
        <SlidersHorizontal aria-hidden="true" className="size-3.5" />
        Filters{activeCount > 0 ? ` · ${activeCount}` : ""}
      </button>
      {popOpen && (
        <div
          ref={(el) => {
            (popRef as any).current = el;
            if (!el || !btnRef.current) return;
            const r = btnRef.current.getBoundingClientRect();
            el.style.top = `${r.bottom + 6}px`;
            el.style.right = `${window.innerWidth - r.right}px`;
          }}
          className="rp-pop fixed z-[9999] w-[240px] space-y-3 rounded-lg border border-rp-line bg-rp-surface p-3 shadow-e3"
        >
          <label className="grid gap-1.5">
            <span className="rp-field-label">Run name</span>
            <Select
              aria-label="Filter by run name"
              className="h-8 text-[13px]"
              value={filters.agent}
              onChange={e => onUpdate({ agent: e.target.value })}
            >
              <option value="">All run names</option>
              {agents.map(a => <option key={a} value={a}>{a}</option>)}
            </Select>
          </label>
          <label className="grid gap-1.5">
            <span className="rp-field-label">Status</span>
            <Select
              aria-label="Filter by status"
              aria-describedby={statusReady ? undefined : "saved-status-pending"}
              disabled={!statusReady}
              className="h-8 text-[13px]"
              value={filters.status}
              onChange={e => onUpdate({ status: e.target.value as SavedFilters["status"] })}
            >
              {(Object.keys(STATUS_FILTER_LABEL) as SavedFilters["status"][]).map(value => <option key={value} value={value}>{STATUS_FILTER_LABEL[value]}</option>)}
            </Select>
            {!statusReady && <span id="saved-status-pending" className="text-12 text-rp-ink-muted">Available once the run list has loaded.</span>}
          </label>
          {activeCount > 0 && (
            <Button type="button" variant="outline" size="sm" className="w-full" onClick={onResetSecondary}>Reset</Button>
          )}
        </div>
      )}
    </div>
  );
}

function ActiveFilterChips({ filters, onUpdate }: {
  filters: SavedFilters;
  onUpdate: (patch: Partial<SavedFilters>) => void;
}) {
  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (filters.search) chips.push({ key: "search", label: `"${filters.search}"`, clear: () => onUpdate({ search: "" }) });
  if (filters.agent) chips.push({ key: "agent", label: `Run name: ${filters.agent}`, clear: () => onUpdate({ agent: "" }) });
  if (filters.status !== "all") chips.push({ key: "status", label: STATUS_FILTER_LABEL[filters.status], clear: () => onUpdate({ status: "all" }) });
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="active-filter-chips">
      {chips.map(c => (
        <button
          key={c.key}
          className="rp-ease flex h-6 max-w-full items-center gap-1 rounded-sm border border-rp-wash-border bg-rp-wash px-1.5 text-[11px] font-medium text-rp-blue hover:border-rp-blue"
          title={c.label}
          onClick={c.clear}
          aria-label={`Clear ${c.key} filter`}
        >
          <span className="truncate">{c.label}</span>
          <X aria-hidden="true" className="size-3 shrink-0" />
        </button>
      ))}
    </div>
  );
}

type SavedRunRow = RunListRow;
type SavedStatusFilter = SavedFilters["status"];

const PROBLEM_STATUSES = new Set(["failed", "completed_with_errors", "interrupted", "cancelled"]);

/**
 * GET /api/runs returns at most this many rows (RUN_LIST_LIMITS.defaultLimit in src/stats/runs-list.ts, which the
 * app cannot import because it pulls in server-only modules). A list that long may be cut off, so a saved run
 * missing from it is not proof that the run was deleted.
 */
const RUN_LIST_ROW_CAP = 5000;

type RunLookup = { rows: ReadonlyMap<string, SavedRunRow>; state: "loading" | "error" | "complete" | "capped" };
type RunPresence = { kind: "row"; row: SavedRunRow } | { kind: "missing" } | { kind: "unknown"; reason: string };

function runPresence(lookup: RunLookup, id: string): RunPresence {
  const row = lookup.rows.get(id);
  if (row) return { kind: "row", row };
  if (lookup.state === "complete") return { kind: "missing" };
  const reason = lookup.state === "loading" ? "Loading run status…"
    : lookup.state === "error" ? "The run list could not be loaded, so this run's status is unknown."
    : `Only the newest ${RUN_LIST_ROW_CAP.toLocaleString()} runs are listed. Open this run to see its status.`;
  return { kind: "unknown", reason };
}

function statusGroup(presence: RunPresence): Exclude<SavedStatusFilter, "all"> | null {
  if (presence.kind === "unknown") return null;
  if (presence.kind === "missing") return "missing";
  return PROBLEM_STATUSES.has(runStatus(presence.row).status) ? "problems" : "clean";
}

const STATUS_FILTER_LABEL: Record<SavedStatusFilter, string> = {
  all: "Any status",
  problems: "Failed or with errors",
  clean: "Completed without errors",
  missing: "No longer in Runs",
};

const STATUS_TONE_TEXT = { success: "text-rp-ink", warning: "text-rp-warning", danger: "text-rp-danger", neutral: "text-rp-ink-muted" } as const;

function SavedStatus({ presence, compact = false }: { presence: RunPresence; compact?: boolean }) {
  if (presence.kind === "unknown") {
    return (
      <span className="flex min-w-0 items-center gap-2" title={presence.reason} data-saved-status="unknown">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-rp-line" />
        <span className="truncate text-12 text-rp-ink-muted">{compact ? "Unknown" : "Status unavailable"}</span>
      </span>
    );
  }
  if (presence.kind === "missing") {
    return (
      <span className="flex min-w-0 items-center gap-2" title="This run was deleted from Runs. The saved summary and any cached copy remain.">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-rp-ink-faint" />
        <span className="truncate text-12 text-rp-ink-muted">{compact ? "Not in Runs" : "No longer in Runs"}</span>
      </span>
    );
  }
  const status = runStatus(presence.row);
  const tone = runStatusTone(status.status);
  return (
    <span className="flex min-w-0 items-center gap-2" title={status.detail} data-saved-status={status.status}>
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", status.status === "live" ? "pulse-dot bg-rp-mark-success" : STATUS_DOT[tone])} />
      <span className={cn("truncate text-12", STATUS_TONE_TEXT[tone])}>{status.label}</span>
    </span>
  );
}

/** A locally generated summary restates the input, so the input reads better as the title; a provider summary leads. */
function savedTitle(event: SavedEvent): string {
  if (savedSummarySource(event) === "local" && event.user_input) return event.user_input;
  return event.summary || event.user_input || "No summary yet";
}

function useRunRows(): RunLookup {
  const queryClient = useQueryClient();
  const runs = useRuns();
  const refresh = useCallback(() => { void queryClient.invalidateQueries({ queryKey: ["runs"], exact: true }); }, [queryClient]);
  useRunPhantomEvent("clear", refresh);
  useEffect(() => {
    window.addEventListener("runphantom:run-removed", refresh);
    return () => window.removeEventListener("runphantom:run-removed", refresh);
  }, [refresh]);
  const data = runs.data as SavedRunRow[] | undefined;
  const rows = useMemo(() => new Map((data ?? []).map(row => [row.id, row])), [data]);
  const state: RunLookup["state"] = runs.isSuccess && data
    ? data.length >= RUN_LIST_ROW_CAP ? "capped" : "complete"
    : runs.isError ? "error" : "loading";
  return useMemo(() => ({ rows, state }), [rows, state]);
}

function downloadJson(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Above this many runs the file is written without indentation; large traces would otherwise double in size. */
const PRETTY_EXPORT_LIMIT = 25;

/** One file per export: each saved entry with the portable trace when the run still exists, else its cached copy. */
async function exportSavedRuns(events: readonly SavedEvent[], onProgress: (done: number) => void, signal: AbortSignal): Promise<{ text: string; withTrace: number }> {
  let done = 0;
  const entries = await mapLimited(events, 4, async event => {
    const id = encodeURIComponent(event.id);
    let trace: unknown = null;
    let traceSource: "local" | "saved-cache" | "unavailable" = "unavailable";
    const live = await fetch(`/api/runs/${id}/export`, { signal }).catch(() => null);
    if (live?.ok) { trace = await live.json(); traceSource = "local"; }
    else {
      const cached = await fetch(`/api/saved-runs/cache/${id}`, { signal }).catch(() => null);
      if (cached?.ok) { trace = await cached.json(); traceSource = "saved-cache"; }
    }
    signal.throwIfAborted();
    onProgress(++done);
    return { saved: event, traceSource, trace };
  }, signal);
  const withTrace = entries.filter(entry => entry.trace).length;
  const bundle = { format: "runphantom-saved-runs/v1", exportedAt: new Date().toISOString(), savedRuns: entries };
  return { text: `${JSON.stringify(bundle, null, events.length > PRETTY_EXPORT_LIMIT ? undefined : 2)}\n`, withTrace };
}

function focusSavedLandmark() {
  window.requestAnimationFrame(() => {
    const target = document.getElementById("saved-search") ?? document.getElementById("saved-empty-heading");
    target?.focus({ preventScroll: true });
  });
}

function SavedBulkBar({ events, onClear, onRemoved, announce }: {
  events: readonly SavedEvent[];
  onClear: () => void;
  onRemoved: (allRemoved: boolean) => void;
  announce: (message: string) => void;
}) {
  const [progress, setProgress] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const exportAbort = useRef<AbortController | null>(null);
  useEffect(() => () => exportAbort.current?.abort(), []);
  const count = events.length;
  const exporting = progress !== null;
  const folders = new Set(events.map(event => event.folder ?? null));
  const currentFolder = folders.size === 1 ? [...folders][0] ?? null : "";
  const exportSelected = async () => {
    if (exporting) return;
    const controller = new AbortController();
    exportAbort.current = controller;
    setProgress(0);
    setError(null);
    try {
      const { text, withTrace } = await exportSavedRuns(events, setProgress, controller.signal);
      downloadJson(text, `runphantom-saved-runs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);
      announce(`Exported ${plural(count, "saved run")}${withTrace < count ? `; ${plural(count - withTrace, "run")} had no trace left to include` : ""}`);
    } catch (cause) {
      if (controller.signal.aborted) announce("Export cancelled");
      else setError(cause instanceof Error ? cause.message : "The export could not be written.");
    } finally {
      if (exportAbort.current === controller) exportAbort.current = null;
      setProgress(null);
    }
  };
  return (
    <div role="region" aria-label="Selected saved runs" className="flex flex-wrap items-center gap-2 border-b border-rp-line bg-rp-canvas-blue px-4 py-2 sm:px-6">
      <span className="text-[13px] font-medium text-rp-ink">{plural(count, "saved run")} selected</span>
      <span aria-hidden="true" className="text-rp-ink-faint">·</span>
      <Button type="button" size="sm" variant="secondary" loading={exporting} onClick={() => void exportSelected()}>
        {!exporting && <Download aria-hidden="true" />}
        {exporting ? `Exporting ${Math.min(progress + 1, count)} of ${count}…` : "Export JSON"}
      </Button>
      {exporting && <Button type="button" size="sm" variant="ghost" onClick={() => exportAbort.current?.abort()}>Cancel export</Button>}
      <Button ref={moveRef} type="button" size="sm" variant="secondary" aria-expanded={moveOpen} onClick={() => setMoveOpen(open => !open)}><Folder aria-hidden="true" />Move to folder</Button>
      <Button type="button" size="sm" variant="destructive-outline" onClick={() => setConfirmRemove(true)}><Trash2 aria-hidden="true" />Remove from Saved</Button>
      <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onClear}><X aria-hidden="true" />Clear selection</Button>
      {error && <p role="alert" className="w-full text-12 text-rp-danger">{error}</p>}
      {moveOpen && (
        <SavePopover
          anchorRef={moveRef as React.RefObject<HTMLElement | null>}
          onClose={() => { setMoveOpen(false); moveRef.current?.focus(); }}
          currentFolder={currentFolder}
          onSave={folder => {
            for (const event of events) updateSavedEvent(event.id, { folder });
            if (folder) addFolder(folder);
            announce(`Moved ${plural(count, "saved run")} to ${folder ?? "Unfiled"}`);
          }}
        />
      )}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${plural(count, "saved run")}?`}
        description="Only the bookmarks are removed. The runs stay in Runs until you delete them there."
        confirmLabel={`Remove ${plural(count, "saved run")}`}
        busyLabel="Removing…"
        returnFocus={() => document.getElementById("saved-search") ?? document.getElementById("saved-empty-heading")}
        onConfirm={async () => {
          try {
            await removeSavedEvents(events.map(event => event.id));
          } catch (cause) {
            onRemoved(false);
            throw cause;
          }
          announce(`Removed ${plural(count, "saved run")}`);
          onRemoved(true);
        }}
      />
    </div>
  );
}

function SavedTable({ events, lookup, selected, onToggle, onToggleAll, onOpen }: {
  events: readonly SavedEvent[];
  lookup: RunLookup;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onOpen: (id: string) => void;
}) {
  const allSelected = events.length > 0 && events.every(event => selected.has(event.id));
  const someSelected = !allSelected && events.some(event => selected.has(event.id));
  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (headerCheckbox.current) headerCheckbox.current.indeterminate = someSelected; }, [someSelected]);
  const th = "rp-type-eyebrow h-8 whitespace-nowrap border-b border-rp-line px-2 text-left align-middle text-[11px] font-normal tracking-[0.08em] text-rp-ink-subtle";
  const td = "h-[46px] border-b border-rp-line-muted px-2 align-middle";
  return (
    <table aria-label="Saved runs" className="w-full min-w-[960px] table-fixed border-separate border-spacing-0 text-[13px]">
      <colgroup>
        <col className="w-11" /><col className="w-[176px]" /><col /><col className="w-[148px]" /><col className="w-[96px]" /><col className="w-[20%]" /><col className="w-[128px]" /><col className="w-[92px]" />
      </colgroup>
      <thead className="sticky top-0 z-10 bg-rp-surface">
        <tr>
          <th scope="col" className={cn(th, "pl-5")}><input ref={headerCheckbox} type="checkbox" className="size-4 accent-rp-blue" aria-label={allSelected ? "Clear selection" : "Select all shown saved runs"} checked={allSelected} onChange={onToggleAll} /></th>
          <th scope="col" className={th}>Status</th>
          <th scope="col" className={th}>Run</th>
          <th scope="col" className={th}>Model</th>
          <th scope="col" className={cn(th, "text-right")}>Cost</th>
          <th scope="col" className={th}>Note</th>
          <th scope="col" className={th}>Folder</th>
          <th scope="col" className={cn(th, "pr-6 text-right")}>Saved</th>
        </tr>
      </thead>
      <tbody>
        {events.map(event => {
          const presence = runPresence(lookup, event.id);
          const row = presence.kind === "row" ? presence.row : undefined;
          const absentTitle = presence.kind === "unknown" ? presence.reason : "the run is no longer in Runs";
          const note = getSavedAnnotationPreview(event);
          const model = row ? modelCell(row) : null;
          const cost = row ? costCell(row) : null;
          const agent = row?.agent ?? (row ? runDisplayName(row) : null) ?? (event.event_name || null);
          const isSelected = selected.has(event.id);
          return (
            <tr
              key={event.id}
              data-saved-id={event.id}
              className={cn("group cursor-pointer transition-colors duration-fast", isSelected ? "bg-rp-wash" : "hover:bg-rp-row-hover")}
              onClick={clickEvent => { if (!(clickEvent.target as HTMLElement).closest("input,a,button")) onOpen(event.id); }}
            >
              <td className={cn(td, "pl-5")}><input type="checkbox" className="size-4 accent-rp-blue" aria-label={`Select ${savedTitle(event)}`} checked={isSelected} onChange={() => onToggle(event.id)} /></td>
              <td className={td}><SavedStatus presence={presence} /></td>
              <td className={cn(td, "min-w-0")}>
                <Link to={tracePath("/saved", event.id)} className="block min-w-0 rounded-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rp-blue">
                  <span title={event.summary || savedTitle(event)} className="block truncate font-medium text-rp-ink">{savedTitle(event)}</span>
                  <span className="flex min-w-0 items-baseline gap-1.5 text-12">
                    <span title={agent ? `Agent: ${agent}` : "The run did not name an agent"} className={cn("truncate", agent ? "text-rp-ink-soft" : "text-rp-ink-subtle")}>{agent ?? "Unnamed agent"}</span>
                    <span aria-hidden="true" className="text-rp-ink-faint">·</span>
                    <span className="shrink-0 font-mono text-rp-ink-subtle" title={event.id}>{event.id.slice(0, 8)}</span>
                  </span>
                </Link>
              </td>
              <td className={td}>{model ? <span title={model.title} className={cn("block truncate font-mono text-12", model.unknown ? "text-rp-ink-subtle" : "text-rp-ink")}>{model.text}</span> : <span title={`Model unknown: ${absentTitle}`} className="text-rp-ink-subtle">—</span>}</td>
              <td className={cn(td, "text-right")}>{cost ? <span title={cost.title} className={cn("whitespace-nowrap font-mono text-12 tabular-nums", cost.unknown ? "text-rp-ink-subtle" : "text-rp-ink")}>{cost.text}{cost.marker && <span className="ml-1 font-sans text-[11px] text-rp-ink-subtle">{cost.marker}</span>}</span> : <span title={`Cost unknown: ${absentTitle}`} className="text-rp-ink-subtle">—</span>}</td>
              <td className={td}>{note ? <span title={note.note ?? undefined} className="flex min-w-0 items-center gap-1.5 text-12 text-rp-ink-soft"><MessageSquareText aria-hidden="true" className="size-3 shrink-0 text-rp-ink-muted" /><span className="truncate">{note.note ? `${annotationKindLabel(note.kind)}: ${note.note}` : `${annotationKindLabel(note.kind)} note`}</span></span> : <span className="text-rp-ink-subtle">—</span>}</td>
              <td className={td}>{event.folder ? <span className="inline-flex max-w-full items-center gap-1 rounded-sm border border-rp-line bg-rp-surface px-1.5 py-px text-[11px] font-medium text-rp-ink-soft"><span aria-hidden="true" className="size-1.5 shrink-0 rounded-[1px]" style={{ background: getFolderColor(event.folder) }} /><span className="truncate">{event.folder}</span></span> : <span className="text-rp-ink-subtle">—</span>}</td>
              <td className={cn(td, "pr-6 text-right")}><span className="whitespace-nowrap text-12 text-rp-ink-muted" title={new Date(event.saved_at).toLocaleString()}>{ago(event.saved_at)}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SavedEmptyState({ hasRuns }: { hasRuns: boolean }) {
  const steps = [
    { title: "Open a run", body: "Pick any run in Runs, including the sample runs." },
    { title: "Choose Save", body: "Use Save in the run's header. Add it to a folder if you like." },
    { title: "Come back here", body: "Saved runs keep their summary, notes and a cached copy, even after the run is deleted from Runs." },
  ];
  return (
    <div className="w-full max-w-2xl animate-fade-rise rounded-lg border border-rp-line bg-rp-surface p-6 sm:p-8">
      <Eyebrow marker tone="accent">Saved / Get started</Eyebrow>
      <h2 id="saved-empty-heading" tabIndex={-1} className="rp-section-title mt-3 focus:outline-none">Keep the runs worth coming back to.</h2>
      <ol className="mt-6 grid gap-px overflow-hidden rounded-md border border-rp-line bg-rp-line sm:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="bg-rp-surface p-4">
            <span className="font-mono text-12 text-rp-blue">{String(index + 1).padStart(2, "0")}</span>
            <p className="mt-2 text-[14px] font-medium text-rp-ink">{step.title}</p>
            <p className="mt-1 text-[13px] leading-5 text-rp-ink-muted">{step.body}</p>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button asChild><Link to="/runs">{hasRuns ? "Open Runs" : "Go to Runs"}<ArrowRight aria-hidden="true" /></Link></Button>
        <p className="text-12 text-rp-ink-muted">{hasRuns ? "Your captured runs are waiting there." : "No runs yet? Runs can load three sample runs for you."}</p>
      </div>
    </div>
  );
}

export function SavedPage() {
  const navigate = useNavigate();
  const { runId: routeRunId } = useParams<{ runId?: string }>();
  const selectedId = routeRunId ? safeDecodeParam(routeRunId) : null;
  const savedListRef = useRef<HTMLDivElement>(null);
  useScrollRestoration(savedListRef, "savedpage-list");
  const isMobile = useIsMobile();
  const [events, setEvents] = useState<SavedEvent[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const { filters, update, resetSecondary } = useFilters();
  const runRows = useRunRows();
  const statusReady = runRows.state === "complete" || runRows.state === "capped";
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");

  const reload = useCallback(() => { setEvents(getSavedEvents()); setFolders(getFolders()); }, []);
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const handler = () => reload();
    window.addEventListener("storage", handler);
    window.addEventListener(SAVED_RUNS_REFRESH_EVENT, handler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener(SAVED_RUNS_REFRESH_EVENT, handler);
    };
  }, [reload]);

  const agentNames = useMemo(() => [...new Set(events.map(e => e.event_name))].sort(), [events]);

  const filtered = useMemo(() => {
    let result = events;
    if (filters.folder !== null) result = result.filter(e => (e.folder ?? "") === filters.folder);
    if (filters.agent) result = result.filter(e => e.event_name === filters.agent);
    if (filters.status !== "all" && statusReady) result = result.filter(e => statusGroup(runPresence(runRows, e.id)) === filters.status);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(e =>
        (e.summary ?? "").toLowerCase().includes(q) ||
        (e.user_input ?? "").toLowerCase().includes(q) ||
        (e.assistant_output ?? "").toLowerCase().includes(q) ||
        (getSavedAnnotationPreview(e)?.note ?? "").toLowerCase().includes(q) ||
        (e.event_name ?? "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [events, filters, runRows, statusReady]);

  useEffect(() => {
    setChecked(current => {
      const visible = new Set(filtered.map(event => event.id));
      const next = new Set([...current].filter(id => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [filtered]);

  const selectedEvent = useMemo(() => events.find(e => e.id === selectedId) ?? null, [events, selectedId]);

  const handleRemove = (id: string) => {
    removeSavedEvent(id);
    if (selectedId === id) navigate("/saved", { replace: true });
    reload();
  };

  const handleCreateFolder = (name: string) => {
    addFolder(name);
    update({ folder: name });
    reload();
  };

  const handleDeleteFolder = (name: string) => {
    removeFolder(name);
    if (filters.folder === name) update({ folder: null });
    reload();
  };

  const isEmpty = events.length === 0;
  const tableMode = !isMobile && !selectedId;
  const countBadge = (
    <Badge mono tone="outline" className="mt-0.5" aria-label={filtered.length === events.length ? `${events.length} saved runs` : `${filtered.length} of ${events.length} saved runs shown`}>
      {filtered.length === events.length ? String(events.length) : `${filtered.length}/${events.length}`}
    </Badge>
  );
  const controls = (
    <>
      <FilterBar filters={filters} agents={agentNames} statusReady={statusReady} onUpdate={update} onResetSecondary={resetSecondary} />
      <FolderPills folders={folders} selected={filters.folder} onSelect={(f) => update({ folder: f })} onCreate={handleCreateFolder} onDelete={handleDeleteFolder} />
      <ActiveFilterChips filters={filters} onUpdate={update} />
    </>
  );

  const emptyPanel = isMobile ? (
    <EmptyPanel
      compact
      className="w-full max-w-lg animate-fade-rise"
      eyebrow="Saved / Get started"
      title="No saved runs"
      description="Open a run and choose Save in its header to keep it here, with its summary, notes and a cached copy."
      action={<Button asChild size="sm"><Link to="/runs">Open Runs</Link></Button>}
    />
  ) : <SavedEmptyState hasRuns={runRows.rows.size > 0} />;

  if (tableMode) {
    const checkedEvents = filtered.filter(event => checked.has(event.id));
    const problems = statusReady ? events.filter(event => statusGroup(runPresence(runRows, event.id)) === "problems").length : 0;
    const missing = statusReady ? events.filter(event => runPresence(runRows, event.id).kind === "missing").length : 0;
    return (
      <div className="flex h-full min-h-0 flex-col bg-rp-canvas">
        <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
        <div className="space-y-3 border-b border-rp-line bg-rp-surface px-6 pb-4 pt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <Eyebrow marker tone="accent">Saved / Bookmarked runs</Eyebrow>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="rp-page-title">Saved runs</h1>
                {!isEmpty && <p className="text-[14px] text-rp-ink-muted" aria-live="polite">
                  {filtered.length === events.length ? plural(events.length, "saved run") : `${filtered.length} of ${plural(events.length, "saved run")} shown`}
                  {problems > 0 && <> · <span className="text-rp-danger">{problems} failed or with errors</span></>}
                  {missing > 0 && <> · {missing} no longer in Runs</>}
                </p>}
              </div>
            </div>
          </div>
          {!isEmpty && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="w-full max-w-[420px]"><FilterBar filters={filters} agents={agentNames} statusReady={statusReady} onUpdate={update} onResetSecondary={resetSecondary} /></div>
                <div className="min-w-0 flex-1"><FolderPills folders={folders} selected={filters.folder} onSelect={(f) => update({ folder: f })} onCreate={handleCreateFolder} onDelete={handleDeleteFolder} /></div>
              </div>
              <ActiveFilterChips filters={filters} onUpdate={update} />
            </div>
          )}
        </div>
        {checkedEvents.length > 0 && (
          <SavedBulkBar
            events={checkedEvents}
            onClear={() => setChecked(new Set())}
            onRemoved={allRemoved => { reload(); if (allRemoved) focusSavedLandmark(); }}
            announce={setAnnouncement}
          />
        )}
        <div ref={savedListRef} className="min-h-0 flex-1 overflow-auto bg-rp-surface sb">
          {isEmpty ? (
            <div className="flex min-h-full items-start justify-center bg-rp-canvas px-8 py-10">{emptyPanel}</div>
          ) : filtered.length === 0 ? (
            <div className="flex min-h-full items-start justify-center bg-rp-canvas px-8 py-10">
              <EmptyPanel compact className="w-full max-w-lg animate-fade-rise" title="No saved runs match" description="Clear the search, folder, run name or status filter to see every saved run." />
            </div>
          ) : (
            <SavedTable
              events={filtered}
              lookup={runRows}
              selected={checked}
              onToggle={id => setChecked(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
              onToggleAll={() => setChecked(current => filtered.every(event => current.has(event.id)) ? new Set() : new Set(filtered.map(event => event.id)))}
              onOpen={id => navigate(tracePath("/saved", id))}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full">
      {/*
        Deliberately not inert when empty. Marking the whole column inert made
        every control in it — search, Filters, All, Add folder — visible but dead
        to both pointer and keyboard, which is precisely the state in which you
        want to reach for them.
      */}
      <div
        className={`${isMobile ? (selectedEvent ? "hidden" : "w-full") : "w-80 border-r border-rp-line"} flex flex-shrink-0 flex-col bg-rp-surface`}
      >
        <div className="space-y-3 border-b border-rp-line px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Eyebrow marker tone="accent">Saved / Bookmarked runs</Eyebrow>
              <h1 className="rp-subsection-title mt-2">Saved runs</h1>
            </div>
            {countBadge}
          </div>
          {!isMobile && <Link to="/saved" className="inline-flex items-center gap-1 text-12 font-medium text-rp-blue hover:underline"><ArrowLeft aria-hidden="true" className="size-3" />All saved runs</Link>}
          {controls}
        </div>

        <div ref={savedListRef} className="flex-1 space-y-1 overflow-auto bg-rp-canvas p-3 sb">
          {filtered.map(evt => (
            <SavedListItem
              key={evt.id}
              event={evt}
              presence={runPresence(runRows, evt.id)}
              selected={selectedId === evt.id}
              onClick={() => navigate(tracePath("/saved", evt.id))}
              onRemove={() => handleRemove(evt.id)}
              onMove={(folder) => { updateSavedEvent(evt.id, { folder }); if (folder) addFolder(folder); reload(); }}
            />
          ))}
          {filtered.length === 0 && !isEmpty && (
            <EmptyPanel compact className="animate-fade-rise" title="No saved runs match" description="Clear the search, folder, run name or status filter to see every saved run." />
          )}
          {isEmpty && isMobile && emptyPanel}
        </div>
      </div>

      <div className={`${isMobile && !selectedEvent ? "hidden" : ""} min-w-0 flex-1 overflow-hidden`}>
        {selectedEvent && (
          <div className="flex h-full flex-col">
            {isMobile && (
              <button
                type="button"
                className="rp-ease flex min-h-11 flex-shrink-0 items-center gap-2 border-b border-rp-line bg-rp-surface px-4 py-2 text-left text-[13px] font-medium text-rp-ink hover:bg-rp-row-hover"
                onClick={() => navigate("/saved")}
              >
                <ArrowLeft aria-hidden="true" className="size-3.5 text-rp-blue" />
                <span>Back to saved runs</span>
              </button>
            )}
            <div className="min-h-0 flex-1">
              <SavedRunDetail key={selectedEvent.id} event={selectedEvent} />
            </div>
          </div>
        )}
        {/* A saved run that has since been removed leaves a route id that
            resolves to nothing; saying so beats the generic empty prompt. */}
        {!selectedEvent && selectedId && (
          <TraceNotFound runId={selectedId} backPath="/saved" />
        )}
      </div>
    </div>
  );
}

function SavedListItem({ event, presence, selected, onClick, onRemove, onMove }: {
  event: SavedEvent; presence: RunPresence; selected: boolean; onClick: () => void; onRemove: () => void; onMove: (folder: string | undefined) => void;
}) {
  const ts = new Date(event.timestamp);
  const timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
    ts.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const [moveOpen, setMoveOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const moveBtnRef = useRef<HTMLButtonElement>(null);
  const confirmTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!confirmRemove) return;
    if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = window.setTimeout(() => setConfirmRemove(false), 2500);
    return () => { if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current); };
  }, [confirmRemove]);

  const row = presence.kind === "row" ? presence.row : undefined;
  const folderColor = event.folder ? getFolderColor(event.folder) : null;
  const annotationPreview = getSavedAnnotationPreview(event);
  const titleText = savedTitle(event);

  return (
    <div className="group relative">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className={`rp-ease w-full rounded-lg border py-3 pl-3 pr-12 text-left ${selected ? "border-rp-wash-border bg-rp-wash" : "border-transparent hover:border-rp-line hover:bg-rp-surface"}`}
        onClick={onClick}
      >
        <div className="min-w-0 overflow-hidden">
          <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2">
            <SavedStatus presence={presence} compact />
            {row && <span className="shrink-0 font-mono text-[11px] text-rp-ink-muted" title={costCell(row).title}>{costCell(row).text}</span>}
          </div>
          <div title={event.summary || titleText} className={`line-clamp-2 min-h-[36px] text-[13px] leading-[18px] ${event.summary || event.user_input ? "font-medium text-rp-ink" : "text-rp-ink-muted"}`}>
            {titleText}
          </div>
          {annotationPreview && (
            <div className="mt-2 flex min-w-0 items-start gap-1.5 rounded-sm border border-rp-line-muted bg-rp-canvas-blue px-2 py-1.5 text-[11px] leading-4 text-rp-ink-soft">
              <MessageSquareText aria-hidden="true" className="mt-px size-3 shrink-0 text-rp-ink-muted" />
              <span className="line-clamp-2">
                {annotationPreview.note
                  ? `${annotationKindLabel(annotationPreview.kind)}: ${annotationPreview.note}`
                  : `${annotationKindLabel(annotationPreview.kind)} annotation`}
              </span>
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 overflow-hidden">
            {event.folder && (
              <span className="flex shrink-0 items-center gap-1 rounded-sm border border-rp-line bg-rp-surface px-1.5 py-px text-[11px] font-medium text-rp-ink-soft">
                <span aria-hidden="true" className="size-1.5 rounded-[1px]" style={{ background: folderColor! }} />
                {event.folder}
              </span>
            )}
            <span title={event.event_name} className="rp-meta truncate">{event.event_name}</span>
            <span className="rp-meta ml-auto flex-shrink-0">{timeStr}</span>
          </div>
        </div>
      </button>
      <div className="absolute right-1.5 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-0.5 opacity-100 transition-opacity duration-250 ease-standard lg:opacity-0 lg:focus-within:opacity-100 lg:group-hover:opacity-100">
        <button
          type="button"
          aria-label="Move saved run to folder"
          ref={moveBtnRef}
          className="rp-ease grid size-7 place-items-center rounded-sm text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-blue"
          onClick={(e) => { e.stopPropagation(); setConfirmRemove(false); setMoveOpen(v => !v); }}
          title="Move to folder"
        >
          <Folder aria-hidden="true" className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={confirmRemove ? "Confirm remove saved run" : "Remove saved run"}
          className={`rp-ease grid size-7 place-items-center rounded-sm ${confirmRemove ? "bg-rp-danger-soft text-rp-danger" : "text-rp-ink-muted hover:bg-rp-danger-soft hover:text-rp-danger"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (confirmRemove) { setConfirmRemove(false); onRemove(); }
            else { setConfirmRemove(true); setMoveOpen(false); }
          }}
          title={confirmRemove ? "Click again to confirm delete" : "Remove"}
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {moveOpen && (
        <SavePopover
          anchorRef={moveBtnRef as React.RefObject<HTMLElement | null>}
          onClose={() => setMoveOpen(false)}
          currentFolder={event.folder ?? null}
          onSave={(folder) => onMove(folder)}
        />
      )}
    </div>
  );
}

function SavedRunDetail({ event }: { event: SavedEvent }) {
  const [hasLocalRun, setHasLocalRun] = useState<boolean | null>(null);

  useEffect(() => {
    setHasLocalRun(null);
    fetch(`/api/runs/detail/${event.id}`)
      .then(r => {
        if (!r.ok) return null;
        return r.json();
      })
      .then(data => {
        if (data?.run && data?.spans?.length > 0) {
          // Cache to server for future use (survives clears)
          fetch(`/api/saved-runs/cache/${event.id}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "local", run: data.run, spans: data.spans, liveEvents: data.liveEvents, subAgents: data.subAgents }),
          }).catch(() => {});
          setHasLocalRun(true);
        } else {
          setHasLocalRun(false);
        }
      })
      .catch(() => setHasLocalRun(false));
  }, [event.id]);

  if (hasLocalRun === null) {
    return <div role="status" className="flex h-full items-center justify-center gap-2 text-[13px] text-rp-ink-muted">
      <Loader2 aria-hidden="true" className="size-4 animate-spin text-rp-blue motion-reduce:animate-none" /> Loading saved trace…
    </div>;
  }

  return (
    <div className="flex h-full flex-col">
      <SavedRunSummary event={event} />
      <div className="min-h-0 flex-1 overflow-auto sb">
        {hasLocalRun ? <RunDetail runId={event.id} routeBase="/saved" /> : <SavedTraceUnavailable event={event} />}
      </div>
    </div>
  );
}

function SavedTraceUnavailable({ event }: { event: SavedEvent }) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <EmptyPanel
        className="w-full max-w-lg animate-fade-rise"
        eyebrow="Saved / Trace missing"
        title="Saved trace not available locally"
        description={
          <>
            <p>This saved entry does not have a matching local trace in the current workspace.</p>
            <code title={event.id} className="rp-meta mt-4 block truncate rounded-control border border-rp-line bg-rp-canvas-blue px-3 py-2 text-rp-ink">
              {event.id}
            </code>
          </>
        }
      />
    </div>
  );
}
