import { appendFileSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VerificationChangeContext } from "../../src/verification/protocol";

type Mode = "held" | "slow" | "encoding" | "bytes" | "filter";
type ChildReceipt = { id: string; phase: "started" | "closed"; pid: number };

function archiveReceipt(destination: string | undefined, receipt: unknown): void {
  if (!destination) return;
  const line = JSON.stringify(receipt) + "\n";
  if ((existsSync(destination) ? statSync(destination).size : 0) + Buffer.byteLength(line) > 65_536)
    throw new Error("Native Git fixture archive exceeds its bound");
  appendFileSync(destination, line);
}

export function compileChangeGitFixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-change-git-native-")));
  const git = Bun.which("git");
  if (!git) throw new Error("Native fixture Git is unavailable");
  const binary = path.join(directory, `fixture${process.platform === "win32" ? ".exe" : ""}`);
  try {
    const build = spawnSync(process.execPath, ["build", "--compile", "--minify", import.meta.path, "--outfile", binary],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (build.status !== 0) throw new Error(`Native Git fixture compilation failed: ${build.stderr}`);
    const config = { git: realpathSync(git), receipts: path.join(directory, "children.jsonl"), archive: process.env.RUNPHANTOM_TEST_GIT_RECEIPTS };
    writeFileSync(path.join(directory, "config.json"), JSON.stringify(config));
    archiveReceipt(config.archive, { phase: "compiled", directory, git: config.git, processExecutable: process.execPath, path: process.env.PATH });
    const executables = new Map<Mode, string>();
    for (const mode of ["held", "slow", "encoding", "bytes", "filter"] as const) {
      const target = path.join(directory, `${mode}-git${process.platform === "win32" ? ".exe" : ""}`);
      copyFileSync(binary, target, constants.COPYFILE_FICLONE);
      const ready = spawnSync(target, ["--fixture-ready"], { encoding: "utf8", timeout: 3000, maxBuffer: 1024 });
      if (ready.status !== 0 || ready.stdout !== "native-git-fixture-ready\n") throw new Error("Compiled native Git fixture did not become ready");
      executables.set(mode, target);
    }
    const assertClosed = () => {
      const receipts = path.join(directory, "children.jsonl");
      if (!existsSync(receipts)) return;
      if (statSync(receipts).size > 65_536) throw new Error("Native Git fixture receipt exceeds its bound");
      const rows = readFileSync(receipts, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as ChildReceipt);
      for (const row of rows.filter(item => item.phase === "started")) {
        if (!rows.some(item => item.id === row.id && item.pid === row.pid && item.phase === "closed"))
          throw new Error("Native Git fixture child close was not confirmed; retained fixture directory");
      }
    };
    return { executable: (mode: Mode) => executables.get(mode)!, assertClosed,
      close() { assertClosed(); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

async function main() {
  const config = JSON.parse(readFileSync(path.join(path.dirname(process.execPath), "config.json"), "utf8")) as { git: string; receipts: string; archive?: string };
  archiveReceipt(config.archive, { phase: "helper-entered", at: Date.now(), pid: process.pid, executable: process.execPath, argv: process.argv.slice(2), cwd: process.cwd() });
  if (process.argv.includes("--fixture-ready")) { await Bun.write(Bun.stdout, "native-git-fixture-ready\n"); return; }
  const mode = path.basename(process.execPath).replace(/-git(?:\.exe)?$/, "") as Mode;
  if (mode === "encoding") { await Bun.write(Bun.stdout, new Uint8Array([255])); return; }
  if (mode === "bytes") { await Bun.write(Bun.stdout, Buffer.alloc(65_537)); return; }
  if (mode === "filter") { writeFileSync("filter-executed", "native filter reached\n"); process.exitCode = 1; return; }
  if (mode !== "held" && mode !== "slow") throw new Error("Unknown native Git fixture mode");
  const id = randomUUID();
  const child = spawn(config.git, process.argv.slice(2), { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  if (!child.pid) throw new Error("Native Git fixture child did not start");
  appendFileSync(config.receipts, JSON.stringify({ id, phase: "started", pid: child.pid }) + "\n");
  archiveReceipt(config.archive, { id, phase: "git-started", at: Date.now(), pid: child.pid, helperPid: process.pid, executable: config.git, argv: process.argv.slice(2), cwd: process.cwd() });
  const out: Buffer[] = [], err: Buffer[] = []; let outBytes = 0, errBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    if (outBytes <= 65_536) out.push(chunk.subarray(0, 65_537 - outBytes)); outBytes += chunk.length;
    if (outBytes > 65_536) child.kill("SIGKILL");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (errBytes <= 4096) err.push(chunk.subarray(0, 4097 - errBytes)); errBytes += chunk.length;
    if (errBytes > 4096) child.kill("SIGKILL");
  });
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  appendFileSync(config.receipts, JSON.stringify({ id, phase: "closed", pid: child.pid, exit: code, signal: child.signalCode }) + "\n");
  archiveReceipt(config.archive, { id, phase: "git-closed", at: Date.now(), pid: child.pid, exit: code, signal: child.signalCode, stdoutBytes: outBytes, stderrBytes: errBytes });
  await Bun.write(Bun.stdout, Buffer.concat(out)); await Bun.write(Bun.stderr, Buffer.concat(err));
  // The native Git child has closed before the response is held or delayed.
  if (mode === "held" && process.argv.includes("--show-toplevel")) {
    writeFileSync("held", "native Git child closed\n");
    const until = performance.now() + 2000;
    while (!existsSync("release")) { if (performance.now() >= until) throw new Error("Native Git fixture release unavailable"); await Bun.sleep(10); }
  }
  if (mode === "slow") await Bun.sleep(300);
  process.exitCode = code ?? 1;
}

let diagnosticEmitted = false;
export function emitWindowsChangeRootDiagnostic(cwd: string, context: Pick<VerificationChangeContext, "reasons">): void {
  if (process.platform !== "win32" || diagnosticEmitted || !Array.isArray(context?.reasons) || !context.reasons.includes("workspace-is-not-git-root")) return;
  diagnosticEmitted = true;
  try {
  const deadline = performance.now() + 1000;
  const executable = Bun.which("git");
  const identity = (name: string) => {
    try {
      const canonical = realpathSync(name), stat = statSync(canonical, { bigint: true });
      return { canonical, directory: stat.isDirectory(), dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
    } catch { return { unavailable: true }; }
  };
  const invoke = (args: string[]) => {
    const remaining = Math.floor(deadline - performance.now());
    if (!executable || remaining < 1) return { unavailable: true };
    const result = spawnSync(executable, args, { cwd, env: { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"], timeout: remaining, maxBuffer: 65_536 });
    return { exit: result.status, signal: result.signal, errorCode: result.error && "code" in result.error ? result.error.code : null,
      stdout: result.stdout?.toString("utf8") ?? "", stderrBytes: result.stderr?.length ?? 0, stderrSHA256: createHash("sha256").update(result.stderr ?? Buffer.alloc(0)).digest("hex") };
  };
  const roots = invoke(["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=NUL", "-c", "core.attributesFile=NUL",
    "-c", "protocol.allow=never", "-c", "core.quotePath=false", "rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
  const receipt = { diagnostic: "change-context-windows-root-v1", observation: "Bounded companion invocation after actual reader root refusal; original child stdout was not instrumented",
    processCwd: process.cwd(), spawnCwd: cwd, selected: identity(cwd), executable, executableIdentity: executable ? identity(executable) : null,
    roots, rootIdentities: "stdout" in roots ? (roots.stdout ?? "").trimEnd().split("\n").slice(0, 3).map(identity) : [], version: invoke(["--version"]) };
  const encoded = JSON.stringify(receipt);
  console.error(Buffer.byteLength(encoded) <= 24_576 ? encoded : JSON.stringify({ diagnostic: receipt.diagnostic, unavailable: "receipt-byte-bound", bytes: Buffer.byteLength(encoded), sha256: createHash("sha256").update(encoded).digest("hex") }));
  } catch {
    // Diagnostics cannot replace the original production-path assertion failure.
    try { console.error(JSON.stringify({ diagnostic: "change-context-windows-root-v1", unavailable: "diagnostic-failed" })); } catch { /* Preserve the original assertion. */ }
  }
}

if (import.meta.main) await main();
