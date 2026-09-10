import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bookmark, Loader2, Trash2, ChevronDown, FolderPlus, Folder, Check, Search, X, SlidersHorizontal, MessageSquareText } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { SavePopover } from "../components/SavePopover";
import { RunDetail, TraceNotFound } from "../components/RunDetail";
import {
  addFolder,
  annotationKindLabel,
  getFolderColor,
  getFolders,
  getSavedAnnotationPreview,
  getSavedEvents,
  removeFolder,
  removeSavedEvent,
  SAVED_RUNS_REFRESH_EVENT,
  type SavedAnnotationPreview,
  type SavedEvent,
  updateSavedEvent,
} from "../api/saved-runs";
import { C } from "../utils/colors";
import { useScrollRestoration } from "../hooks/use-scroll-restoration";
import { tracePath } from "../utils/navigation";
import { useIsMobile } from "../hooks/use-mobile";
import { safeDecodeParam } from "../utils/helpers";

const FILTERS_KEY = "runphantom:saved-runs:filters:v1";

export interface SavedFilters {
  search: string;
  folder: string | null;     // null = all, "" = unfiled
  agent: string;             // "" = all
}

const DEFAULT_FILTERS: SavedFilters = {
  search: "",
  folder: null,
  agent: "",
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
  const resetSecondary = useCallback(() => setFilters(prev => ({ ...prev, agent: "" })), []);
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
        className="min-h-7 shrink-0 rounded px-2 py-0.5 text-[10px] transition-colors"
        style={{ background: selected === null ? "var(--rp-ink-a08)" : "transparent", color: selected === null ? C.fg3 : C.fg0 }}
        onClick={() => onSelect(null)}
      >All</button>
      {folders.map(f => {
        const fc = getFolderColor(f);
        const isActive = selected === f;
        const isConfirming = confirmDelete === f;
        return (
          <div key={f} className="relative shrink-0 flex items-center">
            <button
              type="button"
              aria-pressed={isActive}
              className="flex min-h-7 items-center gap-1 rounded px-2 py-0.5 text-[10px] transition-colors"
              style={{ background: isActive ? "var(--rp-ink-a08)" : "transparent", color: isActive ? C.fg3 : C.fg0 }}
              onClick={() => onSelect(isActive ? null : f)}
            >
              <div className="w-2 h-2 rounded-full" style={{ background: fc }} />
              {f}
            </button>
            {isActive && (
              <button
                type="button"
                aria-label={isConfirming ? `Confirm delete folder ${f}` : `Delete folder ${f}`}
                className="ml-0.5 grid min-h-7 min-w-7 place-items-center rounded hover:bg-[color:var(--rp-ink-wash)]"
                style={{ color: isConfirming ? C.red : C.fg0 }}
                onClick={() => {
                  if (isConfirming) { onDelete(f); setConfirmDelete(null); }
                  else { setConfirmDelete(f); }
                }}
                title={isConfirming ? "Click again to confirm" : "Delete folder"}
              >{isConfirming ? "✓" : "×"}</button>
            )}
          </div>
        );
      })}
      {showNew ? (
        <input
          autoFocus
          className="shrink-0 px-1.5 py-0.5 rounded text-[10px] outline-none w-24"
          style={{ background: "var(--rp-ink-a06)", color: C.fg3, border: "1px solid var(--rp-ink-a10)" }}
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onBlur={submitNew}
          onKeyDown={e => {
            if (e.key === "Enter") submitNew();
            if (e.key === "Escape") { setNewName(""); setShowNew(false); }
          }}
          placeholder="Folder name…"
          aria-label="New folder name"
        />
      ) : (
        <button
          type="button"
          className="grid min-h-7 min-w-7 shrink-0 place-items-center rounded text-[10px] transition-colors hover:bg-[color:var(--rp-ink-wash)]"
          style={{ color: C.fg0 }}
          aria-label="Add folder"
          onClick={() => setShowNew(true)}
        ><FolderPlus className="h-3 w-3" /></button>
      )}
    </div>
  );
}

