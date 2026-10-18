import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserArtifactStore } from "../src/verification/browser-artifacts";
import { CooperatingElectronSession, createElectronAuthority, type CooperatingWindow } from "../src/verification/adapters/electron/main";
import { ELECTRON_CHANNEL, parseElectronRequest, ElectronVerificationError } from "../src/verification/adapters/electron/contract";
import { installElectronPreload } from "../src/verification/adapters/electron/preload";

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ElectronVerificationError);
  expect((caught as Error).message).toContain(code);
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rp-electron-contract-")), ipcMain = new EventEmitter(), contents = new EventEmitter();
  const url = "file:///owned-fixture/index.html", token = createElectronAuthority(), mainFrame = { url };
  let sent: ReturnType<typeof parseElectronRequest>, captureResolve: ((value: any) => void) | undefined;
  const webContents = Object.assign(contents, { mainFrame, isDestroyed: () => false, getURL: () => url,
    getLastWebPreferences: () => ({ contextIsolation: true, nodeIntegration: false, sandbox: true }),
    send: (_channel: string, value: unknown) => { sent = parseElectronRequest(value); },
    capturePage: () => new Promise<any>(resolve => { captureResolve = resolve; }),
  });
  const window = { isDestroyed: () => false, getContentBounds: () => ({ width: 320, height: 240 }), webContents };
  const session = new CooperatingElectronSession({ ipcMain }, window as CooperatingWindow, token, url, new BrowserArtifactStore(directory));
  const reply = (result: unknown, sender = webContents, senderFrame = mainFrame) => ipcMain.emit(ELECTRON_CHANNEL + ":reply",
    { sender, senderFrame }, { token, id: sent.id, generation: 1, ok: true, result });
  return { session, window, ipcMain, webContents, reply, sent: () => sent, finishCapture: (value: any) => captureResolve!(value),
    cleanup: async () => { await session.close(); rmSync(directory, { recursive: true, force: true }); } };
}

