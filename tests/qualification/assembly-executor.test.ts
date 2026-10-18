import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createManifest, HOSTS, type Receipt } from "../../scripts/qualification/assembled-contracts";
import { actualHost, executeStage, privateEnvironment, sourceIdentity } from "../../scripts/qualification/assembled-executor";
import { nativeArtifactMatches, observeDatabaseFile } from "../../scripts/qualification/assembled-installed-probe";
import { sha256 } from "../../scripts/qualification/assembled-validation";

async function rejects(operation: Promise<unknown>, message?: string): Promise<void> {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  if (message) expect((caught as Error).message).toContain(message);
}

const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
async function realStage(mode: "passed" | "failed" | "timeout" | "missing" | "source-change") {
  const root = await mkdtemp(path.join(tmpdir(), "phantom-assembly-executor-")); directories.push(root);
  const repo = path.join(root, "repo"); await import("node:fs/promises").then(fs => fs.mkdir(repo));
  const script = path.join(repo, "control.ts");
  await writeFile(script, `import {writeFileSync} from "node:fs"; import {createHash} from "node:crypto"; import path from "node:path";
const output=process.env.RUNPHANTOM_QUALIFICATION_OBSERVATION; if(!output)throw Error("no observation path");
const dir=path.dirname(output), bytes=JSON.stringify({actual:"REAL_COMMAND_CONTROL"});
writeFileSync(path.join(dir,"actual.json"),bytes);
const artifact={path:"actual.json",bytes:Buffer.byteLength(bytes),sha256:createHash("sha256").update(bytes).digest("hex")};
const receipt={expectedTests:["real-command-control"],tests:[{id:"real-command-control",status:"passed",attempt:0}],
invariants:["actual-output","bounded-resources","no-unexpected-errors","owned-cleanup"].map(id=>({id,passed:true,artifact})),
outputs:[{id:"actual-control",actual:artifact,expectedSha256:artifact.sha256}],runtime:null,provider:null,cleanup:{allOwnedClosed:true,profilesRemoved:true}};
${mode === "missing" ? "" : "writeFileSync(output,JSON.stringify(receipt));"}
console.log("REAL_COMMAND_CONTROL");
${mode === "source-change" ? 'writeFileSync("anchor.txt","changed");' : ""}
${mode === "timeout" ? "setInterval(()=>{},1000);" : `process.exitCode=${mode === "failed" ? 7 : 0};`}
`);
  await writeFile(path.join(repo, "anchor.txt"), "original");
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe" });
  git(["init", "--quiet"]); git(["add", "control.ts", "anchor.txt"]);
  git(["-c", "user.name=Divyam Talwar", "-c", "user.email=divyamtalwar15@gmail.com", "commit", "--quiet", "-m", "test: preserve an isolated stage-control source"]);
  const manifest = createManifest(sourceIdentity(repo)); manifest.cells.find(c => c.id === "F45/component")!.expectedTests = ["real-command-control"];
  manifest.cells.find(c => c.id === "F45/component")!.expectedOutputs = [{ id: "actual-control", sha256: sha256(JSON.stringify({ actual: "REAL_COMMAND_CONTROL" })) }];
  return { root, repo, script, manifest, output: path.join(root, "attempt") };
}
test("private environment preserves operational paths while excluding ambient provider/configuration inputs", () => {
  const env = privateEnvironment("/owned-home", "/owned-tmp");
  expect(env.HOME).toBe("/owned-home"); expect(env.TMPDIR).toBe("/owned-tmp");
  expect(env.ANTHROPIC_API_KEY).toBe(""); expect(env.OPENAI_API_KEY).toBe("");
  expect(env.RUNPHANTOM_DB_PATH).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.BUN_OPTIONS).toBeUndefined();
});
test("real owned command records actual output, source, host, exit and terminal cleanup", async () => {
  const f = await realStage("passed");
  const result = await executeStage(f.repo, f.manifest, "e".repeat(64), { cellId: "F45/component", command: [process.execPath, "--no-env-file", "--no-install", f.script], timeoutMs: 15000, scope: "control" }, f.output);
  expect(result).toMatchObject({ status: "passed", reasons: [], runnerClosed: true });
  const receipt = JSON.parse(await readFile(path.join(f.output, "receipt.json"), "utf8")) as Receipt;
  expect(receipt.host).toEqual(actualHost()); expect(receipt.source).toEqual(f.manifest.source);
  expect(receipt.execution.exitCode).toBe(0); expect(receipt.scope).toBe("control");
  expect(receipt.outputs[0].actual.sha256).toBe(sha256(JSON.stringify({ actual: "REAL_COMMAND_CONTROL" })));
  const owner = JSON.parse(await readFile(path.join(f.output, "owned-runner.json"), "utf8")) as { pid: number; closed: boolean };
  expect(owner.closed).toBe(true); expect(() => process.kill(owner.pid, 0)).toThrow();
  const names = await (await import("node:fs/promises")).readdir(f.output);
  expect(names.some(n => n.startsWith("home-") || n.startsWith("tmp-"))).toBe(false);
}, 30000);
for (const mode of ["failed", "timeout", "missing", "source-change"] as const) test(`real ${mode} command remains failed despite any child-reported pass`, async () => {
  const f = await realStage(mode);
  const result = await executeStage(f.repo, f.manifest, "e".repeat(64), { cellId: "F45/component", command: [process.execPath, "--no-env-file", "--no-install", f.script], timeoutMs: mode === "timeout" ? 500 : 15000, scope: "control" }, f.output);
  expect(result.status).toBe("failed"); expect(result.runnerClosed).toBe(true); expect(result.reasons.length).toBeGreaterThan(0);
  const owner = JSON.parse(await readFile(path.join(f.output, "owned-runner.json"), "utf8")) as { pid: number; closed: boolean };
  expect(owner.closed).toBe(true); expect(() => process.kill(owner.pid, 0)).toThrow();
  if (mode === "failed") {
    const receipt = JSON.parse(await readFile(path.join(f.output, "receipt.json"), "utf8")) as Receipt;
    expect(receipt.execution.exitCode).toBe(7);
  }
}, 30000);
test("wrong actual host, unfrozen roster and provider execution refuse before launch", async () => {
  const f = await realStage("passed"), command = { cellId: "F45/component", command: [process.execPath, f.script], timeoutMs: 1000, scope: "product" as const };
  f.manifest.cells.find(c => c.id === command.cellId)!.expectedTests = null;
  await rejects(executeStage(f.repo, f.manifest, "e".repeat(64), command, f.output), "assembly_roster_not_frozen");
  const provider = f.manifest.cells.find(c => c.stage === "provider")!; provider.expectedTests = ["actual"]; provider.expectedOutputs = [{ id: "output", sha256: "e".repeat(64) }];
  await rejects(executeStage(f.repo, f.manifest, "e".repeat(64), { ...command, cellId: provider.id }, f.output), "assembly_provider_execution_requires_separate_budget_owner");
  const wrong = f.manifest.cells.find(c => c.host && c.host.arch !== actualHost().arch)!; wrong.expectedTests = ["actual"]; wrong.expectedOutputs = [{ id: "output", sha256: "e".repeat(64) }];
  await rejects(executeStage(f.repo, f.manifest, "e".repeat(64), { ...command, cellId: wrong.id }, f.output), "assembly_native_host_mismatch");
  await rejects(stat(f.output));
});
test("native artifact format checks distinguish real host executable from cross-target headers and scripts", async () => {
  const f = await realStage("passed"), host = actualHost();
  expect(await nativeArtifactMatches(process.execPath, host)).toBe(true);
  expect(await nativeArtifactMatches(process.execPath, HOSTS.find(h => h.platform === host.platform && h.arch !== host.arch) ?? HOSTS[0])).toBe(false);
  const fake = path.join(f.root, "script"); await writeFile(fake, "#!/bin/sh\necho unavailable\n" + " ".repeat(100));
  expect(await nativeArtifactMatches(fake, host)).toBe(false);
});

test("actual database descriptor distinguishes the opened file from a same-path replacement", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "phantom-default-db-identity-")); directories.push(directory);
  const file = path.join(directory, "owned.db"), database = new Database(file, { create: true });
  try {
    database.exec("CREATE TABLE actual_owned_control (id INTEGER PRIMARY KEY)");
    const observed = await observeDatabaseFile(process.pid, file);
    expect(observed.inode).toBe((await stat(file, { bigint: true })).ino.toString());
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(observed.openByProcess).toBe(true);
      await rename(file, file + ".original"); await writeFile(file, "not-the-open-database");
      await rejects(observeDatabaseFile(process.pid, file), "assembly_database_not_open_by_process");
    } else {
      expect(observed.openByProcess).toBeNull();
      expect(observed.coverage).toContain("unavailable");
    }
  } finally { database.close(); }
});
