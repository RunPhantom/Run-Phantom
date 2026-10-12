import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { evidenceWorkerLaunchEnv } from "../src/evaluations/evidence-worker-environment";
import { DEFAULT_READER_LIMITS } from "../src/evaluations/evidence-reader/limits";
import { readBoundedStream } from "../src/evaluations/evidence-worker";

const entry = fileURLToPath(new URL("../src/evaluations/evidence-worker.ts", import.meta.url));
async function worker(request: unknown, env: Record<string, string> = evidenceWorkerLaunchEnv()) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", entry], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  await child.stdin.write(JSON.stringify(request));
  await child.stdin.end();
  const output = await readBoundedStream(child.stdout, 5 * 1024 * 1024), exit = await child.exited;
  return { exit, pid: child.pid, output: JSON.parse(new TextDecoder().decode(output)) };
}
const request = { version: 1, id: "request-1", sourceId: "source-1", dialect: "junit-xml/v1", limits: DEFAULT_READER_LIMITS,
  bytes: Buffer.from('<testsuite><testcase name="one"/></testsuite>').toString("base64") };
test("actual worker parses bytes and exits without daemon state", async () => {
  const result = await worker(request);
  expect(result.exit).toBe(0);
  expect(result.output.id).toBe(request.id);
  expect(result.output.normalized.reportOutcome).toBe("reports_pass");
  expect(() => process.kill(result.pid, 0)).toThrow();
});
test("closed worker protocol refuses authority, paths and invalid byte encodings", async () => {
  for (const invalid of [{ ...request, path: "/untrusted" }, { ...request, scope: "local" }, { ...request, bytes: "not base64!" }, { ...request, limits: { ...DEFAULT_READER_LIMITS, maxSourceBytes: 999_999_999 } }]) {
    const result = await worker(invalid);
    expect(result.exit).toBe(1);
    expect(result.output).toEqual({ version: 1, id: null, error: "protocol_invalid" });
  }
});
test("actual worker rejects nonrecord and inherited-name limit fields while allowing empty defaults", async () => {
  for (const limits of [[], 0, "", null, { toString: 1 }, { constructor: 1 }, { maxDepth: 0 }, { maxLeaves: 1.5 }]) {
    const result = await worker({ ...request, limits });
    expect(result.exit).toBe(1); expect(result.output).toEqual({ version: 1, id: null, error: "protocol_invalid" });
    expect(() => process.kill(result.pid, 0)).toThrow();
  }
  const empty = await worker({ ...request, limits: {} });
  expect(empty.exit).toBe(0); expect(empty.output.normalized.reportOutcome).toBe("reports_pass");
});
test("stream output is bounded before concatenating an excessive message", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1025)); controller.close(); } });
  expect(await readBoundedStream(stream, 1024).catch(error => error.message)).toBe("worker_stream_limit");
});
test("actual process rejects inherited ambient credentials without exposing values", async () => {
  const result = await worker(request, { ...evidenceWorkerLaunchEnv(), PHANTOM_SYNTHETIC_SECRET: "never-expose-this-fixture-value" });
  expect(result.exit).toBe(1);
  expect(result.output).toEqual({ version: 1, id: null, error: "protocol_invalid" });
});
