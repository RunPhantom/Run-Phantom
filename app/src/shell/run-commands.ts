import { ago, runDisplayName, runStatus, type RunStatus } from "../utils/helpers";
import { runPath } from "../utils/navigation";
import type { Run } from "../utils/types";
import type { PaletteCommand, PaletteStatus } from "./commands";
import { matchesWords } from "./palette-model";

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

/** Every name a run is known by, including a captured name the display name hides, plus agent, model and id. */
function runSearchText(run: Run): string {
  return [...new Set([runDisplayName(run), run.display_name, run.event_name, run.name, run.agent, run.model, run.id])]
    .filter(Boolean).join(" ");
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
    searchText: runSearchText(run),
    status: () => statusOf(latest(run)),
    order,
    run: ({ navigate }) => navigate(runPath(run.id)),
  };
}

/**
 * Commands for runs older than the recent list whose names, agent, model or id contain every word of the query, in any
 * order. The recent list alone made the palette claim nothing matched while older runs with that name existed. Plain
 * substring words keep a fuzzy filter from flooding the list with scattered-letter hits across thousands of runs.
 */
export function matchingRunCommands(runs: readonly Run[] | undefined, query: string): PaletteCommand[] {
  if (!query.trim() || !runs?.length) return [];
  const commands: PaletteCommand[] = [];
  for (const run of newestFirst(runs).slice(RECENT_RUN_LIMIT)) {
    if (!matchesWords(query, runSearchText(run))) continue;
    commands.push(runCommand(run, "Runs", commands.length));
    if (commands.length === MATCHING_RUN_LIMIT) break;
  }
  return commands;
}
