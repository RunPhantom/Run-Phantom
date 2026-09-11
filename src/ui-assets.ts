/**
 * UI asset embedding for the compiled `runphantom` binary.
 *
 * Vite outputs ~300 hashed chunks under `app/dist/`. The build script tars
 * that directory into `build/ui-bundle.tgz`, which `ui-assets.compiled.ts`
 * embeds into the compiled binary via Bun's `with { type: "file" }`
 * import attribute. On first daemon start we extract once into
 * `~/.runphantom/ui-cache/<VERSION>/` and serve from there with
 * `express.static`. Source-mode dev (`bun src/index.ts serve`)
 * skips the embed entirely and serves `app/dist` directly off the on-disk
 * Vite output.
 *
 * Why the split with ui-assets.compiled.ts: that file's static
 * `with { type: "file" }` import requires `build/ui-bundle.tgz` to exist
 * at module-load time. Source-mode test runs (`bun test`) do NOT have
 * that file (it's a build artifact). Loading it via dynamic
 * `await import()` inside the compiled-mode branch below keeps
 * source-mode resilient to a missing tarball while letting Bun's
 * compile-time bundler embed the asset for production binaries (Bun
 * follows dynamic imports with static string specifiers and preserves
 * import attributes through them).
 */
import path from "path";
import fs from "fs";
import os from "os";
import { spawnSync } from "child_process";
import { SOURCE_UI_DIR } from "./source-paths";
import { IS_PACKAGED_RUNTIME, VERSION } from "./version";

let cachedUiDir: string | null = null;

/**
 * Returns a directory containing the built UI assets.
 *
 *   - Source mode: `<repo>/app/dist`, served live as Vite produces it.
 *   - Compiled mode: extract the embedded tarball once into
 *     `~/.runphantom/ui-cache/<VERSION>/dist` and return that path. We key
 *     by VERSION because each release ships a distinct UI bundle and old
 *     caches are correctly invalidated on upgrade. For local dev builds
 *     (`*-local` versions), we always re-extract so iterative
 *     `bun run install:local` doesn't serve stale UI from a previous build.
 */
export async function resolveBuiltAppDir(): Promise<string> {
  if (cachedUiDir) return cachedUiDir;

  if (!IS_PACKAGED_RUNTIME) {
    cachedUiDir = SOURCE_UI_DIR;
    return cachedUiDir;
  }

  const cacheRoot = path.join(os.homedir(), ".runphantom", "ui-cache", VERSION);
  const distDir = path.join(cacheRoot, "dist");
  const indexHtml = path.join(distDir, "index.html");
  const isLocalBuild = VERSION.endsWith("-local");

  if (!isLocalBuild && fs.existsSync(indexHtml)) {
    cachedUiDir = distDir;
    return cachedUiDir;
  }

  // Atomic extract: stage to a sibling tmp dir, then rename onto cacheRoot.
  // POSIX rename of a directory onto a non-existent target is atomic, so
  // even if two daemon-start invocations race we end up with a consistent
  // cache directory (the loser's tmp dir is cleaned up below).
  fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });
  const tmp = `${cacheRoot}.extract.${process.pid}.${Date.now()}`;
  fs.mkdirSync(tmp, { recursive: true });

  // The embedded asset lives in Bun's in-binary virtual fs (path looks like
  // /$bunfs/root/<hash>.tgz) — `fs.readFileSync` is shimmed by Bun so it
  // resolves correctly, but an external `tar` process can't see that path.
  // Solution: pull the bytes through Bun's fs and pipe them to `tar -xzf -`
  // via stdin. Works on macOS BSD tar and GNU tar identically.
  //
  // Lazy dynamic import of the compiled-mode-only module: only reached on
  // the compiled-binary branch above, so source-mode runs never resolve
  // ../build/ui-bundle.tgz. Bun's bundler embeds the asset for compiled
  // binaries; the dynamic import preserves the `with { type: "file" }`
  // attribute correctly through compile-time bundling.
  const { bundlePath } = await import("./ui-assets.compiled");
  const bundleBytes = fs.readFileSync(bundlePath);
  const extract = spawnSync("tar", ["-xzf", "-", "-C", tmp], {
    input: bundleBytes,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (extract.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const stderr = extract.stderr?.toString("utf8") ?? "";
    const stdout = extract.stdout?.toString("utf8") ?? "";
    throw new Error(
      `[ui] failed to extract embedded UI bundle (tar exit=${extract.status}):\n${stdout}${stderr}`,
    );
  }

  if (isLocalBuild && fs.existsSync(cacheRoot)) {
    // Local-dev mode: replace any prior extraction so iterative builds see
    // fresh UI. Only kicks in for *-local VERSIONs so released installs
    // never pay this cost.
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }

  try {
    fs.renameSync(tmp, cacheRoot);
  } catch (err) {
    if (fs.existsSync(indexHtml)) {
      // Race: another process extracted first. Discard our tmp and use theirs.
      fs.rmSync(tmp, { recursive: true, force: true });
    } else {
      throw err;
    }
  }

  cachedUiDir = distDir;
  return cachedUiDir;
}
