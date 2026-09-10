import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LABEL = "com.runphantom.daemon";
const SERVICE = "runphantom.service";

export interface RunPhantomStartupCommand {
  program: string;
  args: string[];
}

export interface RunPhantomStartupOptions {
  command: RunPhantomStartupCommand;
  platform?: NodeJS.Platform;
  homeDir?: string;
  runCommand?: (cmd: string, args: string[]) => { status: number | null; error?: unknown };
}

export interface RunPhantomStartupResult {
  ok: boolean;
  skipped?: boolean;
  message: string;
  file?: string;
}

export interface RunPhantomStartupDisableOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  runCommand?: (cmd: string, args: string[]) => { status: number | null; error?: unknown };
}

export interface RunPhantomStartupStopOptions {
  platform?: NodeJS.Platform;
  userId?: number;
  runCommand?: (cmd: string, args: string[]) => { status: number | null; error?: unknown };
}

function defaultRunCommand(cmd: string, args: string[]): { status: number | null; error?: unknown } {
  const result = spawnSync(cmd, args, { stdio: "ignore" });
  return { status: result.status, error: result.error };
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, "utf8") === content) return;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%")}"`;
}

function launchAgentPlist(homeDir: string, command: RunPhantomStartupCommand): string {
  const logPath = path.join(homeDir, ".runphantom", "runphantom.startup.log");
  const args = [command.program, ...command.args]
    .map((arg) => `    <string>${xml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function systemdService(command: RunPhantomStartupCommand): string {
  const execStart = [command.program, ...command.args].map(systemdQuote).join(" ");
  return `[Unit]
Description=Run Phantom local diagnostics daemon

[Service]
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function enableRunPhantomStartup(opts: RunPhantomStartupOptions): RunPhantomStartupResult {
  const platform = opts.platform ?? process.platform;
  const homeDir = opts.homeDir ?? os.homedir();
  const runCommand = opts.runCommand ?? defaultRunCommand;

  if (platform === "darwin") {
    const file = path.join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
    fs.mkdirSync(path.join(homeDir, ".runphantom"), { recursive: true });
    writeIfChanged(file, launchAgentPlist(homeDir, opts.command));
    return { ok: true, message: "Run Phantom will start automatically at login.", file };
  }

  if (platform === "linux") {
    const systemctl = runCommand("systemctl", ["--user", "--version"]);
    if (systemctl.status !== 0) {
      return { ok: false, skipped: true, message: "systemd user services are not available on this machine." };
    }

    const file = path.join(homeDir, ".config", "systemd", "user", SERVICE);
    writeIfChanged(file, systemdService(opts.command));

    const reload = runCommand("systemctl", ["--user", "daemon-reload"]);
    if (reload.status !== 0) {
      return { ok: false, message: "failed to reload systemd user services.", file };
    }
    const enable = runCommand("systemctl", ["--user", "enable", SERVICE]);
    if (enable.status !== 0) {
      return { ok: false, message: "failed to enable the Run Phantom user service.", file };
    }

    return { ok: true, message: "Run Phantom will start automatically at login.", file };
  }

  return { ok: false, skipped: true, message: `startup registration is not supported on ${platform}.` };
}

export function stopRunPhantomStartup(opts: RunPhantomStartupStopOptions = {}): RunPhantomStartupResult {
  const platform = opts.platform ?? process.platform;
  const runCommand = opts.runCommand ?? defaultRunCommand;

  if (platform === "darwin") {
    const userId = opts.userId ?? os.userInfo().uid;
    const result = runCommand("launchctl", ["bootout", `gui/${userId}/${LABEL}`]);
    if (result.status === 0) return { ok: true, message: "Run Phantom startup service stopped." };
    return { ok: true, skipped: true, message: "Run Phantom startup service was not running." };
  }

  if (platform === "linux") {
    const systemctl = runCommand("systemctl", ["--user", "--version"]);
    if (systemctl.status !== 0) {
      return { ok: false, skipped: true, message: "systemd user services are not available on this machine." };
    }
    const stop = runCommand("systemctl", ["--user", "stop", SERVICE]);
    if (stop.status === 0) return { ok: true, message: "Run Phantom startup service stopped." };
    return { ok: true, skipped: true, message: "Run Phantom startup service was not running." };
  }

  return { ok: false, skipped: true, message: `startup service stopping is not supported on ${platform}.` };
}

export function disableRunPhantomStartup(opts: RunPhantomStartupDisableOptions = {}): RunPhantomStartupResult {
  const platform = opts.platform ?? process.platform;
  const homeDir = opts.homeDir ?? os.homedir();
  const runCommand = opts.runCommand ?? defaultRunCommand;

  if (platform === "darwin") {
    const file = path.join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
    stopRunPhantomStartup({ platform, runCommand });
    fs.rmSync(file, { force: true });
    return { ok: true, message: "Run Phantom startup registration removed.", file };
  }

  if (platform === "linux") {
    const file = path.join(homeDir, ".config", "systemd", "user", SERVICE);
    const systemctl = runCommand("systemctl", ["--user", "--version"]);
    if (systemctl.status === 0) {
      runCommand("systemctl", ["--user", "disable", "--now", SERVICE]);
    }
    fs.rmSync(file, { force: true });
    if (systemctl.status === 0) {
      const reload = runCommand("systemctl", ["--user", "daemon-reload"]);
      if (reload.status !== 0) {
        return { ok: false, message: "failed to reload systemd user services.", file };
      }
    }
    return { ok: true, message: "Run Phantom startup registration removed.", file };
  }

  return { ok: false, skipped: true, message: `startup registration is not supported on ${platform}.` };
}
