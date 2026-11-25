import {
  RUNS_TABLE_COLUMNS,
  RUNS_TABLE_DEFAULT_COLUMNS,
  RUNS_TABLE_REQUIRED_COLUMNS,
  type RunsTableColumn,
  type RunsViewFilters,
  type RunsViewSort,
} from "../../../src/saved-views-protocol";
import { PRICE_TABLE_AS_OF } from "../../../src/pricing/list-prices";
import { fmtCost } from "../utils/costs";
import { fmt, plural } from "../utils/helpers";
import type { RunListRow } from "../api/runs";

export type RunsDensity = "comfortable" | "compact";
export const ROW_HEIGHT: Record<RunsDensity, number> = { comfortable: 34, compact: 28 };

export interface ColumnMeta {
  id: RunsTableColumn;
  label: string;
  /** Header text when it differs from the chooser label. */
  header?: string;
  sort?: RunsViewSort;
  align: "left" | "right";
  /** CSS grid track. */
  track: string;
}

export const COLUMN_META: Record<RunsTableColumn, ColumnMeta> = {
  status: { id: "status", label: "Status", align: "left", track: "172px" },
  run: { id: "run", label: "Run", align: "left", track: "minmax(240px, 2fr)" },
  agent: { id: "agent", label: "Agent", align: "left", track: "minmax(100px, 1fr)" },
  input: { id: "input", label: "Input", align: "left", track: "minmax(120px, 1.3fr)" },
  model: { id: "model", label: "Model", align: "left", track: "minmax(104px, 0.8fr)" },
  steps: { id: "steps", label: "Steps", align: "right", track: "60px" },
  duration: { id: "duration", label: "Duration", sort: "duration", align: "right", track: "minmax(76px, 88px)" },
  tokens: { id: "tokens", label: "Tokens in / out", header: "Tokens", sort: "tokens", align: "right", track: "96px" },
  cost: { id: "cost", label: "Cost", sort: "cost", align: "right", track: "minmax(100px, 104px)" },
  errors: { id: "errors", label: "Errors", sort: "errors", align: "right", track: "64px" },
  started: { id: "started", label: "Started", sort: "started_at", align: "right", track: "72px" },
};

export const CHECKBOX_TRACK_PX = 36;

/** Smallest width the visible columns fit in; below it the table scrolls sideways instead of squeezing cells. */
export function minTableWidth(columns: readonly RunsTableColumn[], tracks?: Partial<Record<RunsTableColumn, string>>): number {
  return columns.reduce((sum, column) => sum + Number(/(\d+)px/.exec(tracks?.[column] ?? COLUMN_META[column].track)?.[1] ?? 0), CHECKBOX_TRACK_PX);
}

const CELL_PADDING_PX = 16;
/** Status dot (8px) plus the gap before its label. */
const STATUS_MARK_PX = 16;
/** Rounding slack so a value measured to the exact pixel is not cut to an ellipsis. */
const SUBPIXEL_SLACK_PX = 4;
const STATUS_FONT = '12px "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif';
const MODEL_FONT = '12px "Geist Mono", ui-monospace, monospace';

export type MeasureText = (text: string, font: string) => number;

let context: CanvasRenderingContext2D | null | undefined;
/** Canvas text metrics; without a DOM, 0.6em per glyph, which is Geist Mono's advance and wider than Inter's average. */
export const measureCellText: MeasureText = (text, font) => {
  if (context === undefined) context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!context) return text.length * 7.2;
  context.font = font;
  return context.measureText(text).width;
};

const clampPx = (value: number, min: number, max: number) => Math.ceil(Math.min(max, Math.max(min, value)));

/**
 * Status and Model sized to the widest value on the loaded rows, so Status stays as narrow as its labels and a model
 * id such as "claude-haiku-4-5" is not cut to "claude-haik…". The caps keep one odd value from starving Run.
 */
export function contentTracks(rows: readonly RunListRow[], statusLabel: (row: RunListRow) => string, measure: MeasureText = measureCellText): Partial<Record<RunsTableColumn, string>> {
  if (rows.length === 0) return {};
  const statuses = new Set<string>(), models = new Set<string>();
  for (const row of rows) {
    statuses.add(statusLabel(row));
    models.add(modelCell(row).text);
  }
  const widest = (values: Set<string>, font: string) => Math.max(...[...values].map(value => measure(value, font)));
  return {
    status: `${clampPx(CELL_PADDING_PX + STATUS_MARK_PX + SUBPIXEL_SLACK_PX + widest(statuses, STATUS_FONT), 104, 200)}px`,
    model: `minmax(${clampPx(CELL_PADDING_PX + SUBPIXEL_SLACK_PX + widest(models, MODEL_FONT), 104, 220)}px, 0.8fr)`,
  };
}

