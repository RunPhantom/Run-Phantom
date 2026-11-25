/**
 * Runs table filters, URL parameters and saved views. Pure: shared by the daemon (validation, live counts) and the UI
 * (URL sync). Filter names and values are the GET /api/runs contract; `window` is a relative time range resolved to
 * `since` at request time, so a saved "last 24 hours" view keeps meaning the last 24 hours.
 */

export const RUNS_VIEW_STATUSES = ["running", "completed", "completed_with_errors", "failed"] as const;
export type RunsViewStatus = typeof RUNS_VIEW_STATUSES[number];

export const RUNS_VIEW_SORTS = ["last_updated_at", "started_at", "duration", "cost", "tokens", "errors"] as const;
export type RunsViewSort = typeof RUNS_VIEW_SORTS[number];

export const RUNS_VIEW_WINDOWS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 } as const;
export type RunsViewWindow = keyof typeof RUNS_VIEW_WINDOWS;
const WINDOW_KEYS = Object.keys(RUNS_VIEW_WINDOWS) as RunsViewWindow[];

export const RUNS_TABLE_COLUMNS = ["status", "run", "input", "model", "steps", "duration", "tokens", "cost", "errors", "started"] as const;
export type RunsTableColumn = typeof RUNS_TABLE_COLUMNS[number];
/** "run" names the row and is always shown; the chooser cannot hide it. */
export const RUNS_TABLE_REQUIRED_COLUMNS: readonly RunsTableColumn[] = ["run"];
export const RUNS_TABLE_DEFAULT_COLUMNS: readonly RunsTableColumn[] = RUNS_TABLE_COLUMNS.filter(column => column !== "steps");

export const RUNS_VIEW_LIMITS = Object.freeze({ textChars: 256, maxViews: 50, nameChars: 80 });

export interface RunsViewFilters {
  status?: RunsViewStatus[];
  agent?: string;
  model?: string;
  window?: RunsViewWindow;
  /** Absolute start bound, epoch ms. Ignored when `window` is set. */
  since?: number;
  /** Absolute end bound (exclusive), epoch ms. Ignored when `window` is set. */
  until?: number;
  q?: string;
  sort?: RunsViewSort;
  order?: "asc" | "desc";
}

export interface SavedView {
  id: string;
  name: string;
  filters: RunsViewFilters;
  /** Visible columns in display order, or null to use the reader's own column choice. */
  columns: RunsTableColumn[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface SavedViewWithCount extends SavedView {
  /** Runs matching the filters now; null when the count could not be computed. */
  count: number | null;
}

export interface SavedViewInput {
  name: string;
  filters: RunsViewFilters;
  columns: RunsTableColumn[] | null;
}

export class RunsViewError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RunsViewError";
  }
}

function text(value: unknown, label: string, max: number = RUNS_VIEW_LIMITS.textChars): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RunsViewError(`${label} must be text`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new RunsViewError(`${label} must be at most ${max} characters`);
  if (trimmed.includes("\0")) throw new RunsViewError(`${label} must not contain NUL`);
  return trimmed;
}

