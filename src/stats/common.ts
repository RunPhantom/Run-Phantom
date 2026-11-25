import { deriveRunAgent } from "../run-agent";
import type { RunRow } from "./run-facts";

export class StatsRequestError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = "StatsRequestError"; }
}

export function queryString(query: Record<string, unknown>, key: string, max = 256): string | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length > max || raw.includes("\0")) throw new StatsRequestError(`${key} must be a single string of at most ${max} characters`);
  return raw;
}

/** Accepts epoch milliseconds or an ISO-8601 timestamp. */
export function queryTime(query: Record<string, unknown>, key: string): number | undefined {
  const raw = queryString(query, key, 64);
  if (raw === undefined || raw === "") return undefined;
  const value = /^\d{1,16}$/.test(raw) ? Number(raw) : /^\d{4}-\d{2}-\d{2}/.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw new StatsRequestError(`${key} must be epoch milliseconds or an ISO-8601 timestamp`);
  return value;
}

export function runAgent(row: Pick<RunRow, "event_name" | "name"> & { facts: Pick<RunRow["facts"], "finished" | "agentHints"> }): string | null {
  return deriveRunAgent({ event_name: row.event_name, name: row.name, finished: row.facts.finished, hints: row.facts.agentHints });
}

export function runDisplayName(row: Pick<RunRow, "id" | "display_name" | "event_name" | "name">): string {
  return row.display_name?.trim() || row.event_name?.replace(/^replay:/i, "").trim() || row.name?.trim() || row.id.slice(0, 12);
}

export function runUsesModel(row: RunRow, model: string): boolean {
  return row.facts.primaryModel === model || row.facts.models.includes(model);
}

/** Nearest-rank percentile, matching the Team metrics endpoint. Input must be sorted ascending. */
export function percentile(sorted: readonly number[], p: number): number | null {
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
}

export function sortedNumbers(values: Iterable<number | null>): number[] {
  const out: number[] = [];
  for (const value of values) if (value !== null && Number.isFinite(value)) out.push(value);
  return out.sort((a, b) => a - b);
}

/** Rounds away float noise from summed micro-dollar prices without hiding real fractions of a cent. */
export function roundUsd(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
