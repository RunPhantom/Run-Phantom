import type { Database } from "bun:sqlite";
import { LIST_PRICE_REVISIONS, PRICE_TABLE_AS_OF, PRICE_TABLE_REVISION } from "../pricing/list-prices";
import { percentile, queryString, roundUsd, runAgent, runDisplayName, runUsesModel, sortedNumbers, StatsRequestError } from "./common";
import { loadRunRows, selectRunAggregates, type GenerationFact, type RunRow } from "./run-facts";
import { AGENT_FILTER_CHARS } from "../run-agent";
import type { RunStatus } from "./run-status";
import { OVERVIEW_LIMITS, OVERVIEW_VERSION, OVERVIEW_WINDOWS, type CostKpi, type DurationKpi, type Kpi, type Overview, type OverviewAgentRow, type OverviewBucket, type OverviewFailingTool, type OverviewFailure, type OverviewGroupStats, type OverviewLiveRun, type OverviewModelRow, type OverviewWindow, type TokenKpi } from "./overview-types";

export { OVERVIEW_LIMITS, OVERVIEW_VERSION, OVERVIEW_WINDOWS };
export type { CostKpi, DurationKpi, Kpi, Overview, OverviewAgentRow, OverviewBucket, OverviewFailingTool, OverviewFailure, OverviewGroupStats, OverviewLiveRun, OverviewModelRow, OverviewWindow, TokenKpi };

interface OverviewQuery { selection: OverviewWindow; agent?: string; model?: string; tzOffsetMinutes: number }

function parseOverviewQuery(query: Record<string, unknown>): OverviewQuery {
  const selection = (queryString(query, "window", 8) || "24h") as OverviewWindow;
  if (!Object.hasOwn(OVERVIEW_WINDOWS, selection)) throw new StatsRequestError(`window must be one of ${Object.keys(OVERVIEW_WINDOWS).join(", ")}`);
  const rawOffset = queryString(query, "tz_offset_minutes", 8);
  if (rawOffset && !/^-?\d{1,3}$/.test(rawOffset)) throw new StatsRequestError("tz_offset_minutes must be an integer from -840 to 840");
  const tzOffsetMinutes = rawOffset ? Number(rawOffset) : 0;
  if (!Number.isInteger(tzOffsetMinutes) || tzOffsetMinutes < -840 || tzOffsetMinutes > 840) throw new StatsRequestError("tz_offset_minutes must be an integer from -840 to 840");
  return { selection, agent: queryString(query, "agent", AGENT_FILTER_CHARS) || undefined, model: queryString(query, "model") || undefined, tzOffsetMinutes };
}

const ended = (status: RunStatus) => status !== "running";
const rate = (part: number, whole: number) => whole ? part / whole : null;

function generationsFor(row: RunRow, model: string | undefined): readonly GenerationFact[] {
  return model ? row.facts.generations.filter(item => item.model === model) : row.facts.generations;
}

function summarize(rows: readonly RunRow[], model: string | undefined) {
  const counts = { running: 0, completed: 0, completed_with_errors: 0, failed: 0 } satisfies Record<RunStatus, number>;
  const agents = new Set<string>();
  const tokens = { input: 0, output: 0, inputUnknown: 0, outputUnknown: 0, inputKnown: 0, outputKnown: 0 };
  const cost = { usd: 0, known: 0, unknown: 0, reported: 0, estimated: 0 };
  for (const row of rows) {
    counts[row.facts.status]++;
    const agent = runAgent(row);
    if (agent) agents.add(agent);
    for (const generation of generationsFor(row, model)) {
      if (generation.inputTokens === null) tokens.inputUnknown++; else { tokens.input += generation.inputTokens; tokens.inputKnown++; }
      if (generation.outputTokens === null) tokens.outputUnknown++; else { tokens.output += generation.outputTokens; tokens.outputKnown++; }
      if (generation.costUsd === null) cost.unknown++;
      else { cost.usd += generation.costUsd; cost.known++; if (generation.costSource === "reported") cost.reported++; else cost.estimated++; }
    }
  }
  const durations = sortedNumbers(rows.map(row => row.facts.durationMs));
  const endedRuns = rows.length - counts.running;
  return {
    runs: rows.length, counts, activeAgents: agents.size, tokens, cost, durations,
    failureRate: rate(counts.failed, endedRuns), errorRate: rate(counts.failed + counts.completed_with_errors, endedRuns),
  };
}

