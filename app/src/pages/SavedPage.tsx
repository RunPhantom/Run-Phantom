import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, Trash2, FolderPlus, Folder, Check, Search, X, SlidersHorizontal, MessageSquareText } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyPanel } from "@/components/ui/empty-panel";
import { fieldClassName, Select } from "@/components/ui/input";
import { Eyebrow } from "@/components/ui/typography";
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
    <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-rp-ink-muted" />
        <input
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
        className={`rp-ease flex h-8 shrink-0 items-center gap-1.5 rounded-control border px-2.5 text-xs font-medium ${activeCount > 0 ? "border-rp-wash-border bg-rp-wash text-rp-blue" : "border-rp-line bg-white text-rp-ink hover:border-rp-wash-border hover:bg-rp-wash"}`}
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
          className="rp-pop fixed z-[9999] w-[240px] space-y-3 rounded-lg border border-rp-line bg-white p-3 shadow-e3"
        >
          <label className="grid gap-1.5">
            <span className="rp-field-label">Agent</span>
            <Select
              aria-label="Filter by agent"
              className="h-8 text-[13px]"
              value={filters.agent}
              onChange={e => onUpdate({ agent: e.target.value })}
            >
              <option value="">All agents</option>
              {agents.map(a => <option key={a} value={a}>{a}</option>)}
            </Select>
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
  if (filters.agent) chips.push({ key: "agent", label: `Agent: ${filters.agent}`, clear: () => onUpdate({ agent: "" }) });
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

  const emptyPanel = (
    <EmptyPanel
      compact={isMobile}
      className="w-full max-w-lg animate-fade-rise"
      eyebrow="Saved / Empty"
      title="No saved runs"
      description="Open a run and choose Save in its header to keep it here. Saved runs can be filed into folders and filtered by agent."
    />
  );

  return (
    <div className="relative flex h-full">
      {/*
        Deliberately not inert when empty. Marking the whole column inert made
        every control in it — search, Filters, All, Add folder — visible but dead
        to both pointer and keyboard, which is precisely the state in which you
        want to reach for them.
      */}
      <div
        className={`${isMobile ? (selectedEvent ? "hidden" : "w-full") : "w-80 border-r border-rp-line"} flex flex-shrink-0 flex-col bg-white`}
      >
        <div className="space-y-3 border-b border-rp-line px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Eyebrow marker tone="accent">Saved / Local bookmarks</Eyebrow>
              <h1 className="rp-subsection-title mt-2">Saved runs</h1>
            </div>
            <Badge mono tone="outline" className="mt-0.5" aria-label={filtered.length === events.length ? `${events.length} saved runs` : `${filtered.length} of ${events.length} saved runs shown`}>
              {filtered.length === events.length ? String(events.length) : `${filtered.length}/${events.length}`}
            </Badge>
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

        <div ref={savedListRef} className="flex-1 space-y-1 overflow-auto bg-rp-canvas p-3 sb rp-list-scroll">
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
            <EmptyPanel compact className="animate-fade-rise" title="No saved runs match" description="Clear the search, folder or agent filter to see every saved run." />
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
                className="rp-ease flex min-h-11 flex-shrink-0 items-center gap-2 border-b border-rp-line bg-white px-5 py-2 text-left text-[13px] font-medium text-rp-ink hover:bg-rp-row-hover"
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
        {!selectedEvent && !selectedId && (
          <div className="flex h-full items-center justify-center px-8 py-10">
            {isEmpty ? emptyPanel : (
              <EmptyPanel
                className="w-full max-w-lg animate-fade-rise"
                eyebrow="Saved / No run selected"
                title="Pick a saved run"
                description="Choose a saved run on the left to open its trace here."
              />
            )}
          </div>
        )}
      </div>
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

  return (
    <div className="group relative">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className={`rp-ease w-full rounded-lg border py-3 pl-3 pr-12 text-left ${selected ? "border-rp-wash-border bg-rp-wash" : "border-transparent hover:border-rp-line hover:bg-white"}`}
        onClick={onClick}
      >
        <div className="min-w-0 overflow-hidden">
          <div title={titleText || undefined} className={`line-clamp-2 min-h-[36px] text-[13px] leading-[18px] ${event.summary ? "font-medium text-rp-ink" : event.user_input ? "text-rp-ink-soft" : "text-rp-ink-muted"}`}>
            {titleText || "No summary yet"}
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
              <span className="flex shrink-0 items-center gap-1 rounded-sm border border-rp-line bg-white px-1.5 py-px text-[11px] font-medium text-rp-ink-soft">
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