describe("cooperating Electron authority and existing evidence contracts", () => {
  test("isolated preload exposes no IPC sender and withholds private descendants in controlled DOM reads", () => {
    const token = createElectronAuthority(), ipc = new EventEmitter(), replies: any[] = [];
    let exposed: any, privateDescendant = false;
    const document = { querySelectorAll: () => [{ textContent: "public", closest: () => null,
      querySelector: () => privateDescendant ? {} : null }] } as unknown as Document;
    const dispose = installElectronPreload({ contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
      ipcRenderer: { on: (channel, listener) => { ipc.on(channel, listener); }, removeListener: (channel, listener) => { ipc.removeListener(channel, listener); },
        send: (_channel, value) => { replies.push(value); } } }, token, document);
    const request = { token, id: 1, generation: 1, operation: { type: "read", selector: "#source" } };
    expect(Object.keys(exposed)).toEqual(["capabilities"]); expect(exposed.capabilities().inputMode).toBe("cooperating-dom");
    ipc.emit(ELECTRON_CHANNEL + ":request", {}, { ...request, token: "b".repeat(64) }); expect(replies).toHaveLength(0);
    ipc.emit(ELECTRON_CHANNEL + ":request", {}, request); expect(replies[0]).toMatchObject({ ok: true, result: { count: 1, text: "public" } });
    privateDescendant = true; ipc.emit(ELECTRON_CHANNEL + ":request", {}, { ...request, id: 2 });
    expect(replies[1]).toMatchObject({ ok: false, code: "PRIVATE_TARGET" });
    dispose(); dispose(); expect(ipc.listenerCount(ELECTRON_CHANNEL + ":request")).toBe(0);
  });
  test("the closed protocol never accepts native IDs, evaluation, paths or accessor execution", () => {
    const request = { token: "a".repeat(64), id: 1, generation: 1, operation: { type: "click", selector: "#pay" } };
    expect(parseElectronRequest(request)).toEqual(request);
    for (const operation of [{ type: "evaluate", selector: "#pay", script: "process.exit()" }, { type: "click", selector: "#pay", windowId: 4 },
      { type: "capture", path: "/tmp/public.png" }, { type: "fill", selector: "#pay", value: "secret" }]) expect(() => parseElectronRequest({ ...request, operation })).toThrow("INVALID_REQUEST");
    let reads = 0;
    expect(() => parseElectronRequest({ ...request, get operation() { reads++; return request.operation; } })).toThrow("INVALID_REQUEST");
    expect(reads).toBe(0);
  });
  test("other windows, subframes, wrong nonces and stale request identities cannot answer", async () => {
    const f = fixture();
    try {
      const operation = f.session.request(1, { type: "read", selector: "#done" });
      let answered = false; void operation.then(() => { answered = true; });
      f.reply({ count: 9, text: "forged" }, {} as typeof f.webContents);
      f.reply({ count: 9, text: "forged" }, f.webContents, { url: f.window.webContents.getURL() });
      f.ipcMain.emit(ELECTRON_CHANNEL + ":reply", { sender: f.webContents, senderFrame: f.webContents.mainFrame },
        { id: f.sent().id, generation: 1, token: "b".repeat(64), ok: true, result: { count: 9, text: "forged" } });
      await Promise.resolve(); expect(answered).toBe(false);
      f.reply({ count: 1, text: "done" }); expect(await operation).toEqual({ count: 1, text: "done", complete: true });
    } finally { await f.cleanup(); }
  });
  test("real core predicates keep dispatch separate from outcome and missing coverage inconclusive", async () => {
    const f = fixture();
    try {
      const action = f.session.request(1, { type: "click", selector: "#pay" }); f.reply({ dispatched: true });
      expect(await action).toMatchObject({ dispatch: "completed", inputMode: "cooperating-dom" });
      const positive = f.session.check(1, { kind: "element", selector: "#done", state: "present" }); f.reply({ count: 1, text: "Paid" });
      expect((await positive).verdict.status).toBe("pass");
      const absent = f.session.check(1, { kind: "element", selector: "#done", state: "absent" }); f.reply({ count: 0, text: "" });
      expect((await absent).verdict.status).toBe("inconclusive");
      expect((await f.session.check(1, { kind: "network", urlContains: "/payment", status: 200 })).verdict.status).toBe("inconclusive");
    } finally { await f.cleanup(); }
  });
  test("navigation closes authority, rejects held work and removes only its own listeners", async () => {
    const f = fixture(), unrelated = () => {};
    f.ipcMain.on(ELECTRON_CHANNEL + ":reply", unrelated);
    try {
      const pending = f.session.request(1, { type: "read", selector: "#done" });
      f.webContents.emit("did-start-navigation");
      await expectFailure(pending, "CLOSED");
      expect(() => f.session.request(1, { type: "click", selector: "#pay" })).toThrow("CLOSED");
      expect(f.ipcMain.listeners(ELECTRON_CHANNEL + ":reply")).toEqual([unrelated]);
    } finally { await f.cleanup(); }
  });
  test("redacted or malformed IPC results cannot prove an outcome", async () => {
    const f = fixture();
    try {
      const check = f.session.check(1, { kind: "element", selector: "#done", state: "present" });
      f.reply({ count: 1, text: "authorization: Bearer abcdef0123456789012345" });
      expect((await check).verdict.status).toBe("inconclusive");
      const malformed = f.session.request(1, { type: "read", selector: "#done" }); f.reply({ count: -1, text: "" });
      await expectFailure(malformed, "UNAVAILABLE");
      expect(() => f.session.request(2, { type: "read", selector: "#done" })).toThrow("STALE_DOCUMENT");
    } finally { await f.cleanup(); }
  });
  test("capture requires consent, cannot race work, and retired pixels are never admitted", async () => {
    const f = fixture();
    try {
      await expectFailure(f.session.capture(1, false as true), "INVALID_REQUEST");
      const capture = f.session.capture(1, true);
      expect(() => f.session.request(1, { type: "read", selector: "#done" })).toThrow("BUSY");
      const closed = f.session.close();
      f.finishCapture({ isEmpty: () => false, getSize: () => ({ width: 320, height: 240 }), toPNG: () => { throw new Error("Retired capture must not serialize"); } });
      await expectFailure(capture, "CLOSED"); await closed;
      expect(f.session.artifacts.list()).toEqual([]);
    } finally { await f.cleanup(); }
  });
  test("native capture ownership survives caller retirement and concurrent close shares unconfirmed cleanup", async () => {
    const f = fixture(), unrelated = () => {};
    f.ipcMain.on(ELECTRON_CHANNEL + ":reply", unrelated);
    let serialized = false;
    try {
      const capture = f.session.capture(1, true), first = f.session.close(15), second = f.session.close(5000);
      expect(first).toBe(second);
      await expectFailure(capture, "CLOSED");
      const cleanup = await first;
      expect(cleanup).toEqual({ authority: "retired", nativeCapture: "unconfirmed", pendingNativeCaptures: 1, nativeCancellation: "unsupported" });
      expect(await second).toBe(cleanup);
      expect(f.window.isDestroyed()).toBe(false);
      expect(f.ipcMain.listeners(ELECTRON_CHANNEL + ":reply")).toEqual([unrelated]);
      f.finishCapture({ isEmpty: () => false, getSize: () => ({ width: 320, height: 240 }), toPNG: () => { serialized = true; return Buffer.alloc(0); } });
      await Promise.resolve(); await Promise.resolve();
      expect(serialized).toBe(false); expect(f.session.artifacts.list()).toEqual([]);
      expect(() => f.session.request(1, { type: "read", selector: "#done" })).toThrow("CLOSED");
    } finally { await f.cleanup(); }
  });
  test("a caller timeout cannot confirm cleanup until the actual native capture settles", async () => {
    const f = fixture();
    let finished = false;
    try {
      await expectFailure(f.session.capture(1, true), "TIMEOUT");
      const closing = f.session.close();
      void closing.then(() => { finished = true; });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(finished).toBe(false);
      f.finishCapture({ isEmpty: () => false, getSize: () => ({ width: 320, height: 240 }), toPNG: () => { throw new Error("Timed-out pixels must not serialize"); } });
      expect(await closing).toEqual({ authority: "retired", nativeCapture: "settled", pendingNativeCaptures: 0, nativeCancellation: "unsupported" });
      expect(f.session.artifacts.list()).toEqual([]);
    } finally { await f.cleanup(); }
  }, 10000);
});