/** Dropped in this order when the window is too narrow for every chosen column; Run keeps its width instead. */
const NARROW_DROP_ORDER: readonly RunsTableColumn[] = ["input", "agent"];

/**
 * The chosen columns that fit `available` px. Input, then Agent, are left out while the rest would overflow. When even
 * that does not fit (phones), every chosen column stays and the table scrolls sideways as before.
 */
export function fitColumns(columns: readonly RunsTableColumn[], available: number, tracks?: Partial<Record<RunsTableColumn, string>>): RunsTableColumn[] {
  let fitted = [...columns];
  for (const column of NARROW_DROP_ORDER) {
    if (minTableWidth(fitted, tracks) <= available) return fitted;
    fitted = fitted.filter(item => item !== column);
  }
  return minTableWidth(fitted, tracks) <= available ? fitted : [...columns];
}

export const SORT_LABELS: Record<RunsViewSort, string> = {
  last_updated_at: "Last activity",
  started_at: "Started",
  duration: "Duration",
  cost: "Cost",
  tokens: "Tokens",
  errors: "Errors",
};

const COLUMNS_KEY = "runphantom:runs-table:columns:v1";
const DENSITY_KEY = "runphantom:runs-table:density:v1";

export function normalizeColumns(value: unknown): RunsTableColumn[] {
  if (!Array.isArray(value)) return [...RUNS_TABLE_DEFAULT_COLUMNS];
  const columns = value.filter((item, index): item is RunsTableColumn =>
    (RUNS_TABLE_COLUMNS as readonly unknown[]).includes(item) && value.indexOf(item) === index);
  for (const required of RUNS_TABLE_REQUIRED_COLUMNS) if (!columns.includes(required)) columns.unshift(required);
  return columns;
}

export function loadColumns(): RunsTableColumn[] {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    return normalizeColumns(raw ? JSON.parse(raw) : null);
  } catch {
    return [...RUNS_TABLE_DEFAULT_COLUMNS];
  }
}

export function saveColumns(columns: readonly RunsTableColumn[]): void {
  try { localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns)); } catch {}
}

