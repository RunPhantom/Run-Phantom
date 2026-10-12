import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceWorkerLaunchEnv } from "../src/evaluations/evidence-worker-environment";
import { DEFAULT_READER_LIMITS } from "../src/evaluations/evidence-reader/limits";
import { readBoundedStream } from "../src/evaluations/evidence-worker";

test("native standalone worker binary parses outside the checkout without a Bun or source fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runphantom-f03-worker-"));
  const executable = join(directory, process.platform === "win32" ? "reader.exe" : "reader");
  const entry = fileURLToPath(new URL("../src/evaluations/evidence-worker.ts", import.meta.url));
  try {
    const build = Bun.spawn([process.execPath, "build", "--compile", "--minify", entry, "--outfile", executable], { stdout: "pipe", stderr: "pipe" });
    const [exit, output, errors] = await Promise.all([build.exited, readBoundedStream(build.stdout, 128 * 1024), readBoundedStream(build.stderr, 128 * 1024)]);
    expect({ exit, output: new TextDecoder().decode(output), errors: new TextDecoder().decode(errors) }).toMatchObject({ exit: 0 });
    const cwd = join(directory, "empty-state"); await mkdir(cwd);
    for (const xml of ['<testsuite><testcase name="one"/></testsuite>', '<testsuite><testcase></testsuite>']) {
      const env = evidenceWorkerLaunchEnv();
      const child = Bun.spawn([executable], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      await child.stdin.write(JSON.stringify({ version: 1, id: "installed", sourceId: "one", dialect: "junit-xml/v1", limits: DEFAULT_READER_LIMITS, bytes: Buffer.from(xml).toString("base64") }));
      await child.stdin.end();
      const normalized = JSON.parse(new TextDecoder().decode(await readBoundedStream(child.stdout, 5 * 1024 * 1024))).normalized;
      expect(await child.exited).toBe(0);
      expect(normalized.reportOutcome).toBe(xml.includes("name=") ? "reports_pass" : "unknown");
      expect(() => process.kill(child.pid, 0)).toThrow();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
