import { installElectronPreload } from "../../../src/verification/adapters/electron/preload";
import { ELECTRON_CHANNEL, parseElectronRequest } from "../../../src/verification/adapters/electron/contract";
import { contextBridge, ipcRenderer } from "electron";
const token = process.argv.find(value => value.startsWith("--runphantom-electron="))?.split("=")[1] ?? "";
ipcRenderer.send("f39:fixture:diagnostic", { phase: "preload-ready", tokenPresent: /^[a-f0-9]{64}$/.test(token), encoderType: typeof TextEncoder });
ipcRenderer.on(ELECTRON_CHANNEL + ":request", (_event: unknown, value: unknown) => {
  let requestValid = false;
  try { parseElectronRequest(value); requestValid = true; } catch { /* Record only fixed private fixture diagnostics. */ }
  ipcRenderer.send("f39:fixture:diagnostic", { phase: "request-observed", requestValid,
    prototypeMatches: !!value && Object.getPrototypeOf(value) === Object.prototype,
    tokenMatches: !!value && (value as { token?: unknown }).token === token, encoderType: typeof TextEncoder });
});
installElectronPreload({ contextBridge, ipcRenderer }, token, document);
