#!/usr/bin/env bun
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createManifest, type Artifact, type FeatureId, type IndependentReview, type Manifest } from "./assembled-contracts";
import { actualHost, candidateFeatureHeads, executeStage, sourceIdentity, type StageCommand } from "./assembled-executor";
import { aggregateAssembly, loadSubmittedReceipt, parseQualificationJson, readQualificationBytes, sha256, validateManifest } from "./assembled-validation";
import { probeInstalledBackend } from "./assembled-installed-probe";

const root = path.resolve(import.meta.dirname, "../..");
async function readJson(file: string): Promise<unknown> { return parseQualificationJson(await readQualificationBytes(file)); }
async function save(file: string, value: unknown): Promise<void> { await writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }
async function main() {
  const [action, ...args] = process.argv.slice(2), options = new Map<string, string>();
  const permitted: Record<string, string[]> = {
    plan: ["output", "feature-heads"], host: ["output"], check: ["manifest", "bundle", "submissions", "reviews", "output", "checks-only"],
    execute: ["manifest", "command", "output"], probe: ["binary", "sha256", "output"], "probe-default": ["binary", "sha256", "output"],
  };
  if (!permitted[action]) throw new Error("assembly_action_required");
  for (const arg of args) {
    const m = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!m || !permitted[action].includes(m[1]) || options.has(m[1])) throw new Error("assembly_option_invalid");
    options.set(m[1], m[2]);
  }
  const required = (key: string): string => { const value = options.get(key); if (!value) throw new Error("assembly_option_missing"); return value; };
  const source = sourceIdentity(root);
  if (action === "host") { await save(required("output"), { source, host: actualHost(), launcherRuntime: Bun.version }); return; }
  if (action === "plan") {
    const heads = options.has("feature-heads") ? await readJson(required("feature-heads")) as Partial<Record<FeatureId, string>> : {};
    const manifest = createManifest(source, heads); validateManifest(manifest); await save(required("output"), manifest); return;
  }
  if (action === "probe" || action === "probe-default") {
    const result = await probeInstalledBackend(root, source, required("binary"), required("sha256"), required("output"), action === "probe-default" ? "default" : "explicit");
    console.log(JSON.stringify({ status: result.status, releaseQualified: false, scope: result.scope }));
    if (result.failures.length) process.exitCode = 1;
    return;
  }
  const manifestBytes = await readQualificationBytes(required("manifest")), manifest = validateManifest(parseQualificationJson(manifestBytes));
  if (action === "execute") {
    const command = await readJson(required("command")) as StageCommand;
    if (!command || Object.keys(command).sort().join(",") !== "cellId,command,scope,timeoutMs" || !["control", "product"].includes(command.scope)) throw new Error("assembly_command_contract");
    const result = await executeStage(root, manifest, sha256(manifestBytes), command, required("output"));
    console.log(JSON.stringify(result)); if (result.status !== "passed") process.exitCode = 1; return;
  }
  const bundle = await realpath(required("bundle"));
  const artifacts = await readJson(required("submissions")) as Artifact[];
  if (!Array.isArray(artifacts) || artifacts.length > 1024) throw new Error("assembly_submissions_limit");
  const submissions = [];
  for (const artifact of artifacts) submissions.push(await loadSubmittedReceipt(bundle, artifact));
  let reviews: IndependentReview[] = [];
  if (options.has("reviews")) {
    const file = await realpath(required("reviews")), relative = path.relative(bundle, file);
    if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) throw new Error("assembly_review_must_be_separate");
    reviews = await readJson(file) as IndependentReview[];
    if (!Array.isArray(reviews) || reviews.length > 1024) throw new Error("assembly_review_limit");
  }
  const result = await aggregateAssembly(manifest as Manifest, sha256(manifestBytes), submissions, bundle, candidateFeatureHeads(root, manifest), reviews);
  await save(required("output"), result);
  console.log(JSON.stringify({ verdict: result.verdict, checksComplete: result.checksComplete, releaseQualified: result.releaseQualified, blockers: result.blockers.length }));
  const checksOnly = options.get("checks-only"); if (checksOnly !== undefined && checksOnly !== "true") throw new Error("assembly_option_invalid");
  if (!result.releaseQualified && !(checksOnly === "true" && result.checksComplete)) process.exitCode = 1;
}
if (import.meta.main) void main().catch(error => {
  console.error(error instanceof Error && /^assembly_[a-z_]+$/.test(error.message) ? error.message : "assembly_failed"); process.exitCode = 1;
});
