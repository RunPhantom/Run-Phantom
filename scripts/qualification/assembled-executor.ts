import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { machine } from "node:os";
import path from "node:path";
import { launchOwnedProcess, stopOwnedProcess, fileSha256, type OwnedProcess } from "../../app/tests-e2e/daemon-runtime";
import { removeOwnedDirectory } from "../../app/tests-e2e/owned-directory";
import { HOSTS, hostId, type Artifact, type Host, type Manifest, type Receipt, type SourcePin } from "./assembled-contracts";
import { canonical, parseQualificationJson, sha256, validateManifest, validateReceipt } from "./assembled-validation";

export function actualHost(): Host {
  const host = HOSTS.find(h => h.platform === process.platform && h.arch === process.arch);
  const hardware = machine().toLowerCase();
  if (!host || host.arch === "arm64" && !["arm64", "aarch64"].includes(hardware)
    || host.arch === "x64" && !["x86_64", "amd64", "x64"].includes(hardware)) throw new Error("assembly_native_host_mismatch");
  if (process.platform === "darwin" && process.arch === "x64") {
    const translated = execFileSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    if (translated.trim() === "1") throw new Error("assembly_emulated_host");
  }
  return host;
}
function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_OPTIONAL_LOCKS: "0" } }).trim();
}
export function sourceIdentity(root: string): SourcePin {
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("assembly_source_dirty");
  return { sha: git(root, ["rev-parse", "HEAD"]), tree: git(root, ["rev-parse", "HEAD^{tree}"]) };
}
export function candidateFeatureHeads(root: string, manifest: Manifest): Set<string> {
  const source = sourceIdentity(root);
  if (canonical(source) !== canonical(manifest.source)) throw new Error("assembly_candidate_changed");
  const ancestors = new Set(git(root, ["rev-list", source.sha]).split("\n"));
  const result = new Set<string>();
  for (const feature of manifest.features) {
    if (!feature.head || !ancestors.has(feature.head)) continue;
    const featureAncestors = new Set(git(root, ["rev-list", feature.head]).split("\n"));
    if (feature.dependencies.every(id => { const head = manifest.features.find(f => f.id === id)!.head; return !!head && featureAncestors.has(head); })) result.add(feature.head);
  }
  return result;
}
export async function artifactAt(root: string, file: string): Promise<Artifact> {
  const base = await realpath(root), full = await realpath(file), relative = path.relative(base, full);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("assembly_artifact_path");
  return { path: relative.split(path.sep).join("/"), bytes: (await stat(full)).size, sha256: await fileSha256(full) };
}
export function privateEnvironment(home: string, temporary: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, windir: process.env.windir,
    HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary, LANG: "C", TZ: "UTC",
    ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", RUNPHANTOM_OPENAI_API_KEY: "", RUNPHANTOM_CLAUDE_CLI_CHAT: "0" };
}
export type StageCommand = { cellId: string; command: string[]; timeoutMs: number; scope: "control" | "product" };
export type StageExecution = { status: "passed" | "failed"; receipt: Artifact | null; reasons: string[]; runnerClosed: boolean };
export async function executeStage(root: string, manifest: Manifest, manifestSha256: string, command: StageCommand, output: string): Promise<StageExecution> {
  validateManifest(manifest);
  if (canonical(sourceIdentity(root)) !== canonical(manifest.source)) throw new Error("assembly_candidate_changed");
  const cell = manifest.cells.find(c => c.id === command.cellId);
  if (!cell || !cell.expectedTests || !cell.expectedTests.length || !cell.expectedOutputs?.length) throw new Error("assembly_roster_not_frozen");
  if (cell.stage === "provider") throw new Error("assembly_provider_execution_requires_separate_budget_owner");
  if (command.scope === "control" && cell.stage !== "component") throw new Error("assembly_control_scope_escalation");
  const host = actualHost(); if (cell.host && hostId(cell.host) !== hostId(host)) throw new Error("assembly_native_host_mismatch");
  if (cell.stage !== "component") {
    const mode = cell.stage === "source" || cell.profile === "source-backend" ? "source" : "installed";
    const profile = manifest.profiles.find(p => hostId(p.host) === hostId(host) && p.mode === mode);
    if (!profile?.runtimeVersion || !profile.database || !profile.resourceSha256.length || mode === "installed" && !profile.artifactSha256 || cell.engine && !cell.enginePin) throw new Error("assembly_runtime_profile_unpinned");
  }
  if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 1_800_000 || !command.command.length
    || command.command.length > 128 || command.command.some(s => !s || s.length > 8192 || s.includes("\0")) || !path.isAbsolute(command.command[0])) throw new Error("assembly_command_contract");
  await mkdir(output); // Never overwrite a prior attempt or its first failure.
  const directory = await realpath(output), home = await mkdtemp(path.join(directory, "home-")), temporary = await mkdtemp(path.join(directory, "tmp-"));
  const observation = path.join(directory, "observation.json"), logFile = path.join(directory, "command.log");
  let runner: OwnedProcess | undefined, timer: ReturnType<typeof setTimeout> | undefined, timedOut = false, interrupted = false;
  let log = Buffer.alloc(0), logOverflow = false, cleanupClosed = false, profilesRemoved = false, receipt: Artifact | null = null;
  const reasons: string[] = [], startedAt = new Date().toISOString();
  let abort!: () => void; const stopped = new Promise<void>(resolve => { abort = resolve; });
  const onSignal = () => { interrupted = true; abort(); };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  try {
    runner = launchOwnedProcess(command.command[0], command.command.slice(1), root,
      { ...privateEnvironment(home, temporary), RUNPHANTOM_QUALIFICATION_OBSERVATION: observation });
    const owned = runner;
    const collect = (chunk: Buffer) => {
      if (log.length + chunk.length > 1024 * 1024) logOverflow = true;
      if (log.length < 1024 * 1024) log = Buffer.concat([log, chunk.subarray(0, 1024 * 1024 - log.length)]);
    };
    owned.child.stdout?.on("data", collect); owned.child.stderr?.on("data", collect);
    await writeFile(path.join(directory, "owned-runner.json"), JSON.stringify({ pid: owned.child.pid ?? null, identity: await owned.identity,
      source: manifest.source, actualHost: host, commandSha256: sha256(canonical(command.command)), closed: false }));
    await Promise.race([owned.closed, stopped, new Promise<void>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, command.timeoutMs); })]);
    if (owned.error || owned.child.exitCode !== 0 || owned.child.signalCode || timedOut || interrupted) reasons.push("assembly_command_not_passed");
    if (logOverflow) reasons.push("assembly_command_output_limit");
  } catch { reasons.push("assembly_stage_execution_failed"); }
  finally {
    clearTimeout(timer);
    if (runner) {
      try { await stopOwnedProcess(runner); cleanupClosed = true; }
      catch { reasons.push("assembly_owned_cleanup_failed"); }
    }
    if (cleanupClosed) {
      const removed = await Promise.allSettled([removeOwnedDirectory(home), removeOwnedDirectory(temporary)]);
      profilesRemoved = removed.every(r => r.status === "fulfilled");
      if (!profilesRemoved) reasons.push("assembly_private_profile_cleanup_failed");
    }
    EventEmitter.prototype.removeListener.call(process, "SIGINT", onSignal); EventEmitter.prototype.removeListener.call(process, "SIGTERM", onSignal);
    await writeFile(logFile, log);
  }
  const finishedAt = new Date().toISOString();
  try {
    if (canonical(sourceIdentity(root)) !== canonical(manifest.source)) throw new Error("assembly_candidate_changed");
    if (!runner || !cleanupClosed) throw new Error("assembly_owned_cleanup_failed");
    const meta = await stat(observation); if (meta.size > 8 * 1024 * 1024) throw new Error("assembly_observation_limit");
    const body = parseQualificationJson(await readFile(observation)) as Receipt;
    const actual: Receipt = { ...body, schema: "runphantom.assembly-receipt/v1", cellId: cell.id, stage: cell.stage, scope: command.scope,
      source: manifest.source, host, manifestSha256, execution: { command: command.command, exitCode: runner.child.exitCode, timedOut,
        signal: interrupted ? "INTERRUPTED" : runner.child.signalCode, startedAt, finishedAt, log: await artifactAt(directory, logFile) },
      cleanup: { allOwnedClosed: cleanupClosed && body.cleanup?.allOwnedClosed === true, profilesRemoved: profilesRemoved && body.cleanup?.profilesRemoved === true } };
    const file = path.join(directory, "receipt.json"); await writeFile(file, JSON.stringify(actual, null, 2)); receipt = await artifactAt(directory, file);
    await validateReceipt(directory, { receipt: actual, artifact: receipt }, cell, manifest, manifestSha256);
  } catch (error) {
    reasons.push(error instanceof Error && /^assembly_[a-z_]+$/.test(error.message) ? error.message : "assembly_observation_missing_or_invalid");
  }
  if (runner && cleanupClosed) await writeFile(path.join(directory, "owned-runner.json"), JSON.stringify({ pid: runner.child.pid ?? null,
    identity: await runner.identity, source: manifest.source, actualHost: host, closed: true }));
  const result: StageExecution = { status: reasons.length ? "failed" : "passed", receipt, reasons: [...new Set(reasons)], runnerClosed: cleanupClosed };
  await writeFile(path.join(directory, "stage-result.json"), JSON.stringify(result, null, 2)); return result;
}
