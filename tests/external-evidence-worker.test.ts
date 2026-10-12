import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceWorkerLaunchEnv } from "../src/evaluations/evidence-worker-environment";
import { DEFAULT_READER_LIMITS } from "../src/evaluations/evidence-reader/limits";
import { readBoundedStream } from "../src/evaluations/evidence-worker";

const entry = fileURLToPath(new URL("../src/evaluations/evidence-worker.ts", import.meta.url));
async function worker(request: unknown, env: Record<string, string> = evidenceWorkerLaunchEnv()) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", entry], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  try {
    await child.stdin.write(JSON.stringify(request));
    await child.stdin.end();
    const output = await readBoundedStream(child.stdout, 5 * 1024 * 1024), exit = await child.exited;
    return { exit, pid: child.pid, output: JSON.parse(new TextDecoder().decode(output)) };
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
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

test("standalone source refuses ambient authority before parser loading or stdin access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runphantom-f03-source-"));
  const cwd = join(directory, "state"), profile = join(directory, "profile");
  await mkdir(cwd); await mkdir(profile);
  try {
    const withoutCache: Record<string, string> = { ...evidenceWorkerLaunchEnv(), HOME: profile }; delete withoutCache.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
    const fixtures = [withoutCache, { ...evidenceWorkerLaunchEnv(), HOME: profile },
      { ...evidenceWorkerLaunchEnv(), hOmE: profile }, { ...evidenceWorkerLaunchEnv(), UNKNOWN_EMPTY: "" },
      { ...evidenceWorkerLaunchEnv(), USERPROFILE: profile }, { ...evidenceWorkerLaunchEnv(), PATH: profile },
      { ...evidenceWorkerLaunchEnv(), oPeNaI_aPi_KeY: "f03-synthetic-secret" },
      { ...evidenceWorkerLaunchEnv(), rUnPhAnToM_dB_pAtH: join(profile, "local.db") },
      { ...evidenceWorkerLaunchEnv(), rUnPhAnToM_tEaM_dAtA_dIr: join(profile, "team") },
      { ...evidenceWorkerLaunchEnv(), BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(profile, "custom-cache") }];
    for (const env of fixtures) {
      const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", entry], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      try {
        // Leave stdin open: rejection must happen before requesting report bytes.
        const [out, err, exit] = await Promise.all([readBoundedStream(child.stdout, 4096), readBoundedStream(child.stderr, 4096), child.exited]);
        expect(exit).toBe(1); expect(err.byteLength).toBe(0);
        expect(JSON.parse(new TextDecoder().decode(out))).toEqual({ version: 1, id: null, error: "protocol_invalid" });
        expect(() => process.kill(child.pid, 0)).toThrow();
        expect(await readdir(cwd)).toEqual([]); expect(await readdir(profile, { recursive: true })).toEqual([]);
      } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);
