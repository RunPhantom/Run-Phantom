import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { BrowserArtifactStore } from "../../../src/verification/browser-artifacts";
import { CooperatingElectronSession, createElectronAuthority } from "../../../src/verification/adapters/electron/main";
import { ELECTRON_CHANNEL, ElectronVerificationError } from "../../../src/verification/adapters/electron/contract";
import { app, BrowserWindow, ipcMain } from "electron";

app.setPath("userData", process.env.RUNPHANTOM_ELECTRON_PROFILE!);
let stage = "application-ready";
const preloadErrors: Array<{ name: string; message: string }> = [];
const diagnostics: Record<string, string | boolean>[] = [];
const diagnosticText = (value: string) => value.slice(0, 1024).replace(/[a-f0-9]{64}/gi, "[redacted]");
async function run() {
  await app.whenReady();
  stage = "create-window";
  const authority = createElectronAuthority();
  const window = new BrowserWindow({ width: 640, height: 480, show: true, title: "Run Phantom cooperating fixture",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false,
      additionalArguments: [`--runphantom-electron=${authority}`], partition: "f39-private-fixture" } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const diagnostic = (event: { sender: unknown; senderFrame: unknown }, value: Record<string, unknown>) => {
    if (event.sender !== window.webContents || diagnostics.length >= 12) return;
    const row: Record<string, string | boolean> = { phase: typeof value.phase === "string" ? value.phase.slice(0, 32) : "unknown",
      senderMatches: true, frameMatches: event.senderFrame === window.webContents.mainFrame };
    for (const key of ["tokenPresent", "requestValid", "prototypeMatches", "tokenMatches"]) if (typeof value[key] === "boolean") row[key] = value[key];
    if (typeof value.encoderType === "string") row.encoderType = value.encoderType.slice(0, 16);
    diagnostics.push(row);
  };
  const replyObserved = (event: { sender: unknown; senderFrame: unknown }, value: { token?: unknown }) => {
    if (event.sender === window.webContents && diagnostics.length < 12) diagnostics.push({ phase: "reply-observed", senderMatches: true,
      frameMatches: event.senderFrame === window.webContents.mainFrame, tokenMatches: value.token === authority,
      prototypeMatches: Object.getPrototypeOf(value) === Object.prototype });
  };
  ipcMain.on("f39:fixture:diagnostic", diagnostic); ipcMain.on(ELECTRON_CHANNEL + ":reply", replyObserved);
  window.webContents.on("preload-error", (_event: unknown, _path: string, error: Error) => {
    if (preloadErrors.length < 4) preloadErrors.push({ name: diagnosticText(error.name), message: diagnosticText(error.message) });
  });
  window.webContents.on("will-navigate", (event: { preventDefault(): void }) => event.preventDefault());
  const url = pathToFileURL(path.join(__dirname, "index.html")).href;
  let owner: CooperatingElectronSession | undefined;
  try {
    stage = "load-document";
    await window.loadURL(url);
    stage = "create-authority";
    owner = new CooperatingElectronSession({ ipcMain }, window, authority, url,
      new BrowserArtifactStore(process.env.RUNPHANTOM_ELECTRON_CAPTURES!));
    stage = "read-status"; const before = await owner.request(1, { type: "read", selector: "#status" });
    stage = "click-confirm"; const action = await owner.request(1, { type: "click", selector: "#confirm" });
    stage = "check-outcome"; const checked = await owner.check(1, { kind: "element", selector: "#complete", state: "present" });
    if (checked.verdict.status !== "pass") throw new Error("Actual fixture outcome was not captured");
    stage = "check-absence"; const absent = await owner.check(1, { kind: "element", selector: "#missing", state: "absent" });
    if (absent.verdict.status !== "inconclusive") throw new Error("Missing network coverage was hidden");
    stage = "capture-window"; const capture = await owner.capture(1, true);
    stage = "retire-authority"; const captureCleanup = await owner.close();
    if (captureCleanup.nativeCapture !== "settled") throw new Error("Native capture completion is unconfirmed");
    let retired = false;
    try { void owner.request(1, { type: "click", selector: "#confirm" }); } catch { retired = true; }
    stage = "destroy-window"; const closed = once(window, "closed"); window.destroy(); await closed;
    writeFileSync(process.env.RUNPHANTOM_ELECTRON_RECEIPT!, JSON.stringify({ backend: "cooperating-electron", packaged: app.isPackaged,
      electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, pid: process.pid,
      before, action, checked, absent, capture, captureCleanup, retired, windowDestroyed: window.isDestroyed(), inputMode: "cooperating-dom",
      authoritySource: "explicit BrowserWindow/main frame", arbitraryNativeAutomation: false }, null, 2), { mode: 0o600 });
  } finally {
    ipcMain.removeListener("f39:fixture:diagnostic", diagnostic); ipcMain.removeListener(ELECTRON_CHANNEL + ":reply", replyObserved);
    await owner?.close();
    if (!window.isDestroyed()) { const closed = once(window, "closed"); window.destroy(); await closed; }
  }
}
void run().then(() => app.exit(0), (error: unknown) => {
  writeFileSync(process.env.RUNPHANTOM_ELECTRON_RECEIPT!, JSON.stringify({ status: "FAILED", stage, preloadErrors, diagnostics,
    packaged: app.isPackaged, electron: process.versions.electron, pid: process.pid,
    failure: error instanceof ElectronVerificationError ? error.code : "FIXTURE_FAILED",
    errorName: error instanceof Error ? diagnosticText(error.name) : "unknown" }), { mode: 0o600 });
  console.error("F39_FIXTURE_FAILED"); app.exit(1);
});
