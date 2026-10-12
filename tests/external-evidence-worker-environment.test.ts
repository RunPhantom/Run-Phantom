import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readBoundedStream } from "../src/evaluations/evidence-worker";
import { evidenceWorkerLaunchEnv, finishEvidenceWorkerEnvironment, prepareEvidenceWorkerEnvironment,
  WINDOWS_WORKER_BOOTSTRAP_KEYS } from "../src/evaluations/evidence-worker-environment";

const cacheKey = "BUN_RUNTIME_TRANSPILER_CACHE_PATH";
const operational = { LANG: "C.UTF-8", TZ: "UTC", SystemRoot: "C:\\Windows" };
const windowsBoot = () => evidenceWorkerLaunchEnv("win32", operational.SystemRoot);
function expectAtomicRefusal(env: Record<string, string>, platform: NodeJS.Platform = "win32") {
  const before = Object.getOwnPropertyDescriptors(env);
  expect(prepareEvidenceWorkerEnvironment(env, platform)).toBe(false);
  expect(Object.getOwnPropertyDescriptors(env)).toEqual(before);
}

describe("worker bootstrap is narrower than operational authority", () => {
  test("the launch environment disables pre-JavaScript caching and suppresses only ten injected Windows defaults", () => {
    expect(WINDOWS_WORKER_BOOTSTRAP_KEYS).toEqual(["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"]);
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const env = evidenceWorkerLaunchEnv(platform, operational.SystemRoot);
      expect(env[cacheKey]).toBe("0");
      expect(Object.keys(env).sort()).toEqual((platform === "win32"
        ? [...WINDOWS_WORKER_BOOTSTRAP_KEYS, "LANG", "TZ", "SystemRoot", cacheKey] : ["LANG", "TZ", cacheKey]).sort());
      for (const key of WINDOWS_WORKER_BOOTSTRAP_KEYS) {
        if (platform === "win32") expect(env[key]).toBe(""); else expect(env[key]).toBeUndefined();
      }
    }
  });
  test("empty Windows placeholders are removed atomically while caching remains disabled through imports", () => {
    const env = windowsBoot();
    expect(prepareEvidenceWorkerEnvironment(env, "win32")).toBe(true);
    expect(env).toEqual({ ...operational, [cacheKey]: "0" });
    expect(prepareEvidenceWorkerEnvironment(env, "win32")).toBe(true);
    expect(env[cacheKey]).toBe("0");
    expect(finishEvidenceWorkerEnvironment(env, "win32")).toBe(true);
    expect(env).toEqual(operational);
    expect(finishEvidenceWorkerEnvironment(env, "win32")).toBe(true);
    expect(prepareEvidenceWorkerEnvironment(env, "win32")).toBe(true);
  });
  test("nonempty defaults, unknown empty keys and authority aliases refuse before any cleanup", () => {
    for (const key of WINDOWS_WORKER_BOOTSTRAP_KEYS) expectAtomicRefusal({ ...windowsBoot(), [key]: "synthetic-nonempty" });
    for (const key of ["HOME", "hOmE", "OPENAI_API_KEY", "oPeNaI_aPi_KeY", "ANTHROPIC_API_KEY", "RUNPHANTOM_DB_PATH", "rUnPhAnToM_dB_pAtH", "RUNPHANTOM_TEAM_DATA_DIR", "rUnPhAnToM_tEaM_dAtA_dIr", "UNRECOGNIZED", "unknown_empty"]) {
      for (const value of ["", "synthetic-authority"]) expectAtomicRefusal({ ...windowsBoot(), [key]: value });
    }
    for (const value of ["", "1", "/untrusted/cache", "0 "]) expectAtomicRefusal({ ...windowsBoot(), [cacheKey]: value });
  });
  test("Windows spelling aliases allow empty sentinels, never nonempty defaults", () => {
    for (const key of WINDOWS_WORKER_BOOTSTRAP_KEYS) {
      const env = windowsBoot(); delete env[key]; env[key.toLowerCase()] = "";
      expect(prepareEvidenceWorkerEnvironment(env, "win32")).toBe(true);
      expect(Object.keys(env).sort()).toEqual([...Object.keys(operational), cacheKey].sort());
      expectAtomicRefusal({ ...windowsBoot(), [key.toLowerCase()]: "synthetic-authority" });
    }
    const env: Record<string, string> = { ...operational, bun_runtime_transpiler_cache_path: "0" };
    expect(prepareEvidenceWorkerEnvironment(env, "win32")).toBe(true);
    expect(finishEvidenceWorkerEnvironment(env, "win32")).toBe(true);
    expect(env).toEqual(operational);
  });
  test("POSIX does not admit Windows placeholders or cache spelling aliases", () => {
    for (const platform of ["linux", "darwin"] as const) {
      for (const key of WINDOWS_WORKER_BOOTSTRAP_KEYS) expectAtomicRefusal({ LANG: "C.UTF-8", [key]: "", [cacheKey]: "0" }, platform);
      expectAtomicRefusal({ LANG: "C.UTF-8", bun_runtime_transpiler_cache_path: "0" }, platform);
      const env = evidenceWorkerLaunchEnv(platform);
      expect(prepareEvidenceWorkerEnvironment(env, platform)).toBe(true);
      expect(finishEvidenceWorkerEnvironment(env, platform)).toBe(true);
      expect(env).toEqual({ LANG: "C.UTF-8", TZ: "UTC" });
    }
  });
  test("operational parsing cannot retain even empty Windows bootstrap keys", () => {
    const env = windowsBoot(), before = Object.getOwnPropertyDescriptors(env);
    expect(finishEvidenceWorkerEnvironment(env, "win32")).toBe(false);
    expect(Object.getOwnPropertyDescriptors(env)).toEqual(before);
    expectAtomicRefusal(Object.freeze(windowsBoot()));
    let reads = 0;
    const accessor = windowsBoot();
    Object.defineProperty(accessor, "USERPROFILE", { enumerable: true, configurable: true, get() { reads++; return ""; } });
    expectAtomicRefusal(accessor);
    const unknown = windowsBoot();
    Object.defineProperty(unknown, "unknown", { enumerable: true, configurable: true, get() { reads++; return ""; } });
    expectAtomicRefusal(unknown);
    expect(reads).toBe(0);
    // Bun exposes TZ as a configurable accessor; operational keys need no value read.
    const valid = evidenceWorkerLaunchEnv("linux");
    Object.defineProperty(valid, "TZ", { enumerable: true, configurable: true, get() { reads++; return "UTC"; } });
    expect(prepareEvidenceWorkerEnvironment(valid, "linux")).toBe(true);
    expect(finishEvidenceWorkerEnvironment(valid, "linux")).toBe(true);
    expect(reads).toBe(0);
  });
});

