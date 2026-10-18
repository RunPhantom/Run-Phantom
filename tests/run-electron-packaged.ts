import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

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
    const child = spawn(binary, [], { cwd: temp, env: { PATH: process.env.PATH, HOME: temp, TMPDIR: temp,
      RUNPHANTOM_ELECTRON_PROFILE: path.join(temp, "profile"), RUNPHANTOM_ELECTRON_CAPTURES: captures, RUNPHANTOM_ELECTRON_RECEIPT: receipt }, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0; child.stdout.on("data", chunk => { bytes += chunk.length; }); child.stderr.on("data", chunk => { bytes += chunk.length; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30000), kill = setTimeout(() => child.kill("SIGKILL"), 35000);
    let launchFailed = false;
    const terminal = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.once("error", () => { launchFailed = true; }); child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => { clearTimeout(timer); clearTimeout(kill); });
    if (launchFailed || terminal.code !== 0 || !existsSync(receipt)) throw new Error("Actual packaged Electron fixture failed");
    const proof = JSON.parse(readFileSync(receipt, "utf8"));
    if (proof.packaged !== true || proof.checked.verdict.status !== "pass" || proof.absent.verdict.status !== "inconclusive"
      || !proof.retired || !proof.windowDestroyed) throw new Error("Actual packaged Electron evidence is incomplete");
    cpSync(captures, path.join(output, "private-captures"), { recursive: true });
    writeFileSync(path.join(output, "receipt.json"), JSON.stringify({ ...proof, terminal, reaped: true, rawLogBytesDrained: bytes,
      sourceExecutableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"), fixtureOutsideCheckout: true }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: "PASSED", packaged: true, actualWindowPixels: true, pid: child.pid, reaped: true }));
    return 0;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
void run().then(code => { process.exitCode = code; }, () => { console.error(JSON.stringify({ status: "FAILED", code: "PACKAGED_FIXTURE_FAILED" })); process.exitCode = 1; });
