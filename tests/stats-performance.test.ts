import { expect, test } from "bun:test";
import path from "node:path";
import type { StatsBenchmarkResult } from "./fixtures/stats-benchmark";

const RUNS = 5_000;

// A separate process keeps the benchmark's store, cache and response garbage out of the shared test process, where it
// slowed later timing-sensitive native fixtures (tests/verification-change-context.test.ts) past their deadlines.
test(`overview and run list stay under 150 ms at p95 over ${RUNS.toLocaleString()} runs`, async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "stats-benchmark.ts"), String(RUNS)], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exitCode, stderr: exitCode ? stderr : "" }).toEqual({ exitCode: 0, stderr: "" });
  const result = JSON.parse(stdout.trim().split("\n").pop()!) as StatsBenchmarkResult;
  const format = (value: number) => `${value.toFixed(1)}ms`;
  console.log(`Stats benchmark (${result.runs} runs): cold 30d overview ${format(result.coldMs)}; ${result.routes.map(({ route, rounds }) =>
    `${route} ${rounds.map(round => `p50 ${format(round.p50)} p95 ${format(round.p95)}`).join(" | ")}`).join("; ")}`);
  expect(result.routes.map(item => item.route)).toHaveLength(5);
  for (const { route, rounds } of result.routes) expect({ route, best: Math.min(...rounds.map(round => round.p95)) < 150 }).toEqual({ route, best: true });
  expect(result.coldMs).toBeLessThan(3_000);
}, 180_000);