function FilterBar({ filters, agents, onUpdate, onResetSecondary }: {
  filters: SavedFilters;
  agents: string[];
  onUpdate: (patch: Partial<SavedFilters>) => void;
  onResetSecondary: () => void;
}) {
  const [popOpen, setPopOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const activeCount = filters.agent ? 1 : 0;

  useEffect(() => {
    if (!popOpen) return;
    const h = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setPopOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [popOpen]);

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative flex-1 min-w-0">
        <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 pointer-events-none" style={{ color: C.fg0 }} />
        <input
          aria-label="Search saved runs"
          className="w-full pl-6 pr-6 py-1 rounded text-[11px] outline-none"
          style={{ background: "var(--rp-ink-a04)", color: C.fg3, border: "1px solid var(--rp-ink-a06)" }}
          placeholder="Search saved runs…"
          value={filters.search}
          onChange={e => onUpdate({ search: e.target.value })}
        />
        {filters.search && (
          <button
            aria-label="Clear search"
            className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[color:var(--rp-ink-wash)]"
            style={{ color: C.fg0 }}
            onClick={() => onUpdate({ search: "" })}
          ><X className="h-2.5 w-2.5" /></button>
        )}
      </div>
      <button
        ref={btnRef}
        aria-label="Open filters"
        className="rp-hover-wash shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
        style={{
          background: activeCount > 0 ? "var(--rp-ink-a08)" : "var(--rp-ink-a04)",
          color: activeCount > 0 ? C.fg3 : C.fg2,
          border: "1px solid var(--rp-ink-a06)",
        }}
        onClick={() => setPopOpen(v => !v)}
      >
        <SlidersHorizontal className="h-3 w-3" />
        Filters{activeCount > 0 ? ` · ${activeCount}` : ""}
      </button>
      {popOpen && (
        <div
          ref={(el) => {
            (popRef as any).current = el;
            if (!el || !btnRef.current) return;
            const r = btnRef.current.getBoundingClientRect();
            el.style.top = `${r.bottom + 4}px`;
            el.style.right = `${window.innerWidth - r.right}px`;
          }}
          className="fixed z-[9999] rounded-lg p-2.5 shadow-xl space-y-2"
          style={{ background: C.surface, border: `1px solid ${C.border}`, boxShadow: "var(--rp-e3)", width: 220 }}
        >
          <div>
            <div className="text-[10px] mb-1" style={{ color: C.fg0 }}>Agent</div>
            <div className="relative">
              <select
                aria-label="Filter by agent"
                className="w-full appearance-none pl-2 pr-5 py-1 rounded text-[11px] outline-none cursor-pointer"
                style={{ background: "var(--rp-ink-a06)", color: C.fg3, border: "1px solid var(--rp-ink-a08)" }}
                value={filters.agent}
                onChange={e => onUpdate({ agent: e.target.value })}
              >
                <option value="">All agents</option>
                {agents.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-2.5 w-2.5 pointer-events-none" style={{ color: C.fg0 }} />
            </div>
          </div>
          {activeCount > 0 && (
            <button
              className="w-full text-[10px] py-1 rounded transition-colors hover:bg-[color:var(--rp-ink-wash)]"
              style={{ color: C.fg0 }}
              onClick={onResetSecondary}
            >Reset</button>
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
  if (filters.agent) chips.push({ key: "agent", label: `Agent: ${filters.agent}`, clear: () => onUpdate({ agent: "" }) });
  if (chips.length === 0) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap" data-testid="active-filter-chips">
      {chips.map(c => (
        <button
          key={c.key}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] transition-colors rp-hover-wash"
          style={{ background: C.surface, color: C.fg2, border: `1px solid ${C.border}` }}
          onClick={c.clear}
          aria-label={`Clear ${c.key} filter`}
        >
          {c.label}
          <X className="h-2.5 w-2.5" />
        </button>
      ))}
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
  }, [events, filters]);

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

  return (
    <div className="relative flex h-full">

      {/*
        Deliberately not inert when empty. Marking the whole column inert made
        every control in it — search, Filters, All, Add folder — visible but dead
        to both pointer and keyboard, which is precisely the state in which you
        want to reach for them. The empty-state card is pointer-events-none, so
        nothing covers the toolbar either.
      */}
      <div
        className={`${isMobile ? (selectedEvent ? "hidden" : "w-full") : "w-80"} flex-shrink-0 flex flex-col`}
        style={{ borderRight: isMobile ? "none" : `1px solid ${C.border}` }}
      >
        <div className="space-y-2 p-3" style={{ borderBottom: `1px solid ${C.border}` }}>
          <div className="flex items-center justify-between pl-10 lg:pl-0">
            <h1 className="text-[14px] font-medium" style={{ color: C.fg3 }}>Saved Runs</h1>
            <div className="text-[10px]" style={{ color: C.fg0 }}>
              {filtered.length === events.length ? String(events.length) : `${filtered.length}/${events.length}`}
            </div>
          </div>

          <FilterBar
            filters={filters}
            agents={agentNames}
            onUpdate={update}
            onResetSecondary={resetSecondary}
          />

          <FolderPills
            folders={folders}
            selected={filters.folder}
            onSelect={(f) => update({ folder: f })}
            onCreate={handleCreateFolder}
            onDelete={handleDeleteFolder}
          />

          <ActiveFilterChips filters={filters} onUpdate={update} />
        </div>

        <div ref={savedListRef} className="flex-1 overflow-auto p-2 space-y-0.5 sb rp-list-scroll">
          {filtered.map(evt => (
            <SavedListItem
              key={evt.id}
              event={evt}
              selected={selectedId === evt.id}
              onClick={() => navigate(tracePath("/saved", evt.id))}
              onRemove={() => handleRemove(evt.id)}
              onMove={(folder) => { updateSavedEvent(evt.id, { folder }); if (folder) addFolder(folder); reload(); }}
            />
          ))}
          {filtered.length === 0 && !isEmpty && (
            <div className="p-6 text-center text-[11px]" style={{ color: C.fg0 }}>No saved runs match your filters</div>
          )}
        </div>
      </div>


      <div className={`${isMobile && !selectedEvent ? "hidden" : ""} flex-1 min-w-0 overflow-hidden ${isEmpty ? "opacity-40" : ""}`}>
        {selectedEvent && (
          <div className="flex h-full flex-col">
            {isMobile && (
              <button
                type="button"
                className="flex flex-shrink-0 items-center gap-2 py-2 pl-12 pr-4 text-left text-[12px] font-medium"
                style={{ color: C.fg3, borderBottom: `1px solid ${C.border}` }}
                onClick={() => navigate("/saved")}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
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
        {!selectedEvent && !selectedId && !isEmpty && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center space-y-2">
              <Bookmark className="mx-auto h-6 w-6" style={{ color: C.fg0 }} />
              <div className="text-[11px]" style={{ color: C.fg0 }}>Select a saved run to view its trace</div>
            </div>
          </div>
        )}
      </div>


      {isEmpty && (
        // pointer-events-none because this covers the whole column, toolbar
        // included: the card is only centred text, but the layer under it was
        // swallowing every click on Search, Filters and Add folder.
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
          <div className="pointer-events-auto text-center space-y-3 max-w-xs px-4 py-6 rounded-xl" style={{ background: C.surface, border: `1px solid ${C.border}`, boxShadow: "var(--rp-e4)" }}>
            <Bookmark className="mx-auto h-8 w-8" style={{ color: C.fg1 }} />
            <div className="text-sm font-medium" style={{ color: C.fg3 }}>No Saved Runs</div>
            <div className="text-[11px] leading-relaxed" style={{ color: C.fg1 }}>
              Save runs from the Runs page to collect them here for later reference.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SavedListItem({ event, selected, onClick, onRemove, onMove }: {
  event: SavedEvent; selected: boolean; onClick: () => void; onRemove: () => void; onMove: (folder: string | undefined) => void;
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

  const folderColor = event.folder ? getFolderColor(event.folder) : null;
  const annotationPreview = getSavedAnnotationPreview(event);
  const titleText = event.summary || event.user_input || "";
  const titleColor = event.summary ? C.fg4 : (event.user_input ? C.fg1 : C.fg0);

  return (
    <div className="group relative">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className="w-full rounded-lg px-3 py-2.5 pr-12 text-left transition-[background-color,border-color] duration-150 lg:pr-3"
        style={{
          background: selected ? C.selected : "transparent",
          border: `1px solid ${selected ? C.selectedBorder : "transparent"}`,
        }}
        onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "var(--rp-surface)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = selected ? C.selected : "transparent"; }}
        onClick={onClick}
      >
        <div className="min-w-0 overflow-hidden">
          <div className="text-[12px] leading-snug line-clamp-2 min-h-[32px]" style={{ color: titleColor }}>
            {titleText || "No summary yet"}
          </div>
          {annotationPreview && (
            <div className="mt-1.5 flex min-w-0 items-start gap-1.5 rounded-md px-2 py-1.5 text-[10px] leading-snug"
              style={{ background: C.surface, color: C.fg2, border: `1px solid ${C.border}` }}>
              <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0" style={{ color: C.fg1 }} />
              <span className="line-clamp-2">
                {annotationPreview.note
                  ? `${annotationKindLabel(annotationPreview.kind)}: ${annotationPreview.note}`
                  : `${annotationKindLabel(annotationPreview.kind)} annotation`}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5 mt-1.5 overflow-hidden">
            {event.folder && (
              <span className="text-[9px] font-medium px-1.5 py-px rounded-full shrink-0 flex items-center gap-1"
                style={{ background: `${folderColor}18`, color: C.fg2, border: `1px solid ${folderColor}40` }}>
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: folderColor! }} />
                {event.folder}
              </span>
            )}
            <span className="text-[10px] truncate" style={{ color: C.fg0 }}>{event.event_name}</span>
            <span className="text-[9px] flex-shrink-0 ml-auto" style={{ color: C.fg0 }}>{timeStr}</span>
          </div>
        </div>
      </button>
      <div
        className="pointer-events-none absolute top-1 bottom-1 right-1 w-20 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity rounded-r-lg"
        style={{
          background: "linear-gradient(to right, var(--rp-canvas-fade-0) 0%, var(--rp-canvas-fade-1) 55%, var(--rp-canvas-fade-2) 100%)",
        }}
      />
      <div className="absolute top-1/2 -translate-y-1/2 right-1.5 z-10 flex flex-col items-center gap-0.5 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:focus-within:opacity-100">
        <button
          type="button"
          aria-label="Move saved run to folder"
          ref={moveBtnRef}
          className="grid min-h-6 min-w-6 place-items-center rounded transition-colors hover:bg-[color:var(--rp-ink-wash)]"
          style={{ color: C.fg2 }}
          onClick={(e) => { e.stopPropagation(); setConfirmRemove(false); setMoveOpen(v => !v); }}
          title="Move to folder"
        >
          <Folder className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={confirmRemove ? "Confirm remove saved run" : "Remove saved run"}
          className="grid min-h-6 min-w-6 place-items-center rounded transition-colors"
          style={{
            color: confirmRemove ? C.red : C.fg2,
            background: confirmRemove ? "color-mix(in srgb, var(--rp-danger) 10%, white 90%)" : "transparent",
          }}
          onMouseEnter={(e) => { if (!confirmRemove) e.currentTarget.style.background = "var(--rp-ink-a10)"; }}
          onMouseLeave={(e) => { if (!confirmRemove) e.currentTarget.style.background = "transparent"; }}
          onClick={(e) => {
            e.stopPropagation();
            if (confirmRemove) { setConfirmRemove(false); onRemove(); }
            else { setConfirmRemove(true); setMoveOpen(false); }
          }}
          title={confirmRemove ? "Click again to confirm delete" : "Remove"}
        >
          <Trash2 className="h-3 w-3" />
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
    return <div className="h-full flex items-center justify-center gap-2" style={{ color: C.fg1 }}>
      <Loader2 className="h-4 w-4 animate-spin" /> Loading...
    </div>;
  }

  if (hasLocalRun) {
    return (
      <div className="h-full overflow-auto sb">
        <RunDetail runId={event.id} routeBase="/saved" />
      </div>
    );
  }

  return <SavedTraceUnavailable event={event} />;
}

function SavedTraceUnavailable({ event }: { event: SavedEvent }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center">
        <div className="text-[15px] font-medium" style={{ color: C.fg4 }}>
          Saved trace not available locally
        </div>
        <div className="mt-2 text-sm leading-relaxed" style={{ color: C.fg1 }}>
          This saved entry does not have a matching local trace in the current workspace.
        </div>
        <code className="mt-3 block truncate rounded-md border border-[color:var(--rp-border)] bg-[color:var(--rp-ink-wash)] px-2 py-1.5 text-[11px]" style={{ color: C.fg0 }}>
          {event.id}
        </code>
      </div>
    </div>
  );
}
