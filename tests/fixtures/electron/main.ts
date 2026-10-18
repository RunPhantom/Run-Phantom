import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { BrowserArtifactStore } from "../../../src/verification/browser-artifacts";
import { CooperatingElectronSession, createElectronAuthority } from "../../../src/verification/adapters/electron/main";
import { app, BrowserWindow, ipcMain } from "electron";

app.setPath("userData", process.env.RUNPHANTOM_ELECTRON_PROFILE!);
async function run() {
  await app.whenReady();
  const authority = createElectronAuthority();
  const window = new BrowserWindow({ width: 640, height: 480, show: true, title: "Run Phantom cooperating fixture",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false,
      additionalArguments: [`--runphantom-electron=${authority}`], partition: "f39-private-fixture" } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event: { preventDefault(): void }) => event.preventDefault());
  const url = pathToFileURL(path.join(__dirname, "index.html")).href;
  let owner: CooperatingElectronSession | undefined;
  try {
    await window.loadURL(url);
    owner = new CooperatingElectronSession({ ipcMain }, window, authority, url,
      new BrowserArtifactStore(process.env.RUNPHANTOM_ELECTRON_CAPTURES!));
    const before = await owner.request(1, { type: "read", selector: "#status" });
    const action = await owner.request(1, { type: "click", selector: "#confirm" });
    const checked = await owner.check(1, { kind: "element", selector: "#complete", state: "present" });
    if (checked.verdict.status !== "pass") throw new Error("Actual fixture outcome was not captured");
    const absent = await owner.check(1, { kind: "element", selector: "#missing", state: "absent" });
    if (absent.verdict.status !== "inconclusive") throw new Error("Missing network coverage was hidden");
    const capture = await owner.capture(1, true);
    const captureCleanup = await owner.close();
    if (captureCleanup.nativeCapture !== "settled") throw new Error("Native capture completion is unconfirmed");
    let retired = false;
    try { void owner.request(1, { type: "click", selector: "#confirm" }); } catch { retired = true; }
    const closed = once(window, "closed"); window.destroy(); await closed;
    writeFileSync(process.env.RUNPHANTOM_ELECTRON_RECEIPT!, JSON.stringify({ backend: "cooperating-electron", packaged: app.isPackaged,
      electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, pid: process.pid,
      before, action, checked, absent, capture, captureCleanup, retired, windowDestroyed: window.isDestroyed(), inputMode: "cooperating-dom",
      authoritySource: "explicit BrowserWindow/main frame", arbitraryNativeAutomation: false }, null, 2), { mode: 0o600 });
  } finally {
    await owner?.close();
    if (!window.isDestroyed()) { const closed = once(window, "closed"); window.destroy(); await closed; }
  }
}
void run().then(() => app.exit(0), () => { console.error("F39_FIXTURE_FAILED"); app.exit(1); });
