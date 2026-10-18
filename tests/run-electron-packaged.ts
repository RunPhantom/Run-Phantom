import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { waitForElectronTerminal } from "./fixtures/electron/terminal";

async function run(): Promise<number> {
  const executable = process.env.RUNPHANTOM_ELECTRON_EXECUTABLE;
  if (!executable || !path.isAbsolute(executable) || !existsSync(executable)) {
    console.error(JSON.stringify({ status: "BLOCKED", code: "ELECTRON_RUNTIME_MISSING", executedElectron: false })); return 2;
  }
  const sourceBundle = path.resolve(path.dirname(executable), "../..");
  if (process.platform !== "darwin" || path.basename(sourceBundle) !== "Electron.app"
    || !existsSync(path.join(sourceBundle, "Contents/Resources/default_app.asar")) || !lstatSync(executable).isFile()) {
    console.error(JSON.stringify({ status: "BLOCKED", code: "PACKAGED_RUNTIME_UNSUPPORTED", executedElectron: false })); return 2;
  }
  const root = path.resolve(import.meta.dir, ".."), temp = mkdtempSync(path.join(os.tmpdir(), "rp-f39-packaged-"));
  const output = process.env.RUNPHANTOM_ELECTRON_EVIDENCE;
  if (!output || !path.isAbsolute(output)) { rmSync(temp, { recursive: true, force: true }); throw new Error("Explicit private evidence directory required"); }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  let cleanupConfirmed = true;
  try {
    const bundle = path.join(temp, "CooperatingFixture.app"); cpSync(sourceBundle, bundle, { recursive: true, dereference: false });
    const resources = path.join(bundle, "Contents/Resources"), fixture = path.join(resources, "app");
    rmSync(path.join(resources, "default_app.asar")); mkdirSync(fixture, { mode: 0o700 });
    writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "runphantom-cooperating-fixture", version: "1.0.0", main: "main.cjs" }));
    for (const entry of ["main", "preload"]) {
      const result = await Bun.build({ entrypoints: [path.join(root, `tests/fixtures/electron/${entry}.ts`)], target: "node", format: "cjs", external: ["electron"], naming: `${entry}.cjs`, outdir: fixture });
      if (!result.success) throw new Error("Electron fixture bundle failed");
    }
    const renderer = await Bun.build({ entrypoints: [path.join(root, "tests/fixtures/electron/renderer.ts")], target: "browser", naming: "renderer.js", outdir: fixture });
    if (!renderer.success) throw new Error("Electron renderer bundle failed");
    cpSync(path.join(root, "tests/fixtures/electron/index.html"), path.join(fixture, "index.html"));
    const captures = path.join(temp, "captures"), receipt = path.join(temp, "receipt.json"), binary = path.join(bundle, "Contents/MacOS/Electron");
    const child = spawn(binary, [], { cwd: temp, detached: true, env: { PATH: process.env.PATH, HOME: temp, TMPDIR: temp,
      RUNPHANTOM_ELECTRON_PROFILE: path.join(temp, "profile"), RUNPHANTOM_ELECTRON_CAPTURES: captures, RUNPHANTOM_ELECTRON_RECEIPT: receipt }, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, stdout = "", stderr = "";
    child.stdout.on("data", chunk => { bytes += chunk.length; stdout = (stdout + String(chunk)).slice(-65536); });
    child.stderr.on("data", chunk => { bytes += chunk.length; stderr = (stderr + String(chunk)).slice(-65536); });
    cleanupConfirmed = false;
    const terminal = await waitForElectronTerminal(child, {
      isGone: () => {
        if (!child.pid) return true;
        try { process.kill(-child.pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      },
      signal: signal => { if (!child.pid) return false; process.kill(-child.pid, signal); return true; },
    });
    cleanupConfirmed = terminal.status === "confirmed";
    const saveFailureDiagnostics = () => {
      // These are private fixture logs, never provider diagnostics or public output.
      const redact = (value: string) => value.replace(/[a-f0-9]{64}/gi, "[redacted]");
      writeFileSync(path.join(output, "fixture-stdout.txt"), redact(stdout), { mode: 0o600 });
      writeFileSync(path.join(output, "fixture-stderr.txt"), redact(stderr), { mode: 0o600 });
      if (existsSync(receipt) && lstatSync(receipt).isFile() && lstatSync(receipt).size <= 16384) {
        writeFileSync(path.join(output, "fixture-failure.json"), readFileSync(receipt), { mode: 0o600 });
      }
      writeFileSync(path.join(output, "failure-terminal.json"), JSON.stringify({ status: "FAILED", terminal,
        reaped: cleanupConfirmed, rawLogBytesDrained: bytes }, null, 2), { mode: 0o600 });
    };
    if (!cleanupConfirmed) {
      saveFailureDiagnostics();
      writeFileSync(path.join(output, "cleanup-unconfirmed.json"), JSON.stringify({ status: "FAILED", code: "PROCESS_TERMINATION_UNCONFIRMED",
        terminal, pid: child.pid, ownedProcessGroup: child.pid, reaped: false, retained: true, retainedTemp: temp,
        retainedProfile: path.join(temp, "profile"), rawLogBytesDrained: bytes }, null, 2), { mode: 0o600 });
      console.error(JSON.stringify({ status: "FAILED", code: "PROCESS_TERMINATION_UNCONFIRMED", reaped: false, retained: true }));
      return 1;
    }
    if (terminal.launchFailed || terminal.code !== 0 || !existsSync(receipt)) { saveFailureDiagnostics(); throw new Error("Actual packaged Electron fixture failed"); }
    const proof = JSON.parse(readFileSync(receipt, "utf8"));
    if (proof.packaged !== true || proof.checked.verdict.status !== "pass" || proof.absent.verdict.status !== "inconclusive"
      || proof.captureCleanup?.nativeCapture !== "settled" || !proof.retired || !proof.windowDestroyed) throw new Error("Actual packaged Electron evidence is incomplete");
    cpSync(captures, path.join(output, "private-captures"), { recursive: true });
    rmSync(temp, { recursive: true, force: true });
    if (existsSync(temp)) throw new Error("Private fixture cleanup is unconfirmed");
    writeFileSync(path.join(output, "receipt.json"), JSON.stringify({ ...proof, terminal, reaped: true, rawLogBytesDrained: bytes,
      sourceExecutableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"), fixtureOutsideCheckout: true, privateTempRemoved: true }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: "PASSED", packaged: true, actualWindowPixels: true, pid: child.pid, reaped: true }));
    return 0;
  } finally { if (cleanupConfirmed) rmSync(temp, { recursive: true, force: true }); }
}
void run().then(code => { process.exitCode = code; }, () => { console.error(JSON.stringify({ status: "FAILED", code: "PACKAGED_FIXTURE_FAILED" })); process.exitCode = 1; });
