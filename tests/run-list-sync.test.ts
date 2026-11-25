import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "../app/node_modules/@tanstack/react-query";
import type { RunFacets, RunListRow } from "../app/src/api/runs";
import { RECENT_RUNS_KEY, RUN_FACETS_KEY, RUNS_KEY } from "../app/src/api/run-query-keys";
import { createRunListSync, mergeRunFacets } from "../app/src/shell/run-list-sync";

const row = (id: string, last_updated_at: number, extra: Partial<RunListRow> = {}): RunListRow =>
  ({ id, last_updated_at, started_at: 0, metadata: null, agent: null, models: [], ...extra } as RunListRow);
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function setup(lookup: (ids: readonly string[]) => Promise<ReadonlyMap<string, RunListRow>>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const lookups: string[][] = [];
  const recentReads: number[] = [];
  client.setQueryDefaults(RECENT_RUNS_KEY, { queryFn: () => { recentReads.push(1); return { runs: [], total: 0 }; } });
  const sync = createRunListSync(client, { lookup: ids => { lookups.push([...ids]); return lookup(ids); }, isDeleting: id => id === "deleting", delayMs: 1 });
  return { client, sync, lookups, recentReads };
}

describe("run list sync", () => {
  test("a burst of span events becomes one lookup of the changed runs, merged into the cached list and facets", async () => {
    const { client, sync, lookups } = setup(async () => new Map([["b", row("b", 50, { agent: "triage", models: ["gpt-5-nano"] })]]));
    client.setQueryData(RUNS_KEY, [row("a", 10)]);
    client.setQueryData<RunFacets>(RUN_FACETS_KEY, { agents: [], models: [], hasOwnRuns: false });
    sync.spans(["b"]);
    sync.spans(["b", "deleting"]);
    sync.spans(undefined);
    await tick(); await tick();
    expect(lookups).toEqual([["b"]]);
    expect(client.getQueryData<RunListRow[]>(RUNS_KEY)?.map(run => run.id)).toEqual(["b", "a"]);
    expect(client.getQueryData<RunFacets>(RUN_FACETS_KEY)).toEqual({ agents: ["triage"], models: ["gpt-5-nano"], hasOwnRuns: true });
    sync.dispose();
  });

  test("nothing is looked up when no page holds the full list or the facets", async () => {
    const { sync, lookups } = setup(async () => new Map());
    sync.spans(["b"]);
    await tick();
    expect(lookups).toEqual([]);
    sync.dispose();
  });

  test("a lookup that resolves after the store was cleared is dropped", async () => {
    let resolve!: (rows: ReadonlyMap<string, RunListRow>) => void;
    const { client, sync } = setup(() => new Promise(done => { resolve = done; }));
    client.setQueryData(RUNS_KEY, [row("a", 10)]);
    sync.spans(["b"]);
    await tick();
    sync.clear();
    client.setQueryData(RUNS_KEY, []);
    resolve(new Map([["b", row("b", 50)]]));
    await tick();
    expect(client.getQueryData<RunListRow[]>(RUNS_KEY)).toEqual([]);
    sync.dispose();
  });

  test("a failed lookup falls back to one full read", async () => {
    const { client, sync } = setup(() => Promise.reject(new Error("offline")));
    let reads = 0;
    client.setQueryDefaults(RUNS_KEY, { queryFn: () => { reads += 1; return [row("b", 50)]; } });
    client.setQueryData(RUNS_KEY, [row("a", 10)]);
    const unsubscribe = new QueryObserver(client, { queryKey: RUNS_KEY, staleTime: Infinity }).subscribe(() => undefined);
    sync.spans(["b"]);
    await tick(); await tick();
    expect(reads).toBe(1);
    expect(client.getQueryData<RunListRow[]>(RUNS_KEY)?.map(run => run.id)).toEqual(["b"]);
    unsubscribe();
    sync.dispose();
  });

  test("changes that land while a full read is in flight wait for it instead of being overwritten by it", async () => {
    let finishRead!: (rows: RunListRow[]) => void;
    const { client, sync, lookups } = setup(async () => new Map([["b", row("b", 50)]]));
    client.setQueryData(RUNS_KEY, [row("a", 10)]);
    const read = client.fetchQuery({ queryKey: RUNS_KEY, queryFn: () => new Promise<RunListRow[]>(done => { finishRead = done; }), staleTime: 0 });
    sync.spans(["b"]);
    await tick();
    expect(lookups).toEqual([]);
    finishRead([row("a", 10)]);
    await read;
    await tick(); await tick();
    expect(lookups).toEqual([["b"]]);
    expect(client.getQueryData<RunListRow[]>(RUNS_KEY)?.map(run => run.id)).toEqual(["b", "a"]);
    sync.dispose();
  });

  test("facets only grow and keep their identity when nothing new arrived", () => {
    const facets: RunFacets = { agents: ["a"], models: ["m"], hasOwnRuns: true };
    expect(mergeRunFacets(facets, [row("x", 1, { agent: "a", models: ["m"] })])).toBe(facets);
    expect(mergeRunFacets({ agents: [], models: [], hasOwnRuns: false }, [row("demo_x", 1, { models: ["m"] })])).toEqual({ agents: [], models: ["m"], hasOwnRuns: false });
  });
});
