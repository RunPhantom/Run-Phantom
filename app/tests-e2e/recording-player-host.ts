import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function startRecordingPlayerHost() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const scratch = mkdtempSync(join(tmpdir(), "rp-recording-player-")), assets = join(scratch, "assets"); mkdirSync(assets);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.includes("API_KEY") && !key.startsWith("RUNPHANTOM_")));
  const env = { ...environment, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GOOGLE_API_KEY: "" };
  const compile = spawnSync("bun", ["build", "app/tests-e2e/recording-player-fixture.tsx", "--target=browser", `--outdir=${assets}`], { cwd: repo, env, encoding: "utf8" });
  if (compile.status !== 0) { rmSync(scratch, { recursive: true, force: true }); throw new Error(`Real component bundle failed: ${compile.stderr}`); }
  const appRequire = createRequire(join(repo, "app/package.json"));
  const style = spawnSync("node", [appRequire.resolve("tailwindcss/lib/cli.js"), "--config", "tailwind.config.js", "--input", "src/index.css", "--output", join(assets, "theme.css")], { cwd: join(repo, "app"), env, encoding: "utf8" });
  if (style.status !== 0) { rmSync(scratch, { recursive: true, force: true }); throw new Error(`Actual theme compilation failed: ${style.stderr}`); }
  const secret = randomBytes(32).toString("hex");
  const child = spawn("bun", ["--no-env-file", "tests/fixtures/recording-player-daemon.ts"], { cwd: repo, env: { ...env, RUNPHANTOM_RECORDING_FIXTURE_ASSETS: assets, RUNPHANTOM_RECORDING_FIXTURE_TOKEN: secret }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>(resolveExit => child.once("close", () => resolveExit()));
  let diagnostic = "", ready = "";
  child.stderr.on("data", (data: Buffer) => { if (diagnostic.length < 4096) diagnostic += data.toString(); });
  let receipt: { origin: string; pid: number; profile: string; database: string };
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM"); const force = setTimeout(() => child.kill("SIGKILL"), 5000); await exited; clearTimeout(force);
    }
  }
  try {
    receipt = await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Private recording fixture did not start: ${diagnostic}`)), 10000);
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(`Private recording fixture exited: ${diagnostic}`)); });
      child.stdout.on("data", (data: Buffer) => {
        if (ready.length > 4096) { clearTimeout(timeout); reject(new Error("Private fixture readiness exceeded its bound")); return; }
        ready += data.toString(); if (ready.includes("\n")) { clearTimeout(timeout); try { resolveReady(JSON.parse(ready.split("\n")[0])); } catch { reject(new Error("Invalid private fixture readiness")); } }
      });
    });
  } catch (cause) { await stop(); rmSync(scratch, { recursive: true, force: true }); throw cause; }
  return { ...receipt, headers: { "x-recording-fixture-token": secret },
    async close(proofFile: string) {
      await stop(); let reaped = false; try { process.kill(receipt.pid, 0); } catch { reaped = true; }
      const profileGone = !existsSync(receipt.profile); rmSync(scratch, { recursive: true, force: true });
      writeFileSync(proofFile, JSON.stringify({ execution: "inactive recording component fixture", pid: receipt.pid, reaped, profileGone, assetsGone: !existsSync(scratch), providers: "blank", exitCode: child.exitCode, signal: child.signalCode }, null, 2));
      if (!reaped || !profileGone) throw new Error("Owned recording fixture cleanup was incomplete");
    },
  };
}
