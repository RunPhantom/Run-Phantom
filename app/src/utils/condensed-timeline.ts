import type { Span, SubAgent } from "./types";

export const MAX_TIMELINE_SPANS = 10_000;
export const MAX_TIMELINE_MEMBERSHIPS = 100_000;
export const MAX_TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TimelineEntry {
  span: Span;
  key: string;
  sourceIndex: number;
  parentIndex: number | null;
  parentState: "root" | "linked" | "unavailable" | "ambiguous" | "cycle";
  identityAvailable: boolean;
  timingAvailable: boolean;
  depth: number;
  row: number;
  left: number;
  width: number;
  invocationRootId: string | null;
}

export interface CondensedTimeline {
  entries: TimelineEntry[];
  totalRows: number;
  startMs: number;
  windowMs: number;
  elapsedMs: number | null;
  omittedCount: number;
  unavailableTimeCount: number;
  unavailableParentCount: number;
  duplicateCount: number;
  cycleCount: number;
  windowCapped: boolean;
  groupingUnavailable: boolean;
  unavailableInvocationCount: number;
  invocations: Array<{ rootSpanId: string; name: string; entryKeys: string[] }>;
}

type Lane = { row: number; start: number; end: number };
export function hasTimelineInterval(span: Span): boolean {
  // The served DTO uses zero for absent OTLP timestamps and does not retain presence.
  return !(span.start_time_ms === 0 && span.end_time_ms === 0)
    && Number.isFinite(span.start_time_ms) && Number.isFinite(span.end_time_ms)
    && span.end_time_ms >= span.start_time_ms && Number.isFinite(span.end_time_ms - span.start_time_ms);
}
const earlier = (a: Lane, b: Lane) => a.end < b.end || (a.end === b.end && (a.start < b.start || (a.start === b.start && a.row < b.row)));
function pushLane(heap: Lane[], lane: Lane): void {
  let index = heap.length;
  heap.push(lane);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!earlier(lane, heap[parent])) break;
    heap[index] = heap[parent]; index = parent;
  }
  heap[index] = lane;
}
function popLane(heap: Lane[]): Lane {
  const first = heap[0], last = heap.pop()!;
  if (!heap.length) return first;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && earlier(heap[child + 1], heap[child])) child++;
    if (!earlier(heap[child], last)) break;
    heap[index] = heap[child]; index = child;
  }
  heap[index] = last;
  return first;
}

