import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const ENGINES = ["chromium", "firefox", "webkit"] as const;
export type Engine = typeof ENGINES[number];
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"] as const;
export const JOURNEYS = ["capture-navigation", "trusted-outcome", "request-lifecycle", "selected-tab", "saved-flow"] as const;
export const PENDING = ["F37-recordings", "F41-44-integrated-ui", "F46-enabled-execution"] as const;
export interface EngineIdentity { engine: Engine; executable: string; executableSha256: string | null; nativeBinary: string; nativeSha256: string | null; available: boolean; reason: string | null }
export interface Outcome { collected: number; passed: number; failed: number; skipped: number; retries: number; exitCode: number | null; nativeAudit?: boolean }
export interface Cell { platform: string; engine: Engine; capability: string; status: "PASSED" | "BLOCKED" | "FAILED"; reason: string | null }
export function fileSha256(file: string): string {
  const fd = openSync(file, "r"), hash = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024);
  try { for (;;) { const n = readSync(fd, chunk, 0, chunk.length, null); if (!n) break; hash.update(chunk.subarray(0, n)); } return hash.digest("hex"); }
  finally { closeSync(fd); }
}
export function accepted(outcome: Outcome, expected: number): boolean {
  return expected > 0 && outcome.collected === expected && outcome.passed === expected && outcome.failed === 0 && outcome.skipped === 0 && outcome.retries === 0 && outcome.exitCode === 0;
}
export function matrix(host: string, identities: readonly EngineIdentity[], outcomes: Partial<Record<Engine, Outcome>>, expected: number): Cell[] {
  return PLATFORMS.flatMap(platform => ENGINES.flatMap(engine => {
    const identity = identities.find(item => item.engine === engine), outcome = outcomes[engine];
    const available = platform === host && identity?.available;
    const status = !available || !outcome ? "BLOCKED" : accepted(outcome, expected) ? "PASSED" : "FAILED";
    const reason = platform !== host ? "native-host-unavailable" : !identity?.available ? identity?.reason ?? "engine-manifest-missing" : !outcome ? "not-executed" : status === "FAILED" ? "exact-case-oracle-not-satisfied" : null;
    return [...JOURNEYS.map(capability => ({ platform, engine, capability, status, reason } as Cell)),
      { platform, engine, capability: "native-accessibility", status: platform === host && status === "PASSED" && outcome?.nativeAudit === true && engine === "chromium" ? "PASSED" : "BLOCKED", reason: platform !== host ? "native-host-unavailable" : engine !== "chromium" ? "product-audit-engine-unsupported" : outcome?.nativeAudit === true && status === "PASSED" ? null : "native-audit-oracle-pending" } as Cell,
      ...PENDING.map(capability => ({ platform, engine, capability, status: "BLOCKED", reason: "integrated-candidate-not-qualified" } as Cell))];
  }));
}
export function summarize(cells: readonly Cell[]) {
  const counts = { passed: 0, blocked: 0, failed: 0 };
  for (const cell of cells) counts[cell.status.toLowerCase() as keyof typeof counts]++;
  return { ...counts, accepted: counts.blocked === 0 && counts.failed === 0 && counts.passed > 0, exitCode: counts.failed ? 1 : counts.blocked || !counts.passed ? 2 : 0 };
}
export function engineInventory(repo: string): { moduleEntry: string; providerVersion: string; identities: EngineIdentity[] } {
  const appRequire = createRequire(path.join(repo, "app/package.json"));
  const require = createRequire(appRequire.resolve("@playwright/test/package.json"));
  const moduleEntry = realpathSync(require.resolve("playwright"));
  const runtime = require("playwright") as Record<Engine, { executablePath(): string }>;
  const providerVersion = (require("playwright/package.json") as { version: string }).version;
  const identities = ENGINES.map(engine => {
    const executable = runtime[engine].executablePath();
    const nativeBinary = engine === "webkit" && process.platform === "darwin" ? path.join(path.dirname(executable), "Playwright.app/Contents/MacOS/Playwright") : executable;
    const available = existsSync(executable) && existsSync(nativeBinary);
    return { engine, executable, executableSha256: existsSync(executable) ? fileSha256(executable) : null,
      nativeBinary, nativeSha256: existsSync(nativeBinary) ? fileSha256(nativeBinary) : null, available, reason: available ? null : "installed-engine-missing" };
  });
  return { moduleEntry, providerVersion, identities };
}
interface JsonSuite { suites?: JsonSuite[]; specs?: Array<{ tests?: Array<{ results?: Array<{ status?: string; retry?: number }>; expectedStatus?: string }> }> }
export function reportOutcome(report: JsonSuite, exitCode: number | null): Outcome {
  const outcome: Outcome = { collected: 0, passed: 0, failed: 0, skipped: 0, retries: 0, exitCode };
  const visit = (suite: JsonSuite) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      outcome.collected++; const results = test.results ?? [];
      outcome.retries += results.filter(result => (result.retry ?? 0) > 0).length;
      const last = results.at(-1)?.status;
      if (last === "passed" && test.expectedStatus !== "failed") outcome.passed++;
      else if (last === "skipped") outcome.skipped++;
      else outcome.failed++;
    }
    for (const child of suite.suites ?? []) visit(child);
  }; visit(report); return outcome;
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pythonLock = `import fcntl,os,subprocess,sys,signal,time,json
stream=open(sys.argv[1],'a+')
try: fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
 print(json.dumps({'status':'BLOCKED','reason':'canonical-browser-lease-busy'}),flush=True);sys.exit(2)
child=None
try:
 env=dict(os.environ);env['RUNPHANTOM_F47_LOCK_PID']=str(os.getpid())
 child=subprocess.Popen(sys.argv[2:],env=env,start_new_session=True)
 try: code=child.wait(timeout=600)
 except subprocess.TimeoutExpired:
  os.killpg(child.pid,signal.SIGTERM)
  try: child.wait(timeout=15)
  except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL);child.wait()
  code=124
 try: os.killpg(child.pid,0);remaining=True
 except ProcessLookupError: remaining=False
 if remaining:
  os.killpg(child.pid,signal.SIGKILL)
  for _ in range(100):
   try: os.killpg(child.pid,0)
   except ProcessLookupError: remaining=False;break
   time.sleep(.05)
 print(json.dumps({'f47_owned_group_absent':not remaining,'child_pid':child.pid,'exit':code}),flush=True)
 sys.exit(code if not remaining else 125)
finally:
 if child and child.poll() is None: os.killpg(child.pid,signal.SIGKILL);child.wait()
 fcntl.flock(stream,fcntl.LOCK_UN);stream.close()
`;
export function privateEnvironment(directory: string): Record<string, string> {
  const env: Record<string, string> = { HOME: directory, USERPROFILE: directory, TMPDIR: directory, LANG: "C.UTF-8", TZ: "UTC", NODE_ENV: "production", BUN_INSTALL_AUTO: "disable" };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key]!;
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  return env;
}
function main() {
  const args = process.argv.slice(2), outputArg = args.find(arg => arg.startsWith("--output="));
  if (!outputArg) throw new Error("An explicit fresh --output=absolute-directory is required");
  const output = path.resolve(outputArg.slice(9));
  if (!path.isAbsolute(outputArg.slice(9))) throw new Error("Output must be absolute");
  if (!args.includes("--under-lease")) {
    if (existsSync(output)) throw new Error("Refusing to overwrite a qualification attempt"); mkdirSync(output, { recursive: true });
    const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8" });
    if (common.status !== 0) throw new Error("Repository identity unavailable");
    const resourceRoot = path.dirname(common.stdout.trim()), wrapper = path.join(resourceRoot, ".omx/tools/with-heavy-slot.py"), lock = path.join(resourceRoot, ".omx/state/resource-slots/local-chromium.lock");
    if (!existsSync(wrapper)) throw new Error("Global resource wrapper missing: BLOCKED");
    const home = path.join(output, "runner-profile"); mkdirSync(home);
    const env = privateEnvironment(home);
    // Engine discovery uses the explicitly recorded existing cache, never the private profile's default cache.
    env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(process.env.HOME!, "Library/Caches/ms-playwright");
    const result = spawnSync("python3", [wrapper, "--label", "f47-browser-engine-qualification", "--cwd", repo, "--", "python3", "-c", pythonLock, lock, process.execPath, "--no-env-file", fileURLToPath(import.meta.url), ...args, "--under-lease"], { cwd: repo, env, stdio: "inherit" });
    process.exitCode = result.status ?? 1; return;
  }
  if (process.env.RUNPHANTOM_F47_LOCK_PID !== String(process.ppid)) throw new Error("Owned canonical browser lock supervisor required");
  const inventory = engineInventory(repo), chromiumIdentity = inventory.identities.find(identity => identity.engine === "chromium")!, outcomes: Partial<Record<Engine, Outcome>> = {};
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  const binary = args.find(arg => arg.startsWith("--binary="))?.slice(9);
  if (binary && (!path.isAbsolute(binary) || !existsSync(binary))) throw new Error("Copied artifact unavailable");
  writeFileSync(path.join(output, "inventory.json"), JSON.stringify({ ...inventory, platform: process.platform, arch: process.arch, sourceHead: head.stdout.trim(), runtime: binary ? { mode: "copied", binary, sha256: fileSha256(binary) } : { mode: "source", cwd: repo }, scope: "base-candidate-only", integratedAcceptance: false }, null, 2));
  const appRequire = createRequire(path.join(repo, "app/package.json"));
  const require = createRequire(appRequire.resolve("@playwright/test/package.json"));
  const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
  for (const identity of inventory.identities) {
    if (!identity.available) continue;
    const report = path.join(output, `${identity.engine}-playwright.json`), artifacts = path.join(output, identity.engine);
    const env = { ...process.env, RUNPHANTOM_F47_MODULE: inventory.moduleEntry, RUNPHANTOM_F47_BUN: process.execPath, RUNPHANTOM_F47_HEAD: head.stdout.trim(), RUNPHANTOM_F47_OUTPUT: output, RUNPHANTOM_F47_UI_EXECUTABLE: identity.executable, RUNPHANTOM_F47_CHROMIUM_EXECUTABLE: chromiumIdentity.executable, RUNPHANTOM_F47_CHROMIUM_SHA256: chromiumIdentity.executableSha256 ?? "", PLAYWRIGHT_JSON_OUTPUT_NAME: report, ...(binary ? { RUNPHANTOM_F47_BINARY: binary } : {}) };
    const result = spawnSync(process.execPath, ["--no-env-file", cli, "test", "--config", path.join(repo, "app/playwright.engines.config.ts"), `--project=${identity.engine}`, `--output=${artifacts}`], { cwd: repo, env, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(path.join(output, `${identity.engine}-stdout.log`), result.stdout ?? ""); writeFileSync(path.join(output, `${identity.engine}-stderr.log`), result.stderr ?? "");
    outcomes[identity.engine] = existsSync(report) ? reportOutcome(JSON.parse(readFileSync(report, "utf8")) as JsonSuite, result.status) : { collected: 0, passed: 0, failed: 1, skipped: 0, retries: 0, exitCode: result.status };
    const audit = path.join(output, `${identity.engine}-audit.json`);
    outcomes[identity.engine]!.nativeAudit = existsSync(audit) && (JSON.parse(readFileSync(audit, "utf8")) as { asserted: boolean }).asserted === true;
  }
  const cells = matrix(`${process.platform}-${process.arch}`, inventory.identities, outcomes, JOURNEYS.length), summary = summarize(cells);
  writeFileSync(path.join(output, "matrix.json"), JSON.stringify({ scope: "base-candidate-only", cells, outcomes, summary, installProposalOnly: inventory.identities.filter(item => !item.available).map(item => ({ engine: item.engine, expectedExecutable: item.executable, command: `bun x playwright install ${item.engine}`, executed: false, requiresSeparateAuthorization: true })), fullIntegrationAcceptance: false }, null, 2));
  console.log(JSON.stringify({ output, outcomes, summary })); process.exitCode = summary.exitCode;
}
if ((import.meta as ImportMeta & { main?: boolean }).main) main();
