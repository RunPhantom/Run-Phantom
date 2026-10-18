import { cpSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export function copyElectronBundle(source: string, destination: string): void {
  // Versioned framework links must stay relative to the copied app's resources.
  cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true });
}

export function prepareElectronFixtureBundle(source: string, destination: string): string {
  copyElectronBundle(source, destination);
  const executable = path.join(destination, "Contents/MacOS/CooperatingFixture");
  renameSync(path.join(destination, "Contents/MacOS/Electron"), executable);
  // Electron's native packaged-mode check uses the executable basename.
  const plist = path.join(destination, "Contents/Info.plist");
  for (const [key, value] of Object.entries({ CFBundleExecutable: "CooperatingFixture", CFBundleName: "CooperatingFixture",
    CFBundleDisplayName: "CooperatingFixture", CFBundleIdentifier: "com.runphantom.cooperating-fixture" })) {
    const result = spawnSync("/usr/bin/plutil", ["-replace", key, "-string", value, "--", plist], { timeout: 5000, stdio: "pipe" });
    if (result.status !== 0) throw new Error("Private Electron fixture identity preparation failed");
  }
  return executable;
}