/** Finite occurrence-preserving layout; names/prompts never supply graph or invocation identity. */
export function buildCondensedTimeline(spans: readonly Span[], agents: readonly Pick<SubAgent, "root_span_id" | "name" | "span_ids">[] = [], minimumIntervalMs = 0): CondensedTimeline {
  if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0 || minimumIntervalMs > MAX_TIMELINE_WINDOW_MS) throw new RangeError("Invalid timeline paint interval");
  const omittedCount = Math.max(0, spans.length - MAX_TIMELINE_SPANS);
  const admitted = spans.slice(0, MAX_TIMELINE_SPANS);
  const counts = new Map<string, number>();
  for (const span of admitted) counts.set(span.id, (counts.get(span.id) ?? 0) + 1);
  const entries: TimelineEntry[] = admitted.map((span, sourceIndex) => ({
    span, sourceIndex, key: `timeline-${sourceIndex}`, parentIndex: null, parentState: "root",
    // Omitted rows may contain a duplicate. A partial population cannot establish unique actions.
    identityAvailable: !omittedCount && counts.get(span.id) === 1,
    timingAvailable: hasTimelineInterval(span),
    depth: 0, row: 0, left: 0, width: 0, invocationRootId: null,
  }));
  const byId = new Map<string, number>();
  entries.forEach((entry, index) => { if (entry.identityAvailable) byId.set(entry.span.id, index); });
  for (const entry of entries) {
    const parent = entry.span.parent_span_id;
    if (!parent) continue;
    if (!entry.identityAvailable || (counts.get(parent) ?? 0) > 1) entry.parentState = "ambiguous";
    else if (!byId.has(parent)) entry.parentState = "unavailable";
    else { entry.parentIndex = byId.get(parent)!; entry.parentState = "linked"; }
  }

  // Each vertex enters one iterative parent walk. Detach every edge inside a cycle, not its descendants.
  const state = new Uint8Array(entries.length);
  for (let index = 0; index < entries.length; index++) {
    if (state[index]) continue;
    const path: number[] = [];
    let current: number | null = index;
    while (current !== null && state[current] === 0) {
      state[current] = 1; path.push(current); current = entries[current].parentIndex;
    }
    if (current !== null && state[current] === 1) {
      const cycleStart = path.indexOf(current);
      for (let cursor = cycleStart; cursor < path.length; cursor++) {
        entries[path[cursor]].parentIndex = null; entries[path[cursor]].parentState = "cycle";
      }
    }
    for (let cursor = path.length - 1; cursor >= 0; cursor--) {
      const entry = entries[path[cursor]];
      entry.depth = entry.parentIndex === null ? 0 : entries[entry.parentIndex].depth + 1;
      state[path[cursor]] = 2;
    }
  }

  let groupingUnavailable = omittedCount > 0 || agents.length > MAX_TIMELINE_SPANS;
  let memberships = 0;
  if (!groupingUnavailable) for (const agent of agents) {
    memberships += agent.span_ids.length;
    if (memberships > MAX_TIMELINE_MEMBERSHIPS) { groupingUnavailable = true; break; }
  }
  const roots = new Map<string, { rootSpanId: string; name: string; entryKeys: string[] }>();
  const claims = new Map<string, Set<string>>();
  let unavailableInvocationCount = 0;
  if (!groupingUnavailable) {
    const rootCounts = new Map<string, number>();
    for (const agent of agents) rootCounts.set(agent.root_span_id, (rootCounts.get(agent.root_span_id) ?? 0) + 1);
    for (const agent of agents) {
      if (!byId.has(agent.root_span_id) || rootCounts.get(agent.root_span_id) !== 1 || !agent.span_ids.includes(agent.root_span_id)) {
        unavailableInvocationCount++; continue;
      }
      roots.set(agent.root_span_id, { rootSpanId: agent.root_span_id, name: agent.name, entryKeys: [] });
      for (const id of agent.span_ids) {
        if (!byId.has(id)) continue;
        const set = claims.get(id) ?? new Set<string>();
        set.add(agent.root_span_id); claims.set(id, set);
      }
    }
  }
  const levels: TimelineEntry[][] = [];
  for (const entry of entries) (levels[entry.depth] ??= []).push(entry);
  let startMs = Infinity, endMs = -Infinity;
  for (const entry of entries) if (entry.timingAvailable) {
    startMs = Math.min(startMs, entry.span.start_time_ms); endMs = Math.max(endMs, entry.span.end_time_ms);
  }
  const hasTimes = startMs !== Infinity;
  const rawWindow = hasTimes ? endMs - startMs : 0;
  const windowCapped = hasTimes && (!Number.isFinite(rawWindow) || rawWindow > MAX_TIMELINE_WINDOW_MS);
  const windowMs = windowCapped ? MAX_TIMELINE_WINDOW_MS : Math.max(rawWindow, 1);
  const origin = hasTimes ? startMs : 0;
  const offset = (time: number) => Math.max(0, Math.min(windowMs, time - origin));
  let totalRows = 0;
  for (const level of levels) {
    const known = level.filter(entry => entry.timingAvailable).sort((a, b) => a.span.start_time_ms < b.span.start_time_ms ? -1 : a.span.start_time_ms > b.span.start_time_ms ? 1 : a.sourceIndex - b.sourceIndex);
    const heap: Lane[] = [];
    let lanes = 0;
    for (const entry of known) {
      const start = windowCapped ? offset(entry.span.start_time_ms) : entry.span.start_time_ms;
      const end = Math.max(windowCapped ? offset(entry.span.end_time_ms) : entry.span.end_time_ms, start + minimumIntervalMs);
      const first = heap[0];
      const free = first && first.end <= start && !(first.start === first.end && first.start === start);
      const lane = free ? popLane(heap).row : lanes++;
      entry.row = totalRows + lane;
      pushLane(heap, { row: lane, start, end });
    }
    for (const entry of level) if (!entry.timingAvailable) entry.row = totalRows + lanes++;
    totalRows += lanes;
    for (const entry of level) {
      const parentRoot = entry.parentIndex === null ? null : entries[entry.parentIndex].invocationRootId;
      const members = claims.get(entry.span.id);
      entry.invocationRootId = roots.has(entry.span.id) ? entry.span.id : parentRoot && members?.has(parentRoot) ? parentRoot : members?.size === 1 ? members.values().next().value! : null;
      if (!entry.invocationRootId && members && members.size > 1) unavailableInvocationCount++;
      if (entry.invocationRootId) roots.get(entry.invocationRootId)!.entryKeys.push(entry.key);
    }
  }
  const percent = (time: number) => (offset(time) / windowMs) * 100;
  for (const entry of entries) if (entry.timingAvailable) {
    entry.left = percent(entry.span.start_time_ms);
    entry.width = Math.max(0, percent(entry.span.end_time_ms) - entry.left);
  }
  return {
    entries, totalRows, startMs: origin, windowMs, elapsedMs: hasTimes && Number.isFinite(rawWindow) ? rawWindow : null,
    omittedCount, unavailableTimeCount: entries.filter(entry => !entry.timingAvailable).length,
    unavailableParentCount: entries.filter(entry => entry.parentState === "unavailable" || entry.parentState === "ambiguous").length,
    duplicateCount: entries.filter(entry => (counts.get(entry.span.id) ?? 0) > 1).length,
    cycleCount: entries.filter(entry => entry.parentState === "cycle").length,
    windowCapped, groupingUnavailable, unavailableInvocationCount, invocations: [...roots.values()],
  };
}