export function loadDensity(): RunsDensity {
  try { return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable"; } catch { return "comfortable"; }
}

export function saveDensity(density: RunsDensity): void {
  try { localStorage.setItem(DENSITY_KEY, density); } catch {}
}

/** Toggle a column while keeping the canonical column order. */
export function toggleColumn(columns: readonly RunsTableColumn[], column: RunsTableColumn): RunsTableColumn[] {
  if (RUNS_TABLE_REQUIRED_COLUMNS.includes(column)) return [...columns];
  const visible = new Set(columns);
  if (visible.has(column)) visible.delete(column); else visible.add(column);
  return RUNS_TABLE_COLUMNS.filter(id => visible.has(id));
}

/** Clicking a sortable header: a new column sorts descending first, the same column flips direction. */
export function nextSort(filters: RunsViewFilters, sort: RunsViewSort): Pick<RunsViewFilters, "sort" | "order"> {
  const current = filters.sort ?? "last_updated_at";
  const order = filters.order ?? "desc";
  if (current !== sort) return { sort, order: "desc" };
  return { sort, order: order === "desc" ? "asc" : "desc" };
}

export function compactNumber(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}K`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

const grouped = new Intl.NumberFormat("en-US");

export interface CellText {
  text: string;
  /** Tooltip; says what is missing whenever the value is unknown or partial. */
  title: string;
  unknown?: boolean;
  marker?: string;
}

const FACTS_UNAVAILABLE: CellText = { text: "—", title: "Unknown: this run's details could not be loaded", unknown: true };

export function tokensCell(row: RunListRow): CellText {
  if (row.facts_unavailable) return FACTS_UNAVAILABLE;
  if (row.llm_calls === 0) return { text: "—", title: "No model calls in this run", unknown: true };
  if (row.input_tokens !== null && row.output_tokens !== null) {
    return { text: `${compactNumber(row.input_tokens)} / ${compactNumber(row.output_tokens)}`,
      title: `${grouped.format(row.input_tokens)} input · ${grouped.format(row.output_tokens)} output tokens over ${plural(row.llm_calls, "model call")}` };
  }
  if (row.known_input_tokens === null && row.known_output_tokens === null) {
    return { text: "—", title: `Tokens unknown: ${row.llm_calls === 1 ? "the model call did" : `none of the ${row.llm_calls} model calls`} not report token counts`, unknown: true };
  }
  const part = (value: number | null) => value === null ? "?" : `${compactNumber(value)}+`;
  return { text: `${part(row.known_input_tokens)} / ${part(row.known_output_tokens)}`,
    title: `At least ${grouped.format(row.known_input_tokens ?? 0)} input · ${grouped.format(row.known_output_tokens ?? 0)} output tokens; ${plural(row.token_unknown_calls, "call")} did not report counts` };
}

export function costCell(row: RunListRow): CellText {
  if (row.facts_unavailable) return FACTS_UNAVAILABLE;
  if (row.llm_calls === 0) return { text: "—", title: "No model calls in this run", unknown: true };
  if (row.est_cost_usd !== null) {
    if (row.cost_source === "reported") return { text: fmtCost(row.est_cost_usd), title: "Cost reported by the provider" };
    if (row.known_cost_source === "mixed") return { text: fmtCost(row.est_cost_usd), marker: "est.", title: `Reported by the provider for some calls; the rest estimated from list prices (price table ${PRICE_TABLE_AS_OF})` };
    return { text: fmtCost(row.est_cost_usd), marker: "est.",
      title: `Estimated from list prices (price table ${PRICE_TABLE_AS_OF}); excludes discounts, cache storage and tool fees` };
  }
  if (row.known_cost_usd !== null) {
    const missing = `${plural(row.cost_unknown_calls, "call")} without a reported cost or list price`;
    if (row.known_cost_source === "reported") return { text: `${fmtCost(row.known_cost_usd)}+`, title: `Reported by the provider ${fmtCost(row.known_cost_usd)} · ${missing}` };
    if (row.known_cost_source === "mixed") return { text: `${fmtCost(row.known_cost_usd)}+`, marker: "est.", title: `Known ${fmtCost(row.known_cost_usd)}, part reported by the provider and part estimated from list prices · ${missing}` };
    return { text: `${fmtCost(row.known_cost_usd)}+`, marker: "est.", title: `Known estimates ${fmtCost(row.known_cost_usd)} · ${missing}` };
  }
  return { text: "—", unknown: true,
    title: `Cost unknown: ${row.llm_calls === 1 ? "the model call has" : `the ${row.llm_calls} model calls have`} no reported cost and no matching list price` };
}

export function durationCell(row: RunListRow, runningLabel: string): CellText {
  if (row.facts_unavailable) return FACTS_UNAVAILABLE;
  if (row.duration_ms === null) return { text: "—", title: runningLabel, unknown: true };
  return { text: fmt(row.duration_ms), title: `${grouped.format(row.duration_ms)} ms from the first step's start to the last step's end` };
}

export function agentCell(row: Pick<RunListRow, "agent" | "facts_unavailable">): CellText {
  if (row.facts_unavailable) return FACTS_UNAVAILABLE;
  if (!row.agent) return { text: "—", title: "Agent unknown: the run did not name an agent", unknown: true };
  return { text: row.agent, title: row.agent };
}

/** Clean runs show "—" so the runs with errors stand out. */
export function errorsCell(row: Pick<RunListRow, "error_count">): CellText {
  if (!row.error_count) return { text: "—", title: "No step ended in an error" };
  return { text: String(row.error_count), title: `${plural(row.error_count, "step")} ended in an error` };
}

/** "gpt-5-nano-2025-08-07" reads as "gpt-5-nano" in a narrow cell; the tooltip keeps the exact id. */
export function shortModelName(model: string): string {
  return model.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

export function modelCell(row: RunListRow): CellText {
  const model = row.primary_model ?? row.model ?? null;
  if (!model && row.facts_unavailable) return FACTS_UNAVAILABLE;
  if (!model) return { text: "—", title: row.llm_calls === 0 ? "No model calls in this run" : "The model calls did not name a model", unknown: true };
  const others = new Set(row.models.filter(item => item !== model).map(shortModelName));
  others.delete(shortModelName(model));
  const text = shortModelName(model);
  return { text: others.size > 0 ? `${text} +${others.size}` : text, title: row.models.length > 1 ? row.models.join(", ") : model };
}

export function isSampleRun(row: { id: string; metadata: string | null }): boolean {
  if (row.id.startsWith("demo_")) return true;
  if (!row.metadata) return false;
  try {
    const metadata = JSON.parse(row.metadata);
    return metadata?.demo === true && metadata?.default === true;
  } catch {
    return false;
  }
}

export function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** CSV-free export: the rows exactly as the API returned them, so nothing is re-derived or rounded. */
export function exportRowsJson(rows: readonly RunListRow[], exportedAt: number): string {
  return `${JSON.stringify({ format: "runphantom-runs/v1", exportedAt: new Date(exportedAt).toISOString(), runs: rows }, null, 2)}\n`;
}
