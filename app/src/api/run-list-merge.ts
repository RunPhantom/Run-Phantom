import type { Run } from "../utils/types";

/** GET /api/runs returns at most this many rows (src/stats/runs-list.ts RUN_LIST_LIMITS.defaultLimit). */
export const RUN_LIST_CAP = 5000;

/**
 * The full run list after `ids` changed: rows in `fresh` replace or join the list, requested ids missing from `fresh`
 * (deleted meanwhile) leave it. Order matches GET /api/runs: last_updated_at descending, ties by id descending.
 */
export function mergeRunRows<T extends Run>(list: readonly T[], ids: readonly string[], fresh: ReadonlyMap<string, T>, cap = RUN_LIST_CAP): T[] {
  const changed = new Set(ids);
  const merged = list.filter(run => !changed.has(run.id));
  for (const id of changed) {
    const row = fresh.get(id);
    if (row) merged.push(row);
  }
  merged.sort((a, b) => b.last_updated_at - a.last_updated_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return merged.length > cap ? merged.slice(0, cap) : merged;
}
