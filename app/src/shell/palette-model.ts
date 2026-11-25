import { commandDetail, type PaletteCommand } from "./commands";
import { fuzzyMatchEntry } from "./fuzzy";

const GROUP_ORDER = ["Go to", "Recent runs", "Search", "Actions", "Help"];
const MAX_RESULTS = 60;

export interface PaletteRow {
  command: PaletteCommand;
  indices: number[];
  score: number;
}

export interface PaletteSection {
  group: string;
  rows: PaletteRow[];
}

function groupRank(group: string): number {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

export function buildSections(commands: readonly PaletteCommand[], query: string): PaletteSection[] {
  const trimmed = query.trim();
  const rows: PaletteRow[] = [];
  for (const command of commands) {
    if (command.when && !command.when()) continue;
    if (!trimmed) { rows.push({ command, indices: [], score: -(command.order ?? 0) }); continue; }
    const detail = commandDetail(command);
    const match = fuzzyMatchEntry(trimmed, command.label, [...(command.keywords ?? []), ...(detail ? [detail] : [])]);
    if (match) rows.push({ command, indices: match.indices, score: match.score });
  }
  const byGroup = new Map<string, PaletteRow[]>();
  for (const row of rows) {
    const list = byGroup.get(row.command.group) ?? [];
    list.push(row);
    byGroup.set(row.command.group, list);
  }
  const sections = [...byGroup.entries()].map(([group, list]) => ({
    group,
    rows: list.sort((a, b) => b.score - a.score),
  }));
  const isFallback = (section: PaletteSection) => section.group === "Search" ? 1 : 0;
  sections.sort((a, b) => trimmed
    ? isFallback(a) - isFallback(b) || b.rows[0]!.score - a.rows[0]!.score || groupRank(a.group) - groupRank(b.group)
    : groupRank(a.group) - groupRank(b.group));
  let budget = MAX_RESULTS;
  return sections.map(section => {
    const rows = section.rows.slice(0, Math.max(budget, 0));
    budget -= rows.length;
    return { ...section, rows };
  }).filter(section => section.rows.length > 0);
}
