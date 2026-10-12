import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceWorkerLaunchEnv, WINDOWS_WORKER_BOOTSTRAP_KEYS } from "../src/evaluations/evidence-worker-environment";
import { DEFAULT_READER_LIMITS } from "../src/evaluations/evidence-reader/limits";
import { EvidenceSupervisor } from "../src/evaluations/evidence-supervisor";
import { EVIDENCE_WORKER_ENTRY, readBoundedStream } from "../src/evaluations/evidence-worker";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const xml = '<testsuite><testcase name="one"/></testsuite>';
const input = (bytes: string) => JSON.stringify({ version: 1, id: "installed", sourceId: "one", dialect: "junit-xml/v1",
  limits: DEFAULT_READER_LIMITS, bytes: Buffer.from(bytes).toString("base64") });
const minimalEnv = evidenceWorkerLaunchEnv;
async function expectNoAuthorityState(cwd: string, profile: string) {
  expect(await readdir(cwd)).toEqual([]);
  expect(await readdir(profile, { recursive: true })).toEqual([]);
}

async function qualify(command: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "runphantom-f03-cli-"));
  const cwd = join(directory, "empty-state"), profile = join(directory, "private-profile");
  await mkdir(cwd); await mkdir(profile);
  try {
    if (process.platform === "win32") {
      const probe = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e",
        "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"],
      { cwd, env: minimalEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => probe.kill("SIGKILL"), 3_000);
      try {
        const [out, err, exit] = await Promise.all([readBoundedStream(probe.stdout, 4096), readBoundedStream(probe.stderr, 4096), probe.exited]);
        expect(exit).toBe(0); expect(err.byteLength).toBe(0);
        console.info("F03 minimal native boot environment keys", new TextDecoder().decode(out));
        expect(() => process.kill(probe.pid, 0)).toThrow();
      } finally { clearTimeout(timer); if (probe.exitCode === null) probe.kill("SIGKILL"); await probe.exited; }
    }
    const cases: { args: string[]; env: Record<string, string>; input: string; exit: number;
      outcome?: string; error?: boolean; empty?: boolean; leaveOpen?: boolean }[] = [
      { args: [], env: minimalEnv(), input: input(xml), exit: 0, outcome: "reports_pass" },
      { args: [], env: minimalEnv(), input: input("<testsuite><testcase></testsuite>"), exit: 0, outcome: "unknown" },
      { args: [], env: minimalEnv(), input: '{"version":1,"path":"/must-not-open"}', exit: 1, error: true },
      { args: [], env: minimalEnv(), input: JSON.stringify({ ...JSON.parse(input(xml)), limits: [] }), exit: 1, error: true },
      { args: [], env: minimalEnv(), input: JSON.stringify({ ...JSON.parse(input(xml)), limits: 0 }), exit: 1, error: true },
      { args: [], env: minimalEnv(), input: JSON.stringify({ ...JSON.parse(input(xml)), limits: { toString: 1 } }), exit: 1, error: true },
      { args: [], env: { ...minimalEnv(), PHANTOM_SYNTHETIC_SECRET: "f03-synthetic-secret", HOME: profile, USERPROFILE: profile,
        RUNPHANTOM_DB_PATH: join(profile, "local.db"), RUNPHANTOM_TEAM_DATA_DIR: join(profile, "team") },
        input: input(xml), exit: 1, error: true },
      { args: ["team", "serve"], env: minimalEnv(), input: "", exit: 1, empty: true },
      { args: ["serve"], env: { ...minimalEnv(), HOME: profile, USERPROFILE: profile, RUNPHANTOM_DB_PATH: join(profile, "local.db") },
        input: "", exit: 1, empty: true },
    ];
    for (const key of ["HOME", "hOmE", "OPENAI_API_KEY", "oPeNaI_aPi_KeY", "ANTHROPIC_API_KEY", "RUNPHANTOM_DB_PATH", "rUnPhAnToM_dB_pAtH", "RUNPHANTOM_TEAM_DATA_DIR", "rUnPhAnToM_tEaM_dAtA_dIr", "UNKNOWN_EMPTY"]) {
      for (const value of ["", profile]) cases.push({ args: [], env: { ...minimalEnv(), [key]: value }, input: "", exit: 1, error: true, leaveOpen: true });
    }
    for (const key of ["SystemRoot", "SYSTEMROOT", "systemroot", "sYsTeMrOoT"]) {
      const env = minimalEnv(), value = env.SystemRoot ?? "f03-synthetic-system-root"; delete env.SystemRoot; env[key] = value;
      cases.push({ args: [], env, input: input(xml), exit: 0, outcome: "reports_pass" });
    }
    for (const key of ["\u017fYSTEMROOT", "SY\u017fTEMROOT", "SY\ufb05EMROOT", "SY\ufb06EMROOT"]) {
      for (const value of ["", "f03-synthetic-secret"]) cases.push({ args: [], env: { ...minimalEnv(), [key]: value }, input: input(xml), exit: 1, error: true });
    }
    for (const key of WINDOWS_WORKER_BOOTSTRAP_KEYS) {
      cases.push({ args: [], env: { ...minimalEnv(), [key]: "f03-synthetic-default" }, input: "", exit: 1, error: true, leaveOpen: true });
      const alias = minimalEnv(); delete alias[key]; alias[key.toLowerCase()] = "f03-synthetic-default";
      cases.push({ args: [], env: alias, input: "", exit: 1, error: true, leaveOpen: true });
    }
    for (const value of ["", "1", join(profile, "custom-cache")]) {
      cases.push({ args: [], env: { ...minimalEnv(), BUN_RUNTIME_TRANSPILER_CACHE_PATH: value }, input: "", exit: 1, error: true, leaveOpen: true });
    }
    const uncachedProfile: Record<string, string> = { ...minimalEnv(), HOME: profile }; delete uncachedProfile.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
    cases.push({ args: [], env: uncachedProfile, input: "", exit: 1, error: true, leaveOpen: true });
    for (const fixture of cases) {
      const child = Bun.spawn([...command, EVIDENCE_WORKER_ENTRY, ...fixture.args], { cwd, env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 3_000);
      try {
        if (!fixture.leaveOpen) { await child.stdin.write(fixture.input); await child.stdin.end(); }
        const [out, err, exit] = await Promise.all([readBoundedStream(child.stdout, 256 * 1024), readBoundedStream(child.stderr, 64 * 1024), child.exited]);
        const stdout = new TextDecoder().decode(out);
        expect(exit).toBe(fixture.exit); expect(new TextDecoder().decode(err)).toBe("");
        if (fixture.empty) expect(stdout).toBe("");
        else if (fixture.error) expect(JSON.parse(stdout)).toEqual({ version: 1, id: null, error: "protocol_invalid" });
        else {
          const response = JSON.parse(stdout);
          expect(response.id).toBe("installed"); expect(response.normalized.reportOutcome).toBe(fixture.outcome);
          if (fixture.outcome === "unknown") expect(response.normalized.parseState).toBe("unparsed");
        }
        expect(stdout).not.toContain("f03-synthetic-secret");
        expect(() => process.kill(child.pid, 0)).toThrow();
        await expectNoAuthorityState(cwd, profile);
      } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    }
    const supervisor = new EvidenceSupervisor({ workerFactory: () => Bun.spawn([...command, EVIDENCE_WORKER_ENTRY],
      { cwd, env: minimalEnv(), stdin: "pipe", stdout: "pipe", stderr: "ignore" }) });
    try {
      const result = await supervisor.submit({ jobId: "installed-import", publicationToken: "installed-token", scopeGeneration: 2,
        sources: [{ sourceId: "one", dialect: "junit-xml/v1", bytes: new TextEncoder().encode(xml) }] }).result;
      expect(result.sources[0].reportOutcome).toBe("reports_pass"); expect(result.workers).toHaveLength(1);
      expect(result.publicationToken).toBe("installed-token");
      expect(() => process.kill(result.workers[0].pid, 0)).toThrow();
      await expectNoAuthorityState(cwd, profile);
    } finally { await supervisor.shutdown(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("source CLI dispatch isolates the reader before local/team startup and refuses extra arguments", async () => {
  await qualify([process.execPath, "--no-env-file", "--no-install", entry]);
}, 25_000);

// Qualification supplies the exact artifact produced by scripts/build-bun.ts; a source or worker-only binary is insufficient.
test.skipIf(!process.env.RUNPHANTOM_F03_TEST_BINARY)("shipped CLI worker executes outside the checkout without DB, daemon or source fallback", async () => {
  await qualify([resolve(process.env.RUNPHANTOM_F03_TEST_BINARY!)]);
}, 25_000);
