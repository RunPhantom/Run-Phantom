import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createEndpoint, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

type ReplayEvent = { type: string; replayRunId?: string; code?: string };
type Attempt = { body: { replayRunId: string; sourceRunId: string }; response: ServerResponse };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 10));

async function qualify(scenario: string) {
  const { createServer } = await import("../src/server");
  const { closeDb, findRunByEventId } = await import("../src/db");
  const { getReplayTrace, _replayTraceMapSize } = await import("../src/replay-map");
  const daemon = await createServer(0);
  daemon.server.listen(0, "127.0.0.1"); await once(daemon.server, "listening");
  const base = `http://127.0.0.1:${daemon.port}`;
  const attempts: Attempt[] = [];
  const endpoint = createEndpoint((incoming, response) => {
    if (incoming.url === "/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, eventName: "attribution-fixture", cwd: path.dirname(process.env.RUNPHANTOM_DB_PATH!), command: "bun --version" }));
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      attempts.push({ body: JSON.parse(Buffer.concat(chunks).toString()), response });
    })().catch(error => { response.statusCode = 500; response.end(String(error)); });
  });
  endpoint.listen(0, "127.0.0.1"); await once(endpoint, "listening");
  const endpointPort = (endpoint.address() as { port: number }).port;
  const request = async (route: string, data?: unknown, method = data === undefined ? "GET" : "POST") =>
    fetch(base + route, { method, headers: { "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const exported = async (id: string) => {
    const response = await request(`/api/runs/${id}/export`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const id = (index: number) => index.toString(16).padStart(32, "0");
  const at = Date.now();
  const span = (index: number, replayId?: string, eventId?: string, replay = true) => ({
    traceId: id(index), spanId: index.toString(16).padStart(16, "0"), name: "Attribution fixture",
    startTimeUnixNano: String(BigInt(at + index) * 1_000_000n), endTimeUnixNano: String(BigInt(at + index + 1) * 1_000_000n),
    status: { code: 1 }, attributes: Object.entries({
      "runphantom.event.name": replay ? "replay:attribution-fixture" : "attribution-fixture",
      "ai.operationId": "ai.generateText.doGenerate", "ai.model.id": "controlled-local-fixture",
      "ai.prompt.messages": '[{"role":"user","content":"Qualify replay identity"}]',
      "ai.response.text": `Controlled endpoint output ${index}`,
      ...(replayId ? { "runphantom.replay.run_id": replayId } : {}),
      ...(eventId ? { "runphantom.event.id": eventId } : {}),
    }).map(([key, value]) => ({ key, value: { stringValue: value } })),
  });
  const ingest = async (spans: ReturnType<typeof span>[]) => {
    const response = await request("/v1/traces", { resourceSpans: [{ scopeSpans: [{ spans }] }] });
    assert.equal(response.status, 200);
  };
  const wait = async (predicate: () => boolean) => {
    for (let step = 0; step < 500; step++) { if (predicate()) return; await pause(); }
    throw new Error("Controlled replay fixture did not reach the expected boundary");
  };
  const start = async (signal?: AbortSignal) => {
    const response = await fetch(base + "/api/replay", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: id(1) }), signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const events: ReplayEvent[] = [];
    const done = (async () => {
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
          for (const line of lines) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        }
      } finally { reader.releaseLock(); }
    })();
    return { events, done };
  };
  const release = (attempt: Attempt) => {
    attempt.response.setHeader("Content-Type", "application/json");
    attempt.response.end(JSON.stringify({ status: "ok", replayId: attempt.body.replayRunId }));
  };
  const realNow = Date.now;
  try {
    const restartRecord = path.join(path.dirname(process.env.RUNPHANTOM_DB_PATH!), "restart-expected.json");
    if (scenario === "restart") {
      const expected = JSON.parse(readFileSync(restartRecord, "utf8"));
      assert.equal(_replayTraceMapSize(), 0);
      for (const previous of expected.exports) {
        assert.deepEqual(await exported(previous.run.id), previous);
        if (previous.run.event_id) assert.deepEqual(findRunByEventId(previous.run.event_id), { id: previous.run.id });
      }
      console.log(JSON.stringify({ scenario, freshProcessCacheSize: 0, priorScenario: expected.scenario,
        persistedRuns: expected.exports.map((item: { run: { id: string } }) => item.run.id), exportsUnchanged: true }));
      return;
    }
    assert.equal((await request("/api/agents", { "attribution-fixture": { url: `http://127.0.0.1:${endpointPort}/replay` } }, "PUT")).status, 200);
    await ingest([span(1, undefined, undefined, false)]);
    const source = await exported(id(1));
    if (scenario === "capacity") {
      const replay = await start(); await wait(() => attempts.length === 1);
      const placeholder = attempts[0].body.replayRunId;
      await ingest([span(2, placeholder, placeholder)]);
      assert.equal(getReplayTrace(placeholder), id(2));
      await ingest([span(2, placeholder, placeholder), ...Array.from({ length: 1001 }, (_, index) =>
        span(index + 10, `pressure-${index}`, `pressure-${index}`))]);
      assert.equal(_replayTraceMapSize(), 1000);
      assert.equal(getReplayTrace(placeholder), undefined);
      assert.deepEqual(findRunByEventId(placeholder), { id: id(2) });
      const unrelated = await exported(id(1010));
      release(attempts[0]); await replay.done;
      const output = await exported(id(2));
      assert.equal(replay.events.find(event => event.type === "replay_complete")?.replayRunId, id(2));
      assert.equal(JSON.parse(output.run.metadata).replay.sourceRunId, id(1));
      assert.equal(output.spans[0].output_payload, "Controlled endpoint output 2");
      assert.equal((await request(`/api/runs/${placeholder}/export`)).status, 404);
      assert.deepEqual(await exported(id(1010)), unrelated);
      assert.deepEqual(await exported(id(1)), source);
      writeFileSync(restartRecord, JSON.stringify({ scenario, exports: [source, output, unrelated] }));
      console.log(JSON.stringify({ scenario, cacheSize: _replayTraceMapSize(), cacheMiss: true, databaseIdentity: id(2),
        events: replay.events, output: output.spans[0].output_payload, unrelatedUnchanged: true, sourceUnchanged: true }));
    } else if (scenario === "cancelled-late" || scenario === "cancelled-poll") {
      const controller = new AbortController();
      const first = await start(controller.signal); await wait(() => attempts.length === 1);
      const cancelled = attempts[0].body.replayRunId;
      const second = await start(); await wait(() => attempts.length === 2);
      if (scenario === "cancelled-poll") {
        release(attempts[0]);
        await wait(() => first.events.some(event => event.type === "agent_started"));
      }
      controller.abort(); await first.done.catch(() => {});
      for (let step = 0; step < 500; step++) {
        const placeholder = await exported(cancelled);
        if (JSON.parse(placeholder.run.metadata).replay.error?.code === "replay_cancelled") break;
        if (step === 499) throw new Error("Cancelled replay was not persisted");
        await pause();
      }
      const stopped = await exported(cancelled);
      await ingest([span(3, attempts[1].body.replayRunId, attempts[1].body.replayRunId)]);
      release(attempts[1]); await second.done;
      const completed = await exported(id(3));
      await ingest([span(2, cancelled, cancelled)]);
      assert.equal(getReplayTrace(cancelled), id(2));
      assert.deepEqual(await exported(cancelled), stopped);
      assert.equal(stopped.spans.length, 0);
      assert.equal(JSON.parse(stopped.run.metadata).replay.error.code, "replay_cancelled");
      assert.equal(first.events.some(event => event.type === "replay_complete"), false);
      assert.equal(second.events.find(event => event.type === "replay_complete")?.replayRunId, id(3));
      assert.deepEqual(await exported(id(3)), completed);
      const late = await exported(id(2));
      assert.equal(late.run.metadata, null);
      assert.equal(late.spans[0].output_payload, "Controlled endpoint output 2");
      assert.deepEqual(await exported(id(1)), source);
      writeFileSync(restartRecord, JSON.stringify({ scenario, exports: [source, stopped, completed, late] }));
      console.log(JSON.stringify({ scenario, cancelled, lateTrace: id(2), completedTrace: id(3),
        events: second.events, cancelledUnchanged: true, completedUnchanged: true, lateEvidenceNotPromoted: true }));
    } else if (scenario === "ambiguous-deadline") {
      const first = await start(); await wait(() => attempts.length === 1);
      const second = await start(); await wait(() => attempts.length === 2);
      await ingest([span(2), span(3)]);
      const unrelated = [await exported(id(2)), await exported(id(3))];
      release(attempts[1]); release(attempts[0]);
      await wait(() => first.events.some(event => event.type === "agent_started") && second.events.some(event => event.type === "agent_started"));
      // Only the child clock advances: real HTTP, SQLite and 500ms poll timers
      // still execute. This qualifies expiry semantics, not 120s wall latency.
      Date.now = () => realNow() + 120_001;
      await Promise.all([first.done, second.done]); Date.now = realNow;
      const actual = [first.events, second.events];
      console.log(JSON.stringify({ scenario, clock: "controlled deadline; real poll timers", attempts: attempts.map(item => item.body), events: actual }));
      for (const events of actual) {
        assert.equal(events.some(event => event.type === "replay_complete"), false, "A nearby trace is not replay identity");
        assert.equal(events.find(event => event.type === "error")?.code, "replay_timeout");
      }
      for (const attempt of attempts) {
        const placeholder = await exported(attempt.body.replayRunId);
        assert.equal(JSON.parse(placeholder.run.metadata).replay.error.code, "replay_timeout");
        assert.equal(placeholder.spans.length, 0);
      }
      assert.deepEqual([await exported(id(2)), await exported(id(3))], unrelated);
      assert.deepEqual(await exported(id(1)), source);
    } else throw new Error(`Unknown replay qualification scenario: ${scenario}`);
  } finally {
    Date.now = realNow;
    endpoint.closeAllConnections(); daemon.server.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => endpoint.close(() => resolve())),
      new Promise<void>(resolve => daemon.server.close(() => resolve()))]);
    closeDb();
  }
}