test("cold dynamic module boot retains cache disabling until imports finish and detects an enabled cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runphantom-f03-cold-boot-"));
  const cwd = join(directory, "state"), profile = join(directory, "profile"), control = join(directory, "cache-control");
  await mkdir(cwd); await mkdir(profile); await mkdir(control);
  const module = join(directory, "cold.ts");
  const source = 'export const keys = Object.keys(process.env).sort();\n' + '/*' + 'cold-module-padding'.repeat(512) + '*/';
  expect(Buffer.byteLength(source)).toBeGreaterThan(4096);
  await writeFile(module, source);
  const helper = new URL("../src/evaluations/evidence-worker-environment.ts", import.meta.url).href;
  const fixture = pathToFileURL(module).href;
  const guarded = `const {prepareEvidenceWorkerEnvironment:prepare,finishEvidenceWorkerEnvironment:finish,EVIDENCE_WORKER_FAILURE:failure}=await import(${JSON.stringify(helper)});
if(!prepare()){process.stdout.write(failure);process.exit(1);}
const {keys:during}=await import(${JSON.stringify(fixture)});
if(!finish())process.exit(2);
process.stdout.write(JSON.stringify({during,after:Object.keys(process.env).sort()}));`;
  async function boot(code: string, env: Record<string, string>) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", code], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try {
      const [out, err, exit] = await Promise.all([readBoundedStream(child.stdout, 4096), readBoundedStream(child.stderr, 4096), child.exited]);
      expect(err.byteLength).toBe(0); expect(() => process.kill(child.pid, 0)).toThrow();
      return { exit, value: JSON.parse(new TextDecoder().decode(out)) };
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  }
  try {
    const result = await boot(guarded, evidenceWorkerLaunchEnv());
    const expected = Object.keys(evidenceWorkerLaunchEnv()).filter(key => !WINDOWS_WORKER_BOOTSTRAP_KEYS.some(known => known === key));
    expect(result.exit).toBe(0); expect(result.value.during).toEqual(expected.sort());
    expect(result.value.after).toEqual(expected.filter(key => key !== cacheKey).sort());
    expect(await readdir(cwd)).toEqual([]); expect(await readdir(profile, { recursive: true })).toEqual([]);
    for (const env of [{ ...evidenceWorkerLaunchEnv(), HOME: profile },
      { ...evidenceWorkerLaunchEnv(), BUN_RUNTIME_TRANSPILER_CACHE_PATH: profile }]) {
      const rejected = await boot(guarded, env);
      expect(rejected).toEqual({ exit: 1, value: { version: 1, id: null, error: "protocol_invalid" } });
      expect(await readdir(cwd)).toEqual([]); expect(await readdir(profile, { recursive: true })).toEqual([]);
    }
    // A separate owned directory proves the filesystem detector observes real Bun cache writes.
    const enabled = await boot(`const {keys}=await import(${JSON.stringify(fixture)});process.stdout.write(JSON.stringify(keys));`,
      { ...evidenceWorkerLaunchEnv(), BUN_RUNTIME_TRANSPILER_CACHE_PATH: control });
    expect(enabled.exit).toBe(0);
    const files = await readdir(control, { recursive: true });
    expect(files.length).toBeGreaterThan(0); expect(files.every(file => /^[0-9a-f]{16}\.pile$/.test(file))).toBe(true);
    expect(await readdir(cwd)).toEqual([]); expect(await readdir(profile, { recursive: true })).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);
