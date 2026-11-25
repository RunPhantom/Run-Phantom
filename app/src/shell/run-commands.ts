import { ago, runDisplayName, runStatus, type RunStatus } from "../utils/helpers";
import { runPath } from "../utils/navigation";
import type { Run } from "../utils/types";
import type { PaletteCommand, PaletteStatus } from "./commands";
import { fuzzyMatchEntry } from "./fuzzy";

export const RECENT_RUN_LIMIT = 8;
/** Older runs listed for a typed query; the Search fallback below them finds the rest. */
export const MATCHING_RUN_LIMIT = 20;

const PALETTE_TONE: Record<RunStatus, PaletteStatus["tone"]> = {
  live: "live",
  quiet: "unknown",
  complete: "ok",
  completed_with_errors: "warning",
  interrupted: "warning",
  failed: "error",
  cancelled: "cancelled",
  unknown: "unknown",
};

function statusOf(run: Run): PaletteStatus {
  const summary = runStatus(run);
  return { tone: PALETTE_TONE[summary.status], label: summary.label };
}

const newestFirst = (runs: readonly Run[]): Run[] => [...runs].sort((a, b) => b.last_updated_at - a.last_updated_at);

export function recentRuns(runs: readonly Run[] | undefined): Run[] {
  return newestFirst(runs ?? []).slice(0, RECENT_RUN_LIMIT);
}

/** `latest` returns the freshest copy of the run so details and status do not go stale while the palette is open. */
export function runCommand(run: Run, group: string, order: number, latest: (run: Run) => Run = item => item): PaletteCommand {
  const agent = run.agent ?? null;
  const name = runDisplayName(run);
  return {
    id: `run:${run.id}`,
    group,
    label: name,
    detail: () => [agent && agent !== name ? agent : null, ago(latest(run).last_updated_at)].filter(Boolean).join(" · "),
    keywords: [run.id, ...(agent ? [agent] : []), ...(run.model ? [run.model] : [])],
    status: () => statusOf(latest(run)),
    order,
    run: ({ navigate }) => navigate(runPath(run.id)),
  };
}

/**
 * Commands for runs older than the recent list whose name, agent, model or id contains every word of the query. The
 * recent list alone made the palette claim "No pages, runs or commands match" while older runs with that name existed.
 * Plain substring words keep the fuzzy filter from flooding the list with scattered-letter hits across thousands of runs.
 */
export function matchingRunCommands(runs: readonly Run[] | undefined, query: string): PaletteCommand[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || !runs?.length) return [];
  const older = newestFirst(runs).slice(RECENT_RUN_LIMIT);
  const commands: PaletteCommand[] = [];
  for (const run of older) {
    const text = [runDisplayName(run), run.agent, run.model, run.id].filter(Boolean).join(" ").toLowerCase();
    if (!words.every(word => text.includes(word))) continue;
    const command = runCommand(run, "Runs", commands.length);
    if (!fuzzyMatchEntry(query, command.label, command.keywords)) continue;
    commands.push(command);
    if (commands.length === MATCHING_RUN_LIMIT) break;
  }
  return commands;
}