if (process.argv.includes("--replay-qualification-child")) {
  try { await qualify(process.argv.at(-1)!); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
} else {
  for (const [scenario, title] of [
    ["capacity", "R22: actual ingest pressure evicts the cache but exact persisted identity completes the correct replay"],
    ["cancelled-late", "R23: a cancelled HTTP replay stays terminal when its delayed evidence arrives after another attempt completes"],
    ["cancelled-poll", "R23: cancellation after endpoint acceptance interrupts real correlation polling and fences delayed evidence"],
    ["ambiguous-deadline", "R23: two expired attempts never promote nearby same-name traces without identity"],
  ]) test(title, async () => {
    const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-replay-attribution-"));
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith("RUNPHANTOM_") && key !== "ANTHROPIC_API_KEY" && key !== "OPENAI_API_KEY"));
    const runChild = async (phase: string) => {
      const child = spawn("bun", [import.meta.path, "--replay-qualification-child", phase], {
        cwd: path.resolve(import.meta.dir, ".."), env: { ...inherited, HOME: directory, USERPROFILE: directory,
          RUNPHANTOM_DB_PATH: path.join(directory, "qualification.db"), RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json"),
          RUNPHANTOM_CLAUDE_CLI_CHAT: "0", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", data => { output += String(data); }); child.stderr.on("data", data => { output += String(data); });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const [code] = await once(child, "close");
        if (process.env.F09_EVIDENCE_PATH) writeFileSync(path.join(process.env.F09_EVIDENCE_PATH, `${scenario}-${phase}.log`), output);
        expect(code, output).toBe(0);
      } finally { clearTimeout(deadline); }
    };
    try {
      await runChild(scenario);
      if (scenario !== "ambiguous-deadline") await runChild("restart");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 15_000);
}