function groupStats(rows: readonly RunRow[], generations: readonly GenerationFact[]): OverviewGroupStats {
  const failed = rows.filter(row => row.facts.status === "failed").length;
  const endedRuns = rows.filter(row => ended(row.facts.status)).length;
  let inputTokens: number | null = null, outputTokens: number | null = null, tokenUnknownCalls = 0, costUsd = 0, costKnownCalls = 0, costUnknownCalls = 0;
  for (const generation of generations) {
    if (generation.inputTokens === null || generation.outputTokens === null) tokenUnknownCalls++;
    if (generation.inputTokens !== null) inputTokens = (inputTokens ?? 0) + generation.inputTokens;
    if (generation.outputTokens !== null) outputTokens = (outputTokens ?? 0) + generation.outputTokens;
    if (generation.costUsd === null) costUnknownCalls++; else { costUsd += generation.costUsd; costKnownCalls++; }
  }
  return {
    runs: rows.length, failed, completedWithErrors: rows.filter(row => row.facts.status === "completed_with_errors").length, failureRate: rate(failed, endedRuns),
    inputTokens, outputTokens, tokenUnknownCalls, costUsd: costKnownCalls ? roundUsd(costUsd) : null, costKnownCalls, costUnknownCalls,
  };
}

function byRunsThenName<T extends { runs: number }>(key: (row: T) => string | null) {
  return (a: T, b: T) => b.runs - a.runs || (key(a) === null ? 1 : key(b) === null ? -1 : key(a)! < key(b)! ? -1 : key(a)! > key(b)! ? 1 : 0);
}

