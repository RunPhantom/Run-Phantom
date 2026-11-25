import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RunListRow } from "../api/runs";
import { ago, runDisplayName, runStatus, runStatusTone } from "../utils/helpers";
import { runPath } from "../utils/navigation";
import type { RunsTableColumn, RunsViewFilters, RunsViewSort } from "../../../src/saved-views-protocol";
import { CHECKBOX_TRACK_PX, COLUMN_META, ROW_HEIGHT, minTableWidth, absoluteTime, agentCell, costCell, durationCell, errorsCell, isSampleRun, modelCell, tokensCell, type CellText, type RunsDensity } from "./table-model";

const OVERSCAN = 12;
const LOAD_MORE_AHEAD = 30;

export const STATUS_DOT: Record<"success" | "warning" | "danger" | "neutral", string> = {
  success: "bg-rp-mark-success",
  warning: "bg-rp-mark-warning",
  danger: "bg-rp-mark-danger",
  neutral: "bg-rp-ink-faint",
};
const STATUS_TEXT: Record<"success" | "warning" | "danger" | "neutral", string> = {
  success: "text-rp-ink",
  warning: "text-rp-warning",
  danger: "text-rp-danger",
  neutral: "text-rp-ink-muted",
};

export interface RunsTableProps {
  rows: readonly RunListRow[];
  total: number | null;
  columns: readonly RunsTableColumn[];
  density: RunsDensity;
  filters: RunsViewFilters;
  shortIds: ReadonlyMap<string, string>;
  selected: ReadonlySet<string>;
  activeIndex: number;
  flashIds: ReadonlySet<string>;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  gridRef: React.RefObject<HTMLDivElement | null>;
  onSort: (sort: RunsViewSort) => void;
  onToggle: (id: string, options?: { range?: boolean }) => void;
  onToggleAll: () => void;
  onActiveIndexChange: (index: number) => void;
  onOpen: (id: string) => void;
  onLoadMore: () => void;
  onScroll: (scrollTop: number) => void;
  /** Accessible name of the grid. */
  label?: string;
  /** Checkbox column and bulk selection; off for read-only lists such as search results. */
  selectable?: boolean;
  /** Column headers sort the list; off when the order is fixed (search relevance). */
  sortable?: boolean;
  rowHref?: (id: string) => string;
  /** A second line under each row spanning every column, such as why a search result matched. */
  renderDetail?: (row: RunListRow) => ReactNode;
  detailHeight?: number;
}

function Cell({ cell, className, mono = true }: { cell: CellText; className?: string; mono?: boolean }) {
  return (
    <span title={cell.title} className={cn("truncate", mono && "font-mono tabular-nums", cell.unknown ? "text-rp-ink-subtle" : "text-rp-ink", className)}>
      {cell.text}
      {cell.marker && <span className="ml-1 font-sans text-[11px] text-rp-ink-subtle">{cell.marker}</span>}
      {cell.unknown && <span className="sr-only">: {cell.title}</span>}
    </span>
  );
}

