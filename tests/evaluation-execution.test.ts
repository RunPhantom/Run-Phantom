import { describe, expect, test, spyOn } from "bun:test";
import { freezeExecution, parseExecutionDraft, executeFrozen, DispatchSlots } from "../src/evaluations/executor";
import http from "node:http";
import { once } from "node:events";
import type { DatasetRevision } from "../src/evaluations/protocol";

const revision = (): DatasetRevision => ({ datasetId: "dataset", datasetName: "Literal cases", version: 2, hash: "a".repeat(64), createdAt: 1,
  cases: ["$& ${secret} {{input}} <img src=x>", "second", "third"].map((input, index) => ({ id: `case-${index}`, name: `Case ${index}`, input,
    sourceRunId: null, sourceSpanId: null, sourceOutput: null, tags: [], rules: [{ kind: "output", operation: "equals", value: "ok" }],
    sourceCapturedAt: null, sourceRedacted: false, sourceTruncated: false, sourceSnapshotVersion: null })) });
const draft = (extra: Record<string, unknown> = {}) => ({ datasetId: "dataset", version: 2, datasetHash: "a".repeat(64), endpointName: "registered", operationKey: "op-1",
  concurrency: 2, timeoutMs: 100, maxAttempts: 1, maxTotalCostUsd: 0, maxCostPerAttemptUsd: 0, allowSideEffects: true, ...extra });

describe("explicit frozen dataset execution core", () => {
  test("freezes literal inputs/options and creates a complete unique identity population", () => {
    const source = revision(), frozen = freezeExecution(source, parseExecutionDraft(draft()));
    source.cases[0].input = "mutated";
    expect(frozen.cases[0].case.input).toBe("$& ${secret} {{input}} <img src=x>");
    expect(frozen.cases).toHaveLength(3);
    expect(new Set(frozen.cases.flatMap(item => item.attempts.map(attempt => attempt.id))).size).toBe(3);
    expect(frozen.kind).toBe("registered_endpoint_execution");
    expect(frozen.cases.every(item => item.attempts[0].status === "not_started")).toBe(true);
  });
  test("rejects imported endpoint overrides and missing explicit permission before work", () => {
    expect(() => parseExecutionDraft(draft({ url: "http://127.0.0.1:9999" }))).toThrow();
    expect(() => parseExecutionDraft(draft({ allowSideEffects: false }))).toThrow();
    expect(() => freezeExecution(revision(), parseExecutionDraft(draft({ datasetHash: "b".repeat(64) })))).toThrow();
  });
  test("maximum reserve and concurrency bounds fail closed", () => {
    expect(() => parseExecutionDraft(draft({ concurrency: 3 }))).toThrow();
    expect(() => freezeExecution(revision(), parseExecutionDraft(draft({ maxAttempts: 3, maxTotalCostUsd: 1, maxCostPerAttemptUsd: .2 })))).toThrow();
  });
  test("failure/timeout retains all original cases and late settlements cannot complete timed out work", async () => {
    const frozen = freezeExecution(revision(), parseExecutionDraft(draft({ concurrency: 1 })));
    let late!: (value: { status: "transport_success"; runId: string | null; actualCostUsd: null }) => void;
    const result = await executeFrozen(frozen, async (_request, item) => {
      if (item.case.id === "case-0") throw new Error("raw provider credential never public");
      if (item.case.id === "case-1") return new Promise(resolve => { late = resolve; });
      return { status: "transport_success", runId: "fresh-run", actualCostUsd: null };
    });
    expect(result.cases).toHaveLength(3);
    expect(result.cases[0].attempts[0].status).toBe("failed");
    expect(result.cases[1].attempts[0].status).toBe("timed_out");
    late({ status: "transport_success", runId: "late", actualCostUsd: null });
    await Promise.resolve();
    expect(result.cases[1].attempts[0].runId).toBeNull();
    expect(JSON.stringify(result)).not.toContain("raw provider credential");
  });
  test("cancel keeps queued cases and prevents late publication", async () => {
    const controller = new AbortController();
    const frozen = freezeExecution(revision(), parseExecutionDraft(draft({ concurrency: 1 })));
    let finish!: (value: { status: "transport_success"; runId: string | null; actualCostUsd: null }) => void;
    const pending = executeFrozen(frozen, async () => new Promise(resolve => { finish = resolve; }), { signal: controller.signal });
    await Promise.resolve(); controller.abort(); const result = await pending;
    finish({ status: "transport_success", runId: "late", actualCostUsd: null }); await Promise.resolve();
    expect(result.status).toBe("cancelled");
    expect(result.cases).toHaveLength(3);
    expect(result.cases.every(item => item.attempts.every(attempt => attempt.status === "cancelled" && attempt.runId === null))).toBe(true);
  });
});

