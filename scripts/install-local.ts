#!/usr/bin/env bun
/** Build, install, and smoke-test the host Run Phantom binary from this checkout. */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join(REPO_ROOT, "build", "bun");

interface Args {
  noBuild: boolean;
  installDir: string;
  port: number;
  skipSmoke: boolean;
}

function parseArgs(): Args {
  const parsed: Args = {
    noBuild: false,
    installDir: "/tmp/runphantom-local/bin",
    port: 5912,
    skipSmoke: false,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === "-h" || arg === "--help") {
      console.log([
        "Install Run Phantom from the current source checkout.",
        "",
        "USAGE",
        "    bun scripts/install-local.ts [OPTIONS]",
        "",
        "OPTIONS",
        "    --no-build          Reuse the existing host binary.",
        "    --install-dir=DIR   Install path (default: /tmp/runphantom-local/bin).",
        "    --port=N            Smoke-test port (default: 5912).",
        "    --skip-smoke        Skip daemon and embedded-UI verification.",
      ].join("\n"));
      process.exit(0);
    }
    if (arg === "--no-build") parsed.noBuild = true;
    else if (arg === "--skip-smoke") parsed.skipSmoke = true;
    else if (arg.startsWith("--install-dir=")) parsed.installDir = path.resolve(arg.slice(14));
    else if (arg.startsWith("--port=")) parsed.port = Number(arg.slice(7));
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(parsed.port) || parsed.port < 1024 || parsed.port > 65535) {
    throw new Error(`Invalid --port: ${parsed.port}`);
  }
  return parsed;
}

function hostTarget(): string {
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : null;
  if (!arch || !platform || (platform === "windows" && arch !== "x64")) {
    throw new Error(`Unsupported host: ${process.platform}-${process.arch}`);
  }
  return `${platform}-${arch}`;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

async function waitForHealth(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const health = await response.json() as { service?: string };
        if (health.service === "runphantom") return;
      }
    } catch {
      // The daemon may still be starting.
    }
    await Bun.sleep(150);
  }
  throw new Error(`Run Phantom did not become healthy at ${baseUrl}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const target = hostTarget();
  const extension = target.startsWith("windows-") ? ".exe" : "";
  const builtBinary = path.join(BUILD_DIR, `runphantom-bun-${target}${extension}`);

  if (!args.noBuild) run("bun", ["scripts/build-bun.ts", `--target=bun-${target}`]);
  if (!existsSync(builtBinary)) throw new Error(`Expected host binary at ${builtBinary}`);

  mkdirSync(args.installDir, { recursive: true });
  const installedBinary = path.join(args.installDir, `runphantom${extension}`);
  copyFileSync(builtBinary, installedBinary);
  if (process.platform !== "win32") chmodSync(installedBinary, 0o755);
  console.log(`[install-local] installed ${installedBinary}`);

  if (args.skipSmoke) return;

  const scratch = mkdtempSync(path.join(os.tmpdir(), "runphantom-smoke-"));
  const baseUrl = `http://127.0.0.1:${args.port}`;
  const daemon = spawn(installedBinary, ["serve"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RUNPHANTOM_PORT: String(args.port),
      RUNPHANTOM_DB_PATH: path.join(scratch, "runphantom.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  daemon.stdout.on("data", chunk => { logs += String(chunk); });
  daemon.stderr.on("data", chunk => { logs += String(chunk); });

  try {
    await waitForHealth(baseUrl);
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();
    if (!response.ok || !/<(?:!doctype|html)/i.test(html)) {
      throw new Error(`Embedded UI smoke failed with HTTP ${response.status}`);
    }
    const version = spawnSync(installedBinary, ["--version"], { encoding: "utf8" });
    if (version.status !== 0 || !version.stdout.trim()) throw new Error("Compiled binary version check failed");
    console.log(`[install-local] healthy ${baseUrl}; embedded UI and version checks passed`);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${logs.slice(-4000)}`);
  } finally {
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      const finish = () => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve();
      };
      if (daemon.exitCode !== null || daemon.signalCode !== null) {
        finish();
        return;
      }
      daemon.once("exit", finish);
      daemon.kill("SIGTERM");
      forceKillTimer = setTimeout(() => daemon.kill("SIGKILL"), 2_000);
    });
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