export function RunsTable(props: RunsTableProps) {
  const { rows, total, columns, density, filters, shortIds, selected, activeIndex, flashIds, hasMore, loadingMore, loadMoreError, scrollRef, gridRef } = props;
  const { label = "Runs", selectable = true, sortable = true, rowHref = runPath, renderDetail, detailHeight = 0 } = props;
  const lineHeight = ROW_HEIGHT[density];
  const rowHeight = lineHeight + (renderDetail ? detailHeight : 0);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const template = useMemo(() => `${selectable ? `${CHECKBOX_TRACK_PX}px ` : ""}${columns.map(column => COLUMN_META[column].track).join(" ")}`, [columns, selectable]);
  const maxDuration = useMemo(() => rows.reduce((max, row) => Math.max(max, row.duration_ms ?? 0), 0), [rows]);
  const sort = filters.sort ?? "last_updated_at";
  const order = filters.order ?? "desc";
  const allSelected = rows.length > 0 && rows.every(row => selected.has(row.id));
  const someSelected = !allSelected && rows.some(row => selected.has(row.id));
  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (headerCheckbox.current) headerCheckbox.current.indeterminate = someSelected; }, [someSelected]);

  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (element) setViewport({ top: element.scrollTop, height: element.clientHeight });
  }, [scrollRef]);
  useLayoutEffect(() => {
    measure();
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, scrollRef]);

  const headerHeight = 32;
  const first = Math.max(0, Math.floor((viewport.top - headerHeight) / rowHeight) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / rowHeight) + OVERSCAN);
  const visible = rows.slice(first, last);

  useEffect(() => {
    if (hasMore && !loadingMore && !loadMoreError && last >= rows.length - LOAD_MORE_AHEAD) props.onLoadMore();
  }, [hasMore, last, loadMoreError, loadingMore, props, rows.length]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || activeIndex < 0) return;
    const top = headerHeight + activeIndex * rowHeight;
    if (top < element.scrollTop + headerHeight) element.scrollTop = top - headerHeight;
    else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight;
  }, [activeIndex, rowHeight, scrollRef]);

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const move = (index: number) => { event.preventDefault(); props.onActiveIndexChange(Math.max(0, Math.min(rows.length - 1, index))); };
    if (event.key === "ArrowDown") move(activeIndex + 1);
    else if (event.key === "ArrowUp") move(activeIndex <= 0 ? 0 : activeIndex - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(rows.length - 1);
    else if (event.key === "PageDown") move(activeIndex + Math.max(1, Math.floor(viewport.height / rowHeight) - 1));
    else if (event.key === "PageUp") move(activeIndex - Math.max(1, Math.floor(viewport.height / rowHeight) - 1));
    else if (event.key === " " && activeIndex >= 0 && rows[activeIndex]) { event.preventDefault(); props.onToggle(rows[activeIndex]!.id); }
  };

  const rowClick = (event: ReactMouseEvent, row: RunListRow, index: number) => {
    if ((event.target as HTMLElement).closest("input,a,button")) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      props.onActiveIndexChange(index);
      props.onToggle(row.id, { range: event.shiftKey });
      return;
    }
    props.onOpen(row.id);
  };

  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;

  return (
    <div
      ref={scrollRef}
      className="sb relative min-h-0 flex-1 overflow-auto border-t border-rp-line bg-rp-surface"
      onScroll={event => { measure(); props.onScroll(event.currentTarget.scrollTop); }}
    >
      <div
        ref={gridRef}
        role="grid"
        tabIndex={0}
        aria-label={label}
        aria-rowcount={(total ?? rows.length) + 1}
        aria-colcount={columns.length + (selectable ? 1 : 0)}
        aria-multiselectable={selectable ? "true" : undefined}
        aria-activedescendant={activeRow ? `runs-row-${activeIndex}` : undefined}
        onKeyDown={onGridKeyDown}
        onFocus={event => { if (event.target === event.currentTarget && activeIndex < 0 && rows.length > 0) props.onActiveIndexChange(0); }}
        className="rp-runs-grid text-[13px] outline-none focus-visible:outline-none"
        style={{ "--rp-runs-cols": template, minWidth: minTableWidth(columns) - (selectable ? 0 : CHECKBOX_TRACK_PX) } as CSSProperties}
      >
        <div role="row" aria-rowindex={1} className="sticky top-0 z-10 grid h-8 items-center border-b border-rp-line bg-rp-canvas" style={{ gridTemplateColumns: "var(--rp-runs-cols)" }}>
          {selectable && <div role="columnheader" className="flex items-center justify-center">
            <input
              ref={headerCheckbox}
              type="checkbox"
              tabIndex={-1}
              aria-label={allSelected ? "Clear selection" : "Select all loaded runs"}
              checked={allSelected}
              disabled={rows.length === 0}
              onChange={props.onToggleAll}
              className="rp-checkbox"
            />
          </div>}
          {columns.map(column => {
            const meta = COLUMN_META[column];
            const sorted = sortable && meta.sort !== undefined && meta.sort === sort;
            const label = meta.header ?? meta.label;
            return (
              <div
                key={column}
                role="columnheader"
                aria-sort={sorted ? (order === "asc" ? "ascending" : "descending") : sortable && meta.sort ? "none" : undefined}
                className={cn("min-w-0 px-2", meta.align === "right" && "text-right")}
              >
                {sortable && meta.sort ? (
                  <button
                    type="button"
                    onClick={() => props.onSort(meta.sort!)}
                    className={cn(
                      "rp-type-eyebrow inline-flex max-w-full items-center gap-1 rounded-control py-1 text-[11px] tracking-[0.08em] transition-colors duration-fast ease-out hover:text-rp-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rp-blue",
                      sorted ? "text-rp-ink" : "text-rp-ink-subtle",
                      meta.align === "right" && "flex-row-reverse",
                    )}
                    aria-label={`Sort by ${meta.label.toLowerCase()}${sorted ? `, now ${order === "asc" ? "ascending" : "descending"}` : ""}`}
                    title={meta.label}
                  >
                    <span className="truncate">{label}</span>
                    {sorted && (order === "asc" ? <ArrowUp aria-hidden="true" className="size-3 shrink-0" /> : <ArrowDown aria-hidden="true" className="size-3 shrink-0" />)}
                  </button>
                ) : (
                  <span className="rp-type-eyebrow block truncate text-[11px] tracking-[0.08em] text-rp-ink-subtle">{label}</span>
                )}
              </div>
            );
          })}
        </div>
        <div aria-hidden="true" style={{ height: first * rowHeight }} />
        {visible.map((row, offset) => {
          const index = first + offset;
          return (
            <RunsTableRow
              key={row.id}
              row={row}
              index={index}
              columns={columns}
              rowHeight={rowHeight}
              lineHeight={lineHeight}
              selectable={selectable}
              href={rowHref(row.id)}
              detail={renderDetail?.(row)}
              shortId={shortIds.get(row.id) ?? row.id}
              selected={selected.has(row.id)}
              active={index === activeIndex}
              flash={flashIds.has(row.id)}
              maxDuration={maxDuration}
              onClick={event => rowClick(event, row, index)}
              onToggle={range => props.onToggle(row.id, { range })}
            />
          );
        })}
        <div aria-hidden="true" style={{ height: (rows.length - last) * rowHeight }} />
      </div>
      {(hasMore || loadMoreError) && (
        <div className="sticky left-0 flex h-10 items-center gap-3 px-4 text-[12px] text-rp-ink-subtle">
          {loadMoreError ? (
            <>
              <span role="alert" className="text-rp-danger">Could not load more runs: {loadMoreError}</span>
              <button type="button" className="rounded-control px-2 py-1 font-medium text-rp-blue hover:bg-rp-row-hover" onClick={props.onLoadMore}>Retry</button>
            </>
          ) : (
            <span role="status">{loadingMore ? "Loading more runs…" : `Showing ${rows.length} of ${total ?? "…"}`}</span>
          )}
        </div>
      )}
    </div>
  );
}

