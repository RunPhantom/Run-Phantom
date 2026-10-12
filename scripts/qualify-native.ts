#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileSha256, outsideCheckout, launchOwnedProcess, stopOwnedProcess, type RuntimeProvenance } from "../app/tests-e2e/daemon-runtime";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type Attachment = { name: string; body?: string; path?: string };
type Result = { status: string; retry: number; attachments: Attachment[] };
type Suite = { suites?: Suite[]; specs?: { title: string; tests: { results: Result[] }[] }[] };
type Report = { suites: Suite[]; stats: { expected: number; unexpected: number; flaky: number; skipped: number } };
type Cleanup = { runtime: RuntimeProvenance; process: { pid: number; closeObserved: boolean; identity: string | null }; directoryRemoved: boolean; artifactUnchanged: boolean };

function options(args: string[]) {
  const fields = new Map<string, string>(); const specs: string[] = [];
  for (const arg of args) {
    const match = /^--(binary|sha256|output)=(.+)$/.exec(arg);
    if (match) { if (fields.has(match[1])) throw new Error("native_duplicate_option"); fields.set(match[1], match[2]); }
    else if (/^[a-z0-9-]+\.spec\.ts$/.test(arg)) specs.push(arg);
    else throw new Error("native_unknown_option");
  }
  const binary = fields.get("binary"), sha256 = fields.get("sha256"), output = fields.get("output");
  if (!binary || !path.isAbsolute(binary)) throw new Error("native_artifact_missing");
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("native_digest_required");
  if (!output || !path.isAbsolute(output)) throw new Error("native_output_required");
  return { binary, sha256, output, specs: specs.length ? specs : ["native-fixture.spec.ts", "live-detail-recovery.spec.ts"] };
}
async function boundedFile(file: string, max: number): Promise<Buffer> {
  if ((await stat(file)).size > max) throw new Error("native_receipt_size");
  const body = await readFile(file);
  if (body.length > max) throw new Error("native_receipt_size");
  return body;
}
async function receipt<T>(attachments: Attachment[], name: string, output: string): Promise<T> {
  const found = attachments.filter(item => item.name === name);
  if (found.length !== 1) throw new Error("native_receipt_missing");
  const item = found[0]; let body: Buffer;
  if (item.body !== undefined) {
    if (item.body.length > 32 * 1024) throw new Error("native_receipt_size");
    body = Buffer.from(item.body, "base64");
  } else if (item.path) {
    const file = await realpath(item.path), relative = path.relative(output, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("native_receipt_path");
    body = await boundedFile(file, 16 * 1024);
  } else throw new Error("native_receipt_missing");
  return JSON.parse(body.toString("utf8")) as T;
}
function results(suites: Suite[]): { title: string; result: Result }[] {
  return suites.flatMap(suite => [...results(suite.suites ?? []), ...(suite.specs ?? []).flatMap(spec => spec.tests.flatMap(test => test.results.map(result => ({ title: spec.title, result }))))]);
}
async function removed(directory: string): Promise<boolean> {
  try { await stat(directory); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } }

async function main() {
  const selection = options(process.argv.slice(2));
  if (!["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"].includes(`${process.platform}-${process.arch}`)) throw new Error("native_platform_unsupported");
  const artifact = await realpath(selection.binary);
  if (await fileSha256(artifact) !== selection.sha256) throw new Error("native_digest_mismatch");
  for (const spec of selection.specs) await stat(path.join(root, "app/tests-e2e", spec));
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 3000 }).trim();
  execFileSync("git", ["diff", "--quiet", "HEAD"], { cwd: root, timeout: 3000 });
  await mkdir(selection.output); // Existing output must never be overwritten.
  const output = await realpath(selection.output), reportPath = path.join(output, "playwright.json");
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(key)));
  const runner = launchOwnedProcess("node", [path.join(root, "app/node_modules/@playwright/test/cli.js"), "test", "--config", path.join(root, "app/playwright.config.ts"),
    ...selection.specs, "--project=chromium", "--workers=1", "--retries=0", "--global-timeout=1800000", "--reporter=json", `--output=${path.join(output, "test-results")}`], root,
    { ...cleanEnv, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", RUNPHANTOM_E2E_RUNTIME: "installed", RUNPHANTOM_E2E_BINARY: artifact,
      RUNPHANTOM_E2E_SHA256: selection.sha256, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath });
  let log = ""; const capture = (data: Buffer) => { if (log.length < 64 * 1024) log += data.toString().slice(0, 64 * 1024 - log.length); };
  runner.child.stdout?.on("data", capture); runner.child.stderr?.on("data", capture);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const manifest: Record<string, unknown> = { status: "failed", sourceHead, platform: process.platform, architecture: process.arch, artifact, sha256: selection.sha256,
    specs: selection.specs, workers: 1, assertionRetries: 0, coverage: "selected copied-native journeys only; other hosts, providers and full feature acceptance remain pending" };
  let failure: Error | undefined;
  try {
    await Promise.race([runner.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("native_runner_timeout")), 1_860_000); })]);
    if (runner.error || runner.child.exitCode !== 0) throw new Error("native_runner_failed");
    const report = JSON.parse((await boundedFile(reportPath, 32 * 1024 * 1024)).toString("utf8")) as Report;
    if (!report.stats.expected || report.stats.unexpected || report.stats.flaky || report.stats.skipped) throw new Error("native_journey_not_passed");
    const journeys = [];
    for (const { title, result } of results(report.suites)) {
      if (result.status !== "passed" || result.retry !== 0) throw new Error("native_journey_not_passed");
      const runtime = await receipt<RuntimeProvenance>(result.attachments, "runphantom-runtime-start", output);
      const cleanup = await receipt<Cleanup>(result.attachments, "runphantom-runtime-cleanup", output);
      if (runtime.mode !== "installed" || runtime.sourceArtifact !== artifact || runtime.sourceSha256 !== selection.sha256 || runtime.copiedSha256 !== selection.sha256 ||
        !runtime.copiedArtifact || !outsideCheckout(root, runtime.stateDirectory) || runtime.command[0] !== runtime.copiedArtifact || runtime.command[1] !== "serve" ||
        !runtime.observation?.listenerOwned || JSON.stringify(cleanup.runtime) !== JSON.stringify(runtime) || cleanup.process.pid !== runtime.pid ||
        !cleanup.process.closeObserved || !cleanup.process.identity || !cleanup.directoryRemoved || !cleanup.artifactUnchanged ||
        !await removed(runtime.stateDirectory) || alive(runtime.pid)) throw new Error("native_provenance_not_closed");
      journeys.push({ title, runtime, cleanup });
    }
    if (journeys.length !== report.stats.expected || await fileSha256(artifact) !== selection.sha256) throw new Error("native_receipt_count_or_digest");
    manifest.status = "passed"; manifest.journeys = journeys; manifest.stats = report.stats;
  } catch (error) { failure = error instanceof Error ? error : new Error("native_qualification_failed"); manifest.failure = failure.message; }
  finally {
    clearTimeout(timer);
    try { manifest.runner = await stopOwnedProcess(runner); }
    catch (error) {
      manifest.status = "failed"; manifest.cleanupFailure = error instanceof Error ? error.message : "native_runner_cleanup_failed";
      failure = failure ? new AggregateError([failure, error], "native_qualification_and_cleanup_failed") : error instanceof Error ? error : new Error("native_runner_cleanup_failed");
    }
    finally { await writeFile(path.join(output, "runner.log"), log); await writeFile(path.join(output, "qualification.json"), JSON.stringify(manifest, null, 2)); }
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ status: manifest.status, report: path.join(output, "qualification.json") }));
}

void main().catch(error => { console.error(error instanceof Error ? error.message : "native_qualification_failed"); process.exitCode = 1; });