function epoch(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new RunsViewError(`${label} must be epoch milliseconds`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new RunsViewError(`${label} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const extra = Object.keys(value).find(key => !keys.includes(key));
  if (extra) throw new RunsViewError(`${label} has an unknown field: ${extra}`);
}

/** Strict parse for stored and posted filters. Drops empty values; rejects unknown fields and bad values. */
export function parseRunsViewFilters(value: unknown): RunsViewFilters {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new RunsViewError("filters must be an object");
  onlyKeys(value, ["status", "agent", "model", "window", "since", "until", "q", "sort", "order"], "filters");
  const filters: RunsViewFilters = {};
  if (value.status !== undefined && value.status !== null) {
    if (!Array.isArray(value.status)) throw new RunsViewError("status must be a list");
    const statuses = value.status.map(item => oneOf(item, RUNS_VIEW_STATUSES, "status")!);
    const unique = RUNS_VIEW_STATUSES.filter(status => statuses.includes(status));
    if (unique.length > 0 && unique.length < RUNS_VIEW_STATUSES.length) filters.status = unique;
  }
  const agent = text(value.agent, "agent");
  if (agent) filters.agent = agent;
  const model = text(value.model, "model");
  if (model) filters.model = model;
  const window = oneOf(value.window, WINDOW_KEYS, "window");
  if (window) filters.window = window;
  else {
    const since = epoch(value.since, "since");
    const until = epoch(value.until, "until");
    if (since !== undefined && until !== undefined && until <= since) throw new RunsViewError("until must be later than since");
    if (since !== undefined) filters.since = since;
    if (until !== undefined) filters.until = until;
  }
  const q = text(value.q, "q");
  if (q) filters.q = q;
  const sort = oneOf(value.sort, RUNS_VIEW_SORTS, "sort");
  if (sort && sort !== "last_updated_at") filters.sort = sort;
  const order = oneOf(value.order, ["asc", "desc"] as const, "order");
  if (order === "asc") filters.order = order;
  return filters;
}

function safeEpoch(raw: string | null): number | undefined {
  if (!raw || !/^\d{1,16}$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Lenient parse for a URL (hand-edited or deep-linked): an invalid value is dropped instead of failing the page.
 * Parameters: status (comma list), agent, model, window, since, until (epoch ms), q, sort, order.
 */
export function filtersFromSearchParams(params: URLSearchParams): RunsViewFilters {
  const statuses = (params.get("status") ?? "").split(",").map(item => item.trim()).filter(Boolean);
  const draft: Record<string, unknown> = {
    status: statuses.filter(item => (RUNS_VIEW_STATUSES as readonly string[]).includes(item)),
    agent: params.get("agent")?.slice(0, RUNS_VIEW_LIMITS.textChars) ?? undefined,
    model: params.get("model")?.slice(0, RUNS_VIEW_LIMITS.textChars) ?? undefined,
    q: params.get("q")?.replace(/\0/g, "").slice(0, RUNS_VIEW_LIMITS.textChars) ?? undefined,
  };
  const window = params.get("window");
  if (window && (WINDOW_KEYS as string[]).includes(window)) draft.window = window;
  else {
    const since = safeEpoch(params.get("since"));
    const until = safeEpoch(params.get("until"));
    if (since !== undefined && (until === undefined || until > since)) draft.since = since;
    if (until !== undefined && (since === undefined || until > since)) draft.until = until;
  }
  const sort = params.get("sort");
  if (sort && (RUNS_VIEW_SORTS as readonly string[]).includes(sort)) draft.sort = sort;
  const order = params.get("order");
  if (order === "asc" || order === "desc") draft.order = order;
  return parseRunsViewFilters(draft);
}

/** Canonical URL parameters for filters, in a fixed order so equal filters give equal URLs. */
export function filtersToSearchParams(filters: RunsViewFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.status?.length) params.set("status", filters.status.join(","));
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.model) params.set("model", filters.model);
  if (filters.window) params.set("window", filters.window);
  else {
    if (filters.since !== undefined) params.set("since", String(filters.since));
    if (filters.until !== undefined) params.set("until", String(filters.until));
  }
  if (filters.q) params.set("q", filters.q);
  if (filters.sort && filters.sort !== "last_updated_at") params.set("sort", filters.sort);
  if (filters.order === "asc") params.set("order", "asc");
  return params;
}

/** GET /api/runs query parameters for filters; `window` becomes `since` relative to `now`. */
export function runsListQuery(filters: RunsViewFilters, now: number): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.status?.length) query.status = filters.status.join(",");
  if (filters.agent) query.agent = filters.agent;
  if (filters.model) query.model = filters.model;
  if (filters.window) query.since = String(now - RUNS_VIEW_WINDOWS[filters.window]);
  else {
    if (filters.since !== undefined) query.since = String(filters.since);
    if (filters.until !== undefined) query.until = String(filters.until);
  }
  if (filters.q) query.q = filters.q;
  query.sort = filters.sort ?? "last_updated_at";
  query.order = filters.order ?? "desc";
  return query;
}

/** True when any filter (not sort or order) narrows the list. */
export function hasActiveFilters(filters: RunsViewFilters): boolean {
  return !!(filters.status?.length || filters.agent || filters.model || filters.window || filters.since !== undefined || filters.until !== undefined || filters.q);
}

export function filtersEqual(a: RunsViewFilters, b: RunsViewFilters): boolean {
  return filtersToSearchParams(a).toString() === filtersToSearchParams(b).toString();
}

export function parseRunsTableColumns(value: unknown): RunsTableColumn[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new RunsViewError("columns must be a list");
  const columns: RunsTableColumn[] = [];
  for (const item of value) {
    const column = oneOf(item, RUNS_TABLE_COLUMNS, "column")!;
    if (!columns.includes(column)) columns.push(column);
  }
  for (const required of RUNS_TABLE_REQUIRED_COLUMNS) if (!columns.includes(required)) columns.unshift(required);
  return columns;
}

function viewName(value: unknown): string {
  const name = text(value, "name", RUNS_VIEW_LIMITS.nameChars);
  if (!name) throw new RunsViewError("name is required");
  return name;
}

export function parseSavedViewCreate(value: unknown): SavedViewInput {
  if (!isRecord(value)) throw new RunsViewError("Saved view must be an object");
  onlyKeys(value, ["name", "filters", "columns"], "Saved view");
  return { name: viewName(value.name), filters: parseRunsViewFilters(value.filters), columns: parseRunsTableColumns(value.columns) };
}

export function parseSavedViewUpdate(value: unknown): Partial<SavedViewInput> {
  if (!isRecord(value)) throw new RunsViewError("Saved view update must be an object");
  onlyKeys(value, ["name", "filters", "columns"], "Saved view update");
  const update: Partial<SavedViewInput> = {};
  if (Object.hasOwn(value, "name")) update.name = viewName(value.name);
  if (Object.hasOwn(value, "filters")) update.filters = parseRunsViewFilters(value.filters);
  if (Object.hasOwn(value, "columns")) update.columns = parseRunsTableColumns(value.columns);
  if (Object.keys(update).length === 0) throw new RunsViewError("Saved view update has no fields");
  return update;
}

/** /runs URL that opens a saved view: its filters plus `view=<id>` so the sidebar marks it current. */
export function savedViewPath(view: Pick<SavedView, "id" | "filters">): string {
  const params = filtersToSearchParams(view.filters);
  params.set("view", view.id);
  return `/runs?${params}`;
}