export function computeOverview(db: Database, dbPath: string, rawQuery: Record<string, unknown>, now = Date.now()): Overview {
  const query = parseOverviewQuery(rawQuery);
  const { durationMs, bucketMs } = OVERVIEW_WINDOWS[query.selection];
  const to = now, from = to - durationMs, previousFrom = from - durationMs;
  const liveSince = now - OVERVIEW_LIMITS.liveActivityMs;
  const all = loadRunRows(db, dbPath, selectRunAggregates(db, "((r.started_at >= ? AND r.started_at < ?) OR r.last_updated_at >= ?)", [previousFrom, to, liveSince]))
    .filter(row => (!query.agent || runAgent(row) === query.agent) && (!query.model || runUsesModel(row, query.model)));
  const current = all.filter(row => row.started_at >= from && row.started_at < to);
  const previous = all.filter(row => row.started_at >= previousFrom && row.started_at < from);
  const now_ = summarize(current, query.model), before = summarize(previous, query.model);
  const kpi = (value: number | null, prior: number | null): Kpi => ({ value, previous: prior });

  const offsetMs = query.tzOffsetMinutes * 60_000;
  const firstBucket = Math.floor((from + offsetMs) / bucketMs) * bucketMs - offsetMs;
  const buckets: Array<Omit<OverviewBucket, "costUsd"> & { costUsd: number; costKnownCalls: number; durations: number[] }> = [];
  for (let start = firstBucket; start < to; start += bucketMs) buckets.push({ start, end: start + bucketMs, partial: start < from || start + bucketMs > to, runs: 0, failed: 0, completedWithErrors: 0, inputTokens: 0, outputTokens: 0, tokenUnknownCalls: 0, costUsd: 0, costKnownCalls: 0, costUnknownCalls: 0, durationP95Ms: null, durations: [] });
  for (const row of current) {
    const bucket = buckets[Math.floor((row.started_at - firstBucket) / bucketMs)];
    bucket.runs++;
    if (row.facts.status === "failed") bucket.failed++;
    if (row.facts.status === "completed_with_errors") bucket.completedWithErrors++;
    if (row.facts.durationMs !== null) bucket.durations.push(row.facts.durationMs);
    for (const generation of generationsFor(row, query.model)) {
      bucket.inputTokens += generation.inputTokens ?? 0;
      bucket.outputTokens += generation.outputTokens ?? 0;
      if (generation.inputTokens === null || generation.outputTokens === null) bucket.tokenUnknownCalls++;
      if (generation.costUsd === null) bucket.costUnknownCalls++; else { bucket.costUsd += generation.costUsd; bucket.costKnownCalls++; }
    }
  }
  const timeseries = buckets.map(({ durations, costKnownCalls, ...bucket }): OverviewBucket => ({
    ...bucket, costUsd: costKnownCalls || !bucket.costUnknownCalls ? roundUsd(bucket.costUsd) : null, durationP95Ms: percentile(sortedNumbers(durations), 0.95),
  }));

  const agentGroups = new Map<string | null, RunRow[]>();
  for (const row of current) {
    const agent = runAgent(row);
    const list = agentGroups.get(agent);
    if (list) list.push(row); else agentGroups.set(agent, [row]);
  }
  const byAgentAll = [...agentGroups].map(([agent, rows]): OverviewAgentRow => {
    const durations = sortedNumbers(rows.map(row => row.facts.durationMs));
    return { agent, ...groupStats(rows, rows.flatMap(row => generationsFor(row, query.model))), durationP50Ms: percentile(durations, 0.5), durationP95Ms: percentile(durations, 0.95) };
  }).sort(byRunsThenName(row => row.agent));

  const modelGroups = new Map<string | null, { rows: Set<RunRow>; generations: GenerationFact[]; providers: Map<string, number> }>();
  for (const row of current) for (const generation of generationsFor(row, query.model)) {
    let group = modelGroups.get(generation.model);
    if (!group) modelGroups.set(generation.model, group = { rows: new Set(), generations: [], providers: new Map() });
    group.rows.add(row);
    group.generations.push(generation);
    if (generation.provider) group.providers.set(generation.provider, (group.providers.get(generation.provider) ?? 0) + 1);
  }
  const byModelAll = [...modelGroups].map(([model, group]): OverviewModelRow => {
    const calls = sortedNumbers(group.generations.map(item => item.durationMs));
    const durations = sortedNumbers([...group.rows].map(row => row.facts.durationMs));
    const provider = [...group.providers].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
    return { model, provider, ...groupStats([...group.rows], group.generations), calls: group.generations.length, callP50Ms: percentile(calls, 0.5), callP95Ms: percentile(calls, 0.95),
      durationP50Ms: percentile(durations, 0.5), durationP95Ms: percentile(durations, 0.95) };
  }).sort(byRunsThenName(row => row.model));

  const tools = new Map<string, OverviewFailingTool>();
  for (const row of current) {
    for (const [name, failure] of Object.entries(row.facts.toolFailures)) {
      const last = { message: failure.last.message, runId: row.id, spanId: failure.last.spanId, at: failure.last.startMs };
      const tool = tools.get(name);
      if (!tool) { tools.set(name, { tool: name, failures: failure.failures, calls: 0, failedRuns: 1, lastError: last }); continue; }
      tool.failures += failure.failures;
      tool.failedRuns++;
      if ((last.at ?? -Infinity) >= (tool.lastError.at ?? -Infinity)) tool.lastError = last;
    }
  }
  for (const row of current) for (const [name, count] of Object.entries(row.facts.toolCalls)) { const tool = tools.get(name); if (tool) tool.calls += count; }
  const topFailingTools = [...tools.values()].sort((a, b) => b.failures - a.failures || (b.lastError.at ?? 0) - (a.lastError.at ?? 0) || (a.tool < b.tool ? -1 : 1)).slice(0, OVERVIEW_LIMITS.topFailingTools);

  const recentFailures = current.filter(row => row.facts.status === "failed" || row.facts.status === "completed_with_errors")
    .sort((a, b) => b.started_at - a.started_at || (a.id < b.id ? 1 : -1)).slice(0, OVERVIEW_LIMITS.recentFailures)
    .map((row): OverviewFailure => {
      const first = row.facts.errors.find(error => error.spanType !== "AGENT_ROOT") ?? row.facts.errors[0];
      return { runId: row.id, name: runDisplayName(row), agent: runAgent(row), status: row.facts.status as OverviewFailure["status"], startedAt: row.started_at, errorCount: row.facts.errorCount,
        error: first ? { spanId: first.spanId, step: first.name, message: first.message } : null };
    });

  const liveRuns = all.filter(row => row.facts.status === "running" && row.last_updated_at >= liveSince)
    .sort((a, b) => b.last_updated_at - a.last_updated_at || (a.id < b.id ? 1 : -1)).slice(0, OVERVIEW_LIMITS.liveRuns)
    .map(row => ({ runId: row.id, name: runDisplayName(row), agent: runAgent(row), startedAt: row.started_at, lastUpdatedAt: row.last_updated_at, spanCount: row.facts.spanCount, model: row.facts.primaryModel }));

  return {
    version: OVERVIEW_VERSION, asOf: now,
    window: { selection: query.selection, from, to, previousFrom, previousTo: from, bucketMs, tzOffsetMinutes: query.tzOffsetMinutes, field: "startedAt" },
    filters: { agent: query.agent ?? null, model: query.model ?? null },
    pricing: { estimateMode: "list-prices", rateCount: LIST_PRICE_REVISIONS.length, revision: PRICE_TABLE_REVISION, asOf: PRICE_TABLE_AS_OF },
    kpis: {
      runs: kpi(now_.runs, before.runs),
      running: kpi(now_.counts.running, before.counts.running),
      completed: kpi(now_.counts.completed, before.counts.completed),
      completedWithErrors: kpi(now_.counts.completed_with_errors, before.counts.completed_with_errors),
      failed: kpi(now_.counts.failed, before.counts.failed),
      failureRate: kpi(now_.failureRate, before.failureRate),
      errorRate: kpi(now_.errorRate, before.errorRate),
      durationP50Ms: { ...kpi(percentile(now_.durations, 0.5), percentile(before.durations, 0.5)), knownRuns: now_.durations.length },
      durationP95Ms: { ...kpi(percentile(now_.durations, 0.95), percentile(before.durations, 0.95)), knownRuns: now_.durations.length },
      inputTokens: { ...kpi(now_.tokens.inputKnown ? now_.tokens.input : null, before.tokens.inputKnown ? before.tokens.input : null), knownCalls: now_.tokens.inputKnown, unknownCalls: now_.tokens.inputUnknown },
      outputTokens: { ...kpi(now_.tokens.outputKnown ? now_.tokens.output : null, before.tokens.outputKnown ? before.tokens.output : null), knownCalls: now_.tokens.outputKnown, unknownCalls: now_.tokens.outputUnknown },
      costUsd: {
        ...kpi(now_.cost.known ? roundUsd(now_.cost.usd) : null, before.cost.known ? roundUsd(before.cost.usd) : null),
        knownCalls: now_.cost.known, unknownCalls: now_.cost.unknown, reportedCalls: now_.cost.reported, estimatedCalls: now_.cost.estimated, previousUnknownCalls: before.cost.unknown,
      },
      activeAgents: kpi(now_.activeAgents, before.activeAgents),
    },
    timeseries,
    byAgent: byAgentAll.slice(0, OVERVIEW_LIMITS.tableRows),
    byModel: byModelAll.slice(0, OVERVIEW_LIMITS.tableRows),
    topFailingTools,
    recentFailures,
    liveRuns,
    truncated: { byAgent: byAgentAll.length > OVERVIEW_LIMITS.tableRows, byModel: byModelAll.length > OVERVIEW_LIMITS.tableRows },
  };
}