test("redacts every retained case before serialization and never dispatches unavailable input", async () => {
  const source = revision(); source.cases[0].input = '{"password":"private-fixture-credential"}';
  const frozen = freezeExecution(source, parseExecutionDraft(draft()));
  expect(JSON.stringify(frozen)).not.toContain("private-fixture-credential");
  let calls = 0;
  const result = await executeFrozen(frozen, async () => { calls++; return { status: "transport_success", runId: null, actualCostUsd: null }; });
  expect(calls).toBe(2); expect(result.cases[0].attempts[0].status).toBe("unavailable");
  expect(result.cases.every(item => item.grading.status === "inconclusive")).toBe(true);
});

test("planned retries remain visible with distinct attempt IDs and explicit side effects", async () => {
  const frozen = freezeExecution(revision(), parseExecutionDraft(draft({ maxAttempts: 3 })));
  let calls = 0;
  const result = await executeFrozen(frozen, async (_request, _item, attempt) => {
    calls++; return { status: attempt.index === 1 ? "transport_success" : "failed", runId: null, actualCostUsd: null };
  });
  expect(calls).toBe(6); expect(result.cases.flatMap(item => item.attempts)).toHaveLength(9);
  expect(result.cases[0].attempts.map(item => item.status)).toEqual(["failed", "transport_success", "not_started"]);
  expect(result.cases[0].attempts[2].sideEffects).toBe("not_dispatched");
});

