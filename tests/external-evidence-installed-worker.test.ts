import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
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
    const buildTimer = setTimeout(() => build.kill("SIGKILL"), 15_000);
    try {
      const [exit, output, errors] = await Promise.all([build.exited, readBoundedStream(build.stdout, 128 * 1024), readBoundedStream(build.stderr, 128 * 1024)]);
      expect({ exit, output: new TextDecoder().decode(output), errors: new TextDecoder().decode(errors) }).toMatchObject({ exit: 0 });
    } finally { clearTimeout(buildTimer); if (build.exitCode === null) build.kill("SIGKILL"); await build.exited; }
    const cwd = join(directory, "empty-state"), profile = join(directory, "private-profile"); await mkdir(cwd); await mkdir(profile);
    const validXml = '<testsuite><testcase name="one"/></testsuite>';
    const positiveFixtures = [{ xml: validXml, env: evidenceWorkerLaunchEnv() }, { xml: '<testsuite><testcase></testsuite>', env: evidenceWorkerLaunchEnv() }];
    for (const key of ["SystemRoot", "SYSTEMROOT", "systemroot", "sYsTeMrOoT"]) {
      const env = evidenceWorkerLaunchEnv(), value = env.SystemRoot ?? "f03-synthetic-system-root"; delete env.SystemRoot; env[key] = value;
      positiveFixtures.push({ xml: validXml, env });
    }
    for (const { xml, env } of positiveFixtures) {
      const child = Bun.spawn([executable], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      try {
        await child.stdin.write(JSON.stringify({ version: 1, id: "installed", sourceId: "one", dialect: "junit-xml/v1", limits: DEFAULT_READER_LIMITS, bytes: Buffer.from(xml).toString("base64") }));
        await child.stdin.end();
        const [out, err, exit] = await Promise.all([readBoundedStream(child.stdout, 5 * 1024 * 1024), readBoundedStream(child.stderr, 4096), child.exited]);
        const normalized = JSON.parse(new TextDecoder().decode(out)).normalized;
        expect(exit).toBe(0); expect(err.byteLength).toBe(0);
        expect(normalized.reportOutcome).toBe(xml.includes("name=") ? "reports_pass" : "unknown");
        expect(() => process.kill(child.pid, 0)).toThrow();
        expect(await readdir(cwd)).toEqual([]); expect(await readdir(profile, { recursive: true })).toEqual([]);
      } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    }
    const unicodeEnvs = ["\u017fYSTEMROOT", "SY\u017fTEMROOT", "SY\ufb05EMROOT", "SY\ufb06EMROOT"].flatMap(key =>
      ["", "f03-synthetic-secret"].map(value => ({ ...evidenceWorkerLaunchEnv(), [key]: value })));
    for (const env of [...unicodeEnvs, { ...evidenceWorkerLaunchEnv(), HOME: profile }, { ...evidenceWorkerLaunchEnv(), USERPROFILE: profile },
      { ...evidenceWorkerLaunchEnv(), hOmE: profile }, { ...evidenceWorkerLaunchEnv(), UNKNOWN_EMPTY: "" },
      { ...evidenceWorkerLaunchEnv(), PATH: profile }, { ...evidenceWorkerLaunchEnv(), oPeNaI_aPi_KeY: "f03-synthetic-secret" },
      { ...evidenceWorkerLaunchEnv(), rUnPhAnToM_dB_pAtH: join(profile, "local.db") },
      { ...evidenceWorkerLaunchEnv(), rUnPhAnToM_tEaM_dAtA_dIr: join(profile, "team") },
      { ...evidenceWorkerLaunchEnv(), BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(profile, "custom-cache") }]) {
      const child = Bun.spawn([executable], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      try {
        if (unicodeEnvs.includes(env)) {
          await child.stdin.write(JSON.stringify({ version: 1, id: "installed", sourceId: "one", dialect: "junit-xml/v1", limits: DEFAULT_READER_LIMITS, bytes: Buffer.from(validXml).toString("base64") }));
          await child.stdin.end();
        }
        const [out, err, exit] = await Promise.all([readBoundedStream(child.stdout, 4096), readBoundedStream(child.stderr, 4096), child.exited]);
        expect(exit).toBe(1); expect(err.byteLength).toBe(0);
        expect(JSON.parse(new TextDecoder().decode(out))).toEqual({ version: 1, id: null, error: "protocol_invalid" });
        expect(() => process.kill(child.pid, 0)).toThrow();
        expect(await readdir(cwd)).toEqual([]); expect(await readdir(profile, { recursive: true })).toEqual([]);
      } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
