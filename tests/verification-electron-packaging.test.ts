import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { prepareElectronFixtureBundle } from "./fixtures/electron/bundle";

test.skipIf(process.platform !== "darwin")("private copied app identity names the actual renamed executable without changing its bytes", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "rp-f39-identity-"));
  const source = path.join(temporary, "Electron.app"), copied = path.join(temporary, "CooperatingFixture.app");
  try {
    mkdirSync(path.join(source, "Contents/MacOS"), { recursive: true });
    writeFileSync(path.join(source, "Contents/MacOS/Electron"), "controlled-binary-bytes", { mode: 0o755 });
    const plist = '<?xml version="1.0"?><plist version="1.0"><dict>' +
      ["CFBundleExecutable", "CFBundleName", "CFBundleDisplayName", "CFBundleIdentifier"].map(key => `<key>${key}</key><string>Electron</string>`).join("") + "</dict></plist>";
    writeFileSync(path.join(source, "Contents/Info.plist"), plist);
    const executable = prepareElectronFixtureBundle(source, copied);
    expect(executable).toBe(path.join(copied, "Contents/MacOS/CooperatingFixture"));
    expect(readFileSync(executable)).toEqual(readFileSync(path.join(source, "Contents/MacOS/Electron")));
    expect(existsSync(path.join(copied, "Contents/MacOS/Electron"))).toBe(false);
    expect(readFileSync(path.join(source, "Contents/Info.plist"), "utf8")).toBe(plist);
    for (const [key, expected] of Object.entries({ CFBundleExecutable: "CooperatingFixture", CFBundleName: "CooperatingFixture",
      CFBundleDisplayName: "CooperatingFixture", CFBundleIdentifier: "com.runphantom.cooperating-fixture" })) {
      const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-n", "--", path.join(copied, "Contents/Info.plist")], { encoding: "utf8", timeout: 5000 });
      expect(result.status).toBe(0); expect(result.stdout).toBe(expected);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("actual bundled fixture resolves preload and renderer siblings from the runtime app directory; this is a controlled loader, not Electron proof", async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "rp-f39-loader-"));
  const fixture = path.join(temporary, "CooperatingFixture.app/Contents/Resources/app");
  mkdirSync(fixture, { recursive: true });
  const source = path.join(import.meta.dir, "fixtures/electron");
  try {
    for (const entry of ["main", "preload"]) {
      const result = await Bun.build({ entrypoints: [path.join(source, `${entry}.ts`)], target: "node", format: "cjs", external: ["electron"], naming: `${entry}.cjs`, outdir: fixture });
      expect(result.success).toBe(true);
    }
    const renderer = await Bun.build({ entrypoints: [path.join(source, "renderer.ts")], target: "browser", naming: "renderer.js", outdir: fixture });
    expect(renderer.success).toBe(true);
    copyFileSync(path.join(source, "index.html"), path.join(fixture, "index.html"));
    let preload = "", document = "", destroyed = false, exitCode: number | undefined;
    let exited!: () => void;
    const exit = new Promise<void>(resolve => { exited = resolve; });
    class ControlledWindow extends EventEmitter {
      webContents = { mainFrame: {}, setWindowOpenHandler() {}, on() {} };
      constructor(options: { webPreferences: { preload: string } }) { super(); preload = options.webPreferences.preload; }
      async loadURL(url: string) { document = url; throw new Error("CONTROLLED_STOP_BEFORE_IPC"); }
      isDestroyed() { return destroyed; }
      destroy() { destroyed = true; this.emit("closed"); }
    }
    const electron = { app: { setPath() {}, whenReady: async () => {}, getAppPath: () => fixture, isPackaged: false,
      exit: (code: number) => { exitCode = code; exited(); } }, BrowserWindow: ControlledWindow, ipcMain: new EventEmitter() };
    const require = createRequire(import.meta.url);
    runInNewContext(readFileSync(path.join(fixture, "main.cjs"), "utf8"), {
      require: (name: string) => name === "electron" ? electron : require(name), module: { exports: {} }, exports: {},
      process: { env: { RUNPHANTOM_ELECTRON_PROFILE: path.join(temporary, "profile"), RUNPHANTOM_ELECTRON_RECEIPT: path.join(temporary, "receipt.json") },
        versions: { electron: "controlled-loader" }, pid: 1 },
      Buffer, TextEncoder, TextDecoder, URL, setTimeout, clearTimeout, setInterval, clearInterval, console: { error() {} },
    }, { timeout: 1000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Controlled loader did not terminate")), 1000); })]); }
    finally { clearTimeout(timer); }
    expect(exitCode).toBe(1); expect(destroyed).toBe(true);
    expect(preload).toBe(path.join(fixture, "preload.cjs"));
    expect(document).toBe(pathToFileURL(path.join(fixture, "index.html")).href);
    expect(existsSync(preload)).toBe(true);
    expect(readFileSync(path.join(fixture, "index.html"), "utf8")).toContain('src="renderer.js"');
    expect(readFileSync(path.join(fixture, "renderer.js"), "utf8")).toContain("The scoped application action completed.");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
