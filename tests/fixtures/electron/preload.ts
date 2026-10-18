import { installElectronPreload } from "../../../src/verification/adapters/electron/preload";
import { contextBridge, ipcRenderer } from "electron";
const token = process.argv.find(value => value.startsWith("--runphantom-electron="))?.split("=")[1] ?? "";
installElectronPreload({ contextBridge, ipcRenderer }, token, document);