test("actual private HTTP calls share two global slots and admission deadline retains every case", async () => {
  const requests: Array<{ attemptId: string; input: string }> = [];
  const responses: http.ServerResponse[] = [];
  let active = 0, maximum = 0;
  const server = http.createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk.toString();
    requests.push(JSON.parse(body)); responses.push(response); active++; maximum = Math.max(maximum, active);
    response.once("close", () => { active--; });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Private HTTP fixture unavailable");
  const slots = new DispatchSlots();
  try {
    const dispatch = async (_request: unknown, item: ReturnType<typeof freezeExecution>["cases"][number], attempt: ReturnType<typeof freezeExecution>["cases"][number]["attempts"][number]) => {
      // This URL is solely the private test injector. Production draft accepts only a registered name.
      const response = await fetch(`http://127.0.0.1:${address.port}/fixture`, { method: "POST", body: JSON.stringify({ attemptId: attempt.id, input: item.case.input }) });
      await response.text(); return { status: "transport_success" as const, runId: null, actualCostUsd: null };
    };
    const first = freezeExecution(revision(), parseExecutionDraft(draft({ operationKey: "http-1" })));
    const second = freezeExecution(revision(), parseExecutionDraft(draft({ operationKey: "http-2" })));
    const results = await Promise.all([executeFrozen(first, dispatch, { slots }), executeFrozen(second, dispatch, { slots })]);
    expect(maximum).toBe(2); expect(requests).toHaveLength(2); expect(new Set(requests.map(item => item.attemptId)).size).toBe(2);
    expect(requests.some(item => item.input === "$& ${secret} {{input}} <img src=x>")).toBe(true);
    expect(results.flatMap(item => item.cases)).toHaveLength(6);
    expect(results.flatMap(item => item.cases.flatMap(value => value.attempts)).every(item => item.status === "timed_out")).toBe(true);
    expect(slots.counts()).toEqual({ active: 2, queued: 0 });
    for (const response of responses) response.end("late completion");
    for (let index = 0; index < 50 && slots.counts().active; index++) await new Promise(resolve => setTimeout(resolve, 2));
    expect(slots.counts()).toEqual({ active: 0, queued: 0 });
    expect(results.every(item => item.cases.every(value => value.attempts.every(attempt => attempt.runId === null)))).toBe(true);
  } finally {
    for (const response of responses) response.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("publication revocation after slot admission returns the unhanded permit and original error", async () => {
  const frozen = freezeExecution({ ...revision(), cases: revision().cases.slice(0, 1) }, parseExecutionDraft(draft({ concurrency: 1, timeoutMs: 1000 })));
  const slots = new DispatchSlots(); let calls = 0, publications = 0;
  const authorityError = new Error("Owned publication authority revoked after slot admission");
  const rejected = await executeFrozen(frozen, async () => { calls++; return { status: "transport_success", runId: null, actualCostUsd: null }; }, {
    slots, publish() { if (++publications === 2) throw authorityError; },
  }).catch((cause: unknown) => cause);
  expect(rejected).toBe(authorityError);
  expect(calls).toBe(0); expect(publications).toBe(2); expect(slots.counts()).toEqual({ active: 0, queued: 0 });
});

test("initial publication failure clears its deadline and external abort listener", async () => {
  const controller = new AbortController(), slots = new DispatchSlots();
  const set = spyOn(globalThis, "setTimeout"), clear = spyOn(globalThis, "clearTimeout");
  const add = spyOn(controller.signal, "addEventListener"), remove = spyOn(controller.signal, "removeEventListener");
  try {
    const frozen = freezeExecution(revision(), parseExecutionDraft(draft({ timeoutMs: 1000 })));
    const authorityError = new Error("Initial authority unavailable");
    const rejected = await executeFrozen(frozen, async () => { throw new Error("Must not dispatch"); }, { slots, signal: controller.signal,
      publish() { throw authorityError; } }).catch((cause: unknown) => cause);
    expect(rejected).toBe(authorityError);
    expect(set).toHaveBeenCalledTimes(1); expect(clear).toHaveBeenCalledTimes(1);
    expect(clear.mock.calls[0][0] === set.mock.results[0].value).toBe(true);
    expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1]); expect(slots.counts()).toEqual({ active: 0, queued: 0 });
  } finally {
    for (const timer of set.mock.results) if (timer.type === "return") clearTimeout(timer.value);
    set.mockRestore(); clear.mockRestore(); add.mockRestore(); remove.mockRestore();
  }
});

test("asynchronous slot grant followed by revoked publication releases only that grant", async () => {
  const slots = new DispatchSlots(), controller = new AbortController();
  const first = (await slots.acquire(controller.signal))!, second = (await slots.acquire(controller.signal))!;
  const frozen = freezeExecution({ ...revision(), cases: revision().cases.slice(0, 1) }, parseExecutionDraft(draft({ concurrency: 1, timeoutMs: 1000 })));
  let calls = 0, publications = 0;
  const pending = executeFrozen(frozen, async () => { calls++; return { status: "transport_success", runId: null, actualCostUsd: null }; }, {
    slots, publish() { if (++publications === 2) throw new Error("Queued grant authority revoked"); },
  });
  const rejected = pending.then(() => null, cause => cause);
  try {
    expect(slots.counts()).toEqual({ active: 2, queued: 1 }); first();
    expect((await rejected as Error).message).toBe("Queued grant authority revoked");
    expect(calls).toBe(0); expect(slots.counts()).toEqual({ active: 1, queued: 0 });
  } finally { first(); second(); }
  expect(slots.counts()).toEqual({ active: 0, queued: 0 });
});

test("worker publication failure aborts and joins peers without releasing their actual held callbacks", async () => {
  const frozen = freezeExecution({ ...revision(), cases: revision().cases.slice(0, 2) }, parseExecutionDraft(draft({ timeoutMs: 1000 })));
  const slots = new DispatchSlots(); let publications = 0, calls = 0, signal: AbortSignal | undefined;
  const authorityError = new Error("Parallel publication owner revoked");
  let settle!: (value: { status: "transport_success"; runId: null; actualCostUsd: null }) => void;
  const pending = executeFrozen(frozen, async (_request, _item, _attempt, observedSignal) => {
    calls++; signal = observedSignal; return new Promise(resolve => { settle = resolve; });
  }, { slots, publish() { if (++publications === 3) throw authorityError; } });
  try {
    expect(await pending.catch((cause: unknown) => cause)).toBe(authorityError);
    expect(calls).toBe(1); expect(signal?.aborted).toBe(true); expect(slots.counts()).toEqual({ active: 1, queued: 0 });
    const rejectedPublications = publications;
    settle({ status: "transport_success", runId: null, actualCostUsd: null });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(slots.counts()).toEqual({ active: 0, queued: 0 }); expect(publications).toBe(rejectedPublications);
  } finally { settle?.({ status: "transport_success", runId: null, actualCostUsd: null }); }
});

test("first worker failure prevents a concurrently granted peer from starting its callback", async () => {
  const frozen = freezeExecution({ ...revision(), cases: revision().cases.slice(0, 2) }, parseExecutionDraft(draft({ timeoutMs: 1000 })));
  const slots = new DispatchSlots(); let calls = 0, publications = 0;
  const authorityError = new Error("First worker authority revoked");
  const rejected = await executeFrozen(frozen, async () => { calls++; return { status: "transport_success", runId: null, actualCostUsd: null }; }, {
    slots, publish() { if (++publications === 2) throw authorityError; },
  }).catch((cause: unknown) => cause);
  expect(rejected).toBe(authorityError);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(calls).toBe(0); expect(publications).toBe(2); expect(slots.counts()).toEqual({ active: 0, queued: 0 });
});
