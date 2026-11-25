import { useEffect, useId, useRef, useState } from "react";
import { Columns3, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fieldClassName } from "@/components/ui/input";
import {
  RUNS_TABLE_COLUMNS,
  RUNS_TABLE_REQUIRED_COLUMNS,
  RUNS_VIEW_STATUSES,
  hasActiveFilters,
  type RunsTableColumn,
  type RunsViewFilters,
  type RunsViewStatus,
  type RunsViewWindow,
} from "../../../src/saved-views-protocol";
import { COLUMN_META, type RunsDensity } from "./table-model";

export const STATUS_FILTER_LABELS: Record<RunsViewStatus, { label: string; title: string }> = {
  running: { label: "Running", title: "Not finished yet, including quiet and interrupted runs" },
  completed: { label: "Completed", title: "Finished with no errors" },
  completed_with_errors: { label: "With errors", title: "Finished, but at least one step ended in an error" },
  failed: { label: "Failed", title: "The run itself ended in an error" },
};

export const WINDOW_LABELS: Record<RunsViewWindow | "all", string> = { "1h": "Last hour", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", all: "All time" };

const SEARCH_DEBOUNCE_MS = 250;
const chip = "inline-flex h-8 items-center gap-1.5 rounded-control border px-2 text-[12px] font-medium transition-[background-color,border-color,color] duration-fast ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rp-blue";
const chipIdle = "border-rp-line bg-rp-surface text-rp-ink-soft hover:border-rp-wash-border hover:bg-rp-wash hover:text-rp-ink";
const chipOn = "border-rp-wash-border bg-rp-wash text-rp-blue";
const selectClass = cn(fieldClassName, "rp-select h-8 w-auto max-w-[156px] cursor-pointer py-0 pl-2.5 pr-8 text-[12px]");

export interface RunsToolbarProps {
  filters: RunsViewFilters;
  agents: readonly string[];
  models: readonly string[];
  compact: boolean;
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** Applies a change on top of the latest filters, so quick successive edits do not undo each other. */
  onChange: (patch: Partial<RunsViewFilters>) => void;
  onClear: () => void;
}

export function RunsToolbar(props: RunsToolbarProps) {
  const { filters, agents, models, compact } = props;
  const [search, setSearch] = useState(filters.q ?? "");
  const lastSent = useRef(filters.q ?? "");
  useEffect(() => {
    if ((filters.q ?? "") !== lastSent.current) { lastSent.current = filters.q ?? ""; setSearch(filters.q ?? ""); }
  }, [filters.q]);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  useEffect(() => {
    if (search.trim() === (lastSent.current ?? "").trim()) return;
    const timer = window.setTimeout(() => {
      lastSent.current = search.trim();
      onChangeRef.current({ q: search.trim() || undefined });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const statuses = new Set(filters.status ?? []);
  const toggleStatus = (status: RunsViewStatus) => {
    const next = new Set(statuses);
    if (next.has(status)) next.delete(status); else next.add(status);
    const list = RUNS_VIEW_STATUSES.filter(item => next.has(item));
    props.onChange({ status: list.length && list.length < RUNS_VIEW_STATUSES.length ? list : undefined });
  };
  const windowValue: RunsViewWindow | "all" | "custom" = filters.window ?? (filters.since !== undefined || filters.until !== undefined ? "custom" : "all");
  const agentOptions = filters.agent && !agents.includes(filters.agent) ? [filters.agent, ...agents] : agents;
  const modelOptions = filters.model && !models.includes(filters.model) ? [filters.model, ...models] : models;
  const active = hasActiveFilters(filters);
  const activeCount = (filters.status?.length ? 1 : 0) + (filters.agent ? 1 : 0) + (filters.model ? 1 : 0) + (windowValue !== "all" ? 1 : 0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter runs">
      <div className={cn("relative", compact ? "min-w-0 flex-1" : "w-[220px]")}>
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-rp-ink-faint" />
        <input
          ref={props.searchRef}
          type="text"
          aria-label="Search runs"
          placeholder="Search runs..."
          value={search}
          onChange={event => setSearch(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Escape" && search) { event.preventDefault(); event.stopPropagation(); setSearch(""); }
            if (event.key === "Enter") { lastSent.current = search.trim(); props.onChange({ q: search.trim() || undefined }); }
          }}
          className={cn(fieldClassName, "h-8 pl-8 pr-9 text-[13px]")}
        />
        {search ? (
          <button type="button" aria-label="Clear run search" onClick={() => setSearch("")}
            className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-control text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink">
            <X aria-hidden="true" className="size-3.5" />
          </button>
        ) : (
          <kbd aria-hidden="true" className="rp-kbd pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">/</kbd>
        )}
      </div>

      {compact && (
        <button type="button" aria-expanded={filtersOpen} aria-controls={panelId} onClick={() => setFiltersOpen(value => !value)}
          className={cn(chip, filtersOpen || activeCount > 0 ? chipOn : chipIdle)}>
          <SlidersHorizontal aria-hidden="true" className="size-3.5" />Filters{activeCount > 0 && <span className="font-mono">{activeCount}</span>}
        </button>
      )}
      <div id={panelId} className={cn("flex-wrap items-center gap-2", compact && "w-full", compact && !filtersOpen ? "hidden" : "flex")}>
      <div role="group" aria-label="Status" className="flex flex-wrap items-center gap-1">
        {RUNS_VIEW_STATUSES.map(status => (
          <button key={status} type="button" aria-pressed={statuses.has(status)} title={STATUS_FILTER_LABELS[status].title}
            onClick={() => toggleStatus(status)} className={cn(chip, statuses.has(status) ? chipOn : chipIdle)}>
            {STATUS_FILTER_LABELS[status].label}
          </button>
        ))}
      </div>

      <select aria-label="Agent" className={cn(selectClass, !filters.agent && "text-rp-ink-muted")} value={filters.agent ?? ""}
        onChange={event => props.onChange({ agent: event.target.value || undefined })}>
        <option value="">All agents</option>
        {agentOptions.map(agent => <option key={agent} value={agent}>{agent}</option>)}
      </select>
      <select aria-label="Model" className={cn(selectClass, !filters.model && "text-rp-ink-muted")} value={filters.model ?? ""}
        onChange={event => props.onChange({ model: event.target.value || undefined })}>
        <option value="">All models</option>
        {modelOptions.map(model => <option key={model} value={model}>{model}</option>)}
      </select>
      <select aria-label="Time window" className={cn(selectClass, windowValue === "all" && "text-rp-ink-muted")} value={windowValue}
        onChange={event => {
          const value = event.target.value as RunsViewWindow | "all" | "custom";
          if (value === "custom") return;
          props.onChange({ window: value === "all" ? undefined : value, since: undefined, until: undefined });
        }}>
        {(Object.keys(WINDOW_LABELS) as (RunsViewWindow | "all")[]).map(value => <option key={value} value={value}>{WINDOW_LABELS[value]}</option>)}
        {windowValue === "custom" && <option value="custom">Custom range</option>}
      </select>

      </div>
      {active && (
        <button type="button" onClick={props.onClear} className="h-8 rounded-control px-2 text-[12px] font-medium text-rp-blue hover:bg-rp-row-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-rp-blue">
          Clear filters
        </button>
      )}

    </div>
  );
}

export function DensityToggle({ density, onChange }: { density: RunsDensity; onChange: (density: RunsDensity) => void }) {
  return (
    <div role="group" aria-label="Row density" className="flex h-8 items-center rounded-control border border-rp-line bg-rp-surface p-0.5">
      {(["comfortable", "compact"] as const).map(value => (
        <button key={value} type="button" aria-pressed={density === value} onClick={() => onChange(value)}
          className={cn("h-6 rounded-[2px] px-2 text-[12px] font-medium transition-colors duration-fast ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-rp-blue",
            density === value ? "bg-rp-wash text-rp-blue" : "text-rp-ink-muted hover:text-rp-ink")}>
          {value === "comfortable" ? "Comfortable" : "Compact"}
        </button>
      ))}
    </div>
  );
}

export function ColumnChooser({ columns, onToggle }: { columns: readonly RunsTableColumn[]; onToggle: (column: RunsTableColumn) => void }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    root.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey, true); };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button ref={trigger} type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}
        className={cn(chip, open ? chipOn : chipIdle)}>
        <Columns3 aria-hidden="true" className="size-3.5" />Columns
      </button>
      {open && (
        <fieldset id={panelId} className="absolute right-0 top-9 z-30 w-56 rounded-md border border-rp-line bg-rp-surface p-2 shadow-e3"
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== trigger.current) setOpen(false); }}>
          <legend className="sr-only">Visible columns</legend>
          <p aria-hidden="true" className="rp-type-eyebrow px-2 pb-1 pt-1 text-rp-ink-subtle">Columns</p>
          {RUNS_TABLE_COLUMNS.map(column => {
            const required = RUNS_TABLE_REQUIRED_COLUMNS.includes(column);
            return (
              <label key={column} className={cn("flex h-8 items-center gap-2 rounded-control px-2 text-[13px]", required ? "text-rp-ink-subtle" : "cursor-pointer text-rp-ink hover:bg-rp-row-hover")}>
                <input type="checkbox" className="rp-checkbox" checked={columns.includes(column)} disabled={required} onChange={() => onToggle(column)} />
                {COLUMN_META[column].label}
                {required && <span className="ml-auto text-[11px]">Always shown</span>}
              </label>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}
