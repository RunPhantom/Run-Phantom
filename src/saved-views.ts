import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  RUNS_VIEW_LIMITS,
  RunsViewError,
  parseRunsTableColumns,
  parseRunsViewFilters,
  runsListQuery,
  type SavedView,
  type SavedViewInput,
  type SavedViewWithCount,
} from "./saved-views-protocol";

const FILE_VERSION = 1;

interface SavedViewsFile {
  version: typeof FILE_VERSION;
  views: SavedView[];
}

/**
 * Saved runs-table views, kept as a small JSON file beside the run database so they follow RUNPHANTOM_DB_PATH and,
 * like saved runs, survive "Clear all runs". A JSON file rather than a table: views are a few dozen tiny records
 * read whole, and a file needs no schema migration.
 */
export function savedViewsPath(dbPath: string): string | null {
  if (!dbPath || dbPath === ":memory:" || dbPath.startsWith("file::memory:")) return null;
  return path.join(path.dirname(path.resolve(dbPath)), "saved-views.json");
}

const memory = new Map<string, SavedView[]>();

function parseStoredView(value: unknown): SavedView | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  try {
    if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) return null;
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > RUNS_VIEW_LIMITS.nameChars) return null;
    if (typeof raw.createdAt !== "number" || typeof raw.updatedAt !== "number") return null;
    return { id: raw.id, name: raw.name.trim(), filters: parseRunsViewFilters(raw.filters), columns: parseRunsTableColumns(raw.columns),
      createdAt: raw.createdAt, updatedAt: raw.updatedAt };
  } catch {
    return null;
  }
}

interface StoredViews {
  views: SavedView[];
  /** Entries this version could not read; the file is copied aside before a write would drop them. */
  dropped: number;
  /** The file came from a newer Run Phantom; writing it could lose fields this version does not know. */
  newer: boolean;
}

function readStored(file: string | null): StoredViews {
  if (file === null) return { views: memory.get(":memory:") ?? [], dropped: 0, newer: false };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { views: [], dropped: 0, newer: false };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SavedViewsFile> & { version?: unknown };
    if (!Array.isArray(parsed.views)) throw new Error("views missing");
    const views = parsed.views.map(parseStoredView).filter((view): view is SavedView => view !== null);
    const newer = typeof parsed.version === "number" && parsed.version > FILE_VERSION;
    return { views, dropped: parsed.views.length - views.length, newer };
  } catch {
    // Keep the unreadable file for the user instead of overwriting it with an empty list on the next save.
    const aside = `${file}.unreadable-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch {}
    console.warn(`[runphantom] Saved views file was unreadable; moved it to ${aside}`);
    return { views: [], dropped: 0, newer: false };
  }
}

/** Read for a write: refuses a newer file and keeps a copy of entries the write is about to drop. */
function readForWrite(file: string | null): SavedView[] {
  const stored = readStored(file);
  if (stored.newer) throw new RunsViewError("Saved views were changed by a newer version of Run Phantom. Update Run Phantom to edit them.", 409);
  if (file !== null && stored.dropped > 0) {
    const aside = `${file}.invalid-entries-${Date.now()}`;
    fs.copyFileSync(file, aside);
    console.warn(`[runphantom] ${stored.dropped} saved view(s) could not be read and will be dropped; the original file is kept at ${aside}`);
  }
  return stored.views;
}

function writeViews(file: string | null, views: SavedView[]): void {
  if (file === null) { memory.set(":memory:", views); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const body: SavedViewsFile = { version: FILE_VERSION, views };
  fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

export function listSavedViews(dbPath: string): SavedView[] {
  return readStored(savedViewsPath(dbPath)).views;
}

export function createSavedView(dbPath: string, input: SavedViewInput, now = Date.now()): SavedView {
  const file = savedViewsPath(dbPath);
  const views = readForWrite(file);
  if (views.length >= RUNS_VIEW_LIMITS.maxViews) throw new RunsViewError(`You can keep up to ${RUNS_VIEW_LIMITS.maxViews} saved views; delete one first`, 409);
  if (views.some(view => sameName(view.name, input.name))) throw new RunsViewError(`A view named "${input.name}" already exists`, 409);
  const view: SavedView = { id: randomUUID().replace(/-/g, "").slice(0, 16), name: input.name, filters: input.filters, columns: input.columns, createdAt: now, updatedAt: now };
  writeViews(file, [...views, view]);
  return view;
}

export function updateSavedView(dbPath: string, id: string, update: Partial<SavedViewInput>, now = Date.now()): SavedView {
  const file = savedViewsPath(dbPath);
  const views = readForWrite(file);
  const index = views.findIndex(view => view.id === id);
  if (index < 0) throw new RunsViewError("Saved view not found", 404);
  if (update.name !== undefined && views.some(view => view.id !== id && sameName(view.name, update.name!))) {
    throw new RunsViewError(`A view named "${update.name}" already exists`, 409);
  }
  const next: SavedView = { ...views[index]!, ...update, updatedAt: Math.max(now, views[index]!.updatedAt) };
  writeViews(file, views.map((view, at) => at === index ? next : view));
  return next;
}

export function deleteSavedView(dbPath: string, id: string): void {
  const file = savedViewsPath(dbPath);
  const views = readForWrite(file);
  if (!views.some(view => view.id === id)) throw new RunsViewError("Saved view not found", 404);
  writeViews(file, views.filter(view => view.id !== id));
}

/** Views with how many runs match each one now. `count` is null for every view when counting failed. */
export function savedViewsWithCounts(
  views: readonly SavedView[],
  count: (queries: Record<string, string>[]) => number[],
  now = Date.now(),
): SavedViewWithCount[] {
  let counts: (number | null)[];
  try {
    counts = count(views.map(view => runsListQuery(view.filters, now)));
  } catch (error) {
    console.error("[runphantom] Saved view counts failed:", error);
    counts = views.map(() => null);
  }
  return views.map((view, index) => ({ ...view, count: counts[index] ?? null }));
}