function RunsTableRow({ row, index, columns, rowHeight, lineHeight, selectable, href, detail, shortId, selected, active, flash, maxDuration, onClick, onToggle }: {
  row: RunListRow;
  index: number;
  columns: readonly RunsTableColumn[];
  rowHeight: number;
  lineHeight: number;
  selectable: boolean;
  href: string;
  detail: ReactNode;
  shortId: string;
  selected: boolean;
  active: boolean;
  flash: boolean;
  maxDuration: number;
  onClick: (event: ReactMouseEvent) => void;
  onToggle: (range: boolean) => void;
}) {
  const status = runStatus(row);
  const tone = runStatusTone(status.status);
  const name = runDisplayName(row);
  const sample = isSampleRun(row);
  return (
    <div
      id={`runs-row-${index}`}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selectable ? selected : undefined}
      data-run-id={row.id}
      data-active={active || undefined}
      onClick={onClick}
      style={{ height: rowHeight, gridTemplateColumns: "var(--rp-runs-cols)", gridTemplateRows: detail ? `${lineHeight}px minmax(0, 1fr)` : undefined }}
      className={cn(
        "group/row grid cursor-pointer items-center border-b border-rp-line-muted transition-colors duration-fast ease-out",
        selected ? "bg-rp-wash" : "hover:bg-rp-row-hover",
        active && "rp-row-active",
        flash && "rp-row-new",
      )}
    >
      {selectable && <div role="gridcell" className="flex items-center justify-center">
        <input
          type="checkbox"
          tabIndex={-1}
          aria-label={`Select ${name}`}
          checked={selected}
          onChange={() => undefined}
          onClick={event => { event.stopPropagation(); onToggle(event.shiftKey); }}
          className="rp-checkbox"
        />
      </div>}
      {columns.map(column => {
        switch (column) {
          case "status":
            return (
              <div key={column} role="gridcell" className="flex min-w-0 items-center gap-2 px-2" data-run-list-status={status.status} title={status.detail}>
                <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", status.status === "live" ? "pulse-dot bg-rp-mark-success" : STATUS_DOT[tone])} />
                <span className={cn("truncate text-[12px]", STATUS_TEXT[tone])}>{status.label}</span>
              </div>
            );
          case "run":
            return (
              <div key={column} role="gridcell" className="rp-run-cell flex min-w-0 items-center gap-2 px-2">
                <Link to={href} tabIndex={-1} data-run-name className="min-w-0 truncate font-medium text-rp-ink hover:text-rp-blue hover:underline" onClick={event => event.stopPropagation()}>
                  {name}
                </Link>
                <span className="rp-run-short-id min-w-0 max-w-[9ch] shrink-0 truncate font-mono text-[11px] text-rp-ink-subtle" title={row.id}>{shortId}</span>
                {sample && <span className="shrink-0 rounded-sm border border-rp-line px-1 font-mono text-[11px] uppercase leading-4 tracking-[0.06em] text-rp-ink-subtle">Sample</span>}
              </div>
            );
          case "agent":
            return <div key={column} role="gridcell" className="flex min-w-0 px-2 text-[12px]"><Cell cell={agentCell(row)} mono={false} /></div>;
          case "input":
            return (
              <div key={column} role="gridcell" className="min-w-0 truncate px-2 text-rp-ink-muted" title={row.input_preview ?? undefined}>
                {row.input_preview ?? <span className="text-rp-ink-subtle" title="No user message was captured">—</span>}
              </div>
            );
          case "model": {
            const cell = modelCell(row);
            return <div key={column} role="gridcell" className="flex min-w-0 px-2 text-[12px]"><Cell cell={cell} /></div>;
          }
          case "steps":
            return <div key={column} role="gridcell" className="px-2 text-right font-mono text-[12px] tabular-nums text-rp-ink" title={`${row.span_count ?? 0} captured steps`}>{row.span_count ?? 0}</div>;
          case "duration": {
            const cell = durationCell(row, status.status === "live" || status.status === "quiet" ? "Still running" : "Duration unknown: the run has no finished steps");
            const share = row.duration_ms !== null && maxDuration > 0 ? row.duration_ms / maxDuration : 0;
            return (
              <div key={column} role="gridcell" className="rp-duration-cell flex min-w-0 items-center justify-end gap-2 px-2 text-[12px]">
                {share > 0 && <span aria-hidden="true" className="rp-duration-bar h-1 w-7 shrink-0 overflow-hidden rounded-full bg-rp-line-muted"><span className="block h-full rounded-full bg-rp-mark opacity-40" style={{ width: `${Math.max(4, share * 100)}%` }} /></span>}
                <Cell cell={cell} />
              </div>
            );
          }
          case "tokens":
            return <div key={column} role="gridcell" className="flex min-w-0 justify-end px-2 text-[12px]"><Cell cell={tokensCell(row)} /></div>;
          case "cost":
            return <div key={column} role="gridcell" className="flex min-w-0 justify-end px-2 text-[12px]"><Cell cell={costCell(row)} /></div>;
          case "errors": {
            const cell = errorsCell(row);
            return (
              <div key={column} role="gridcell" className="px-2 text-right font-mono text-[12px] tabular-nums" title={cell.title}>
                <span className={row.error_count ? "font-semibold text-rp-danger" : "text-rp-ink-subtle"}>{cell.text}</span>
                {!row.error_count && <span className="sr-only">: {cell.title}</span>}
              </div>
            );
          }
          case "started":
            return <div key={column} role="gridcell" className="truncate px-2 text-right text-[12px] text-rp-ink-muted" title={absoluteTime(row.started_at)}>{ago(row.started_at)}</div>;
        }
      })}
      {detail && <div role="gridcell" aria-colspan={columns.length + (selectable ? 1 : 0)} className="min-w-0 self-start px-2" style={{ gridColumn: "1 / -1" }} data-row-detail>{detail}</div>}
    </div>
  );
}
