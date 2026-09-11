#!/usr/bin/env bun
/**
 * Generate latest.json for a release. Reads the binaries in build/bun and
 * writes a manifest with sha256 + size for each platform.
 *
 * Usage:
 *   bun scripts/generate-manifest.ts \\
 *     --version=1.4.2 \\
 *     --channel=stable \\
 *     --base-url=RUNPHANTOM_MANIFEST_URL \\
 *     --min-supported=1.0.0 \\
 *     --previous-manifest=./previous.json \\
 *     --out=./latest.json
 *
 * If --previous-manifest is given, the OTHER channel is preserved (so
 * stable releases don't blow away the beta entry, and vice versa).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PlatformKey = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "windows-x64";
type Channel = "stable" | "beta";

interface PlatformEntry {
  url: string;
  sha256: string;
  size: number;
  gzip?: {
    url: string;
    sha256: string;
    size: number;
  };
}

interface ChannelEntry {
  version: string;
  // Partial because --allow-missing (local testing) may produce a manifest
  // with only the host platform. Production (CI) always populates all 5.
  platforms: Partial<Record<PlatformKey, PlatformEntry>>;
}

interface Manifest {
  stable?: ChannelEntry;
  beta?: ChannelEntry;
  min_supported: string;
}

const PLATFORM_TO_BINARY: Record<PlatformKey, string> = {
  "darwin-arm64": "runphantom-bun-darwin-arm64",
  "darwin-x64": "runphantom-bun-darwin-x64",
  "linux-x64": "runphantom-bun-linux-x64",
  "linux-arm64": "runphantom-bun-linux-arm64",
  "windows-x64": "runphantom-bun-windows-x64.exe",
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join(REPO_ROOT, "build", "bun");

function parseArgs(): {
  version: string;
  channel: Channel;
  baseUrl: string;
  minSupported: string;
  previousManifest: string | null;
  out: string;
  allowMissing: boolean;
} {
  const argMap: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith("--")) {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
    const eq = a.indexOf("=");
    const k = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const v = eq === -1 ? "true" : a.slice(eq + 1);
    argMap[k] = v;
  }
  const required = ["version", "channel", "base-url", "min-supported", "out"];
  for (const r of required) {
    if (!argMap[r]) {
      console.error(`Missing required arg: --${r}`);
      process.exit(2);
    }
  }
  if (argMap.channel !== "stable" && argMap.channel !== "beta") {
    console.error(`--channel must be 'stable' or 'beta', got ${argMap.channel}`);
    process.exit(2);
  }
  return {
    version: argMap.version,
    channel: argMap.channel as Channel,
    baseUrl: argMap["base-url"].replace(/\/+$/, ""),
    minSupported: argMap["min-supported"],
    previousManifest: argMap["previous-manifest"] ?? null,
    out: argMap.out,
    // For local-install testing: skip platforms whose binary isn't on disk
    // instead of failing. CI never sets this; a missing binary in CI is a bug.
    allowMissing: argMap["allow-missing"] === "true",
  };
}

function sha256(filePath: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(filePath));
  return h.digest("hex");
}

function buildPlatform(baseUrl: string, key: PlatformKey): PlatformEntry | null {
  const filename = PLATFORM_TO_BINARY[key];
  const filePath = path.join(BUILD_DIR, filename);
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  const entry: PlatformEntry = {
    url: `${baseUrl}/${filename}`,
    sha256: sha256(filePath),
    size: stat.size,
  };
  const gzipPath = `${filePath}.gz`;
  try {
    const gzipStat = statSync(gzipPath);
    entry.gzip = {
      url: `${baseUrl}/${filename}.gz`,
      sha256: sha256(gzipPath),
      size: gzipStat.size,
    };
  } catch {
    // Gzip assets are optional so local manifests can still be generated from
    // raw binaries only. CI creates them before calling this script.
  }
  return entry;
}

function main(): void {
  const args = parseArgs();
  console.log(`[manifest] generating ${args.channel} ${args.version}`);

  const platformKeys: PlatformKey[] = [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
    "windows-x64",
  ];
  const platforms = {} as Partial<Record<PlatformKey, PlatformEntry>>;
  for (const key of platformKeys) {
    const entry = buildPlatform(args.baseUrl, key);
    if (entry) {
      platforms[key] = entry;
      const gzipSuffix = entry.gzip
        ? `, gzip ${(entry.gzip.size / 1024 / 1024).toFixed(1)} MB`
        : "";
      console.log(
        `[manifest]   ${key}: ${entry.sha256.slice(0, 16)}\u2026 ` +
          `(${(entry.size / 1024 / 1024).toFixed(1)} MB${gzipSuffix})`,
      );
    } else if (args.allowMissing) {
      console.log(`[manifest]   ${key}: (missing — skipped under --allow-missing)`);
    } else {
      console.error(
        `[manifest] missing binary for ${key}: ${path.join(BUILD_DIR, PLATFORM_TO_BINARY[key])}`,
      );
      process.exit(1);
    }
  }
  if (Object.keys(platforms).length === 0) {
    console.error(`[manifest] no platforms produced; aborting`);
    process.exit(1);
  }

  const channelEntry: ChannelEntry = { version: args.version, platforms };

  let prev: Manifest = { min_supported: args.minSupported };
  if (args.previousManifest) {
    try {
      prev = JSON.parse(readFileSync(args.previousManifest, "utf8")) as Manifest;
      console.log(`[manifest] preserving previous channel from ${args.previousManifest}`);
    } catch (e) {
      console.warn(`[manifest] could not read previous manifest: ${(e as Error).message}`);
    }
  }

  const manifest: Manifest = {
    min_supported: args.minSupported,
    ...(args.channel === "stable" ? { stable: channelEntry, beta: prev.beta } : {}),
    ...(args.channel === "beta" ? { stable: prev.stable, beta: channelEntry } : {}),
  };

  writeFileSync(args.out, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[manifest] wrote ${args.out}`);
}

main();
