import { ELECTRON_CHANNEL, ELECTRON_LIMITS, ElectronVerificationError, parseElectronRequest, type ElectronReply } from "./contract";

export interface ElectronPreloadHost {
  ipcRenderer: { on(channel: string, listener: (event: unknown, value: unknown) => void): void;
    removeListener(channel: string, listener: (event: unknown, value: unknown) => void): void; send(channel: string, value: unknown): void };
  contextBridge: { exposeInMainWorld(name: string, api: object): void };
}
/** Call from a sandboxed, context-isolated preload in the explicitly cooperating application. */
export function installElectronPreload(host: ElectronPreloadHost, token: string, document: Document): () => void {
  let closed = false;
  const listener = (_event: unknown, value: unknown) => {
    if (closed) return;
    let request;
    try { request = parseElectronRequest(value); } catch { return; }
    if (request.token !== token) return;
    let reply: ElectronReply;
    try {
      const matches = document.querySelectorAll(request.operation.selector);
      if (matches.length > 1000) throw new ElectronVerificationError("TARGET_AMBIGUOUS");
      const privateSelector = "input,textarea,[contenteditable],[data-private],[data-runphantom-private]";
      const privateTarget = [...matches].some(element => element.closest(privateSelector) || element.querySelector(privateSelector));
      if (privateTarget) throw new ElectronVerificationError("PRIVATE_TARGET");
      if (request.operation.type === "read") {
        const text = [...matches].map(element => element.textContent ?? "").join("\n");
        if (text.length > ELECTRON_LIMITS.text) throw new ElectronVerificationError("UNAVAILABLE");
        reply = { ...request, ok: true, result: { count: matches.length, text } };
      } else {
        if (matches.length === 0) throw new ElectronVerificationError("TARGET_MISSING");
        if (matches.length !== 1) throw new ElectronVerificationError("TARGET_AMBIGUOUS");
        const element = matches[0], view = document.defaultView;
        if (!view || !(element instanceof view.HTMLElement) || element.getAttribute("aria-disabled") === "true"
          || element.hasAttribute("disabled") || !element.getClientRects().length) throw new ElectronVerificationError("UNSUPPORTED_TARGET");
        element.click();
        reply = { ...request, ok: true, result: { dispatched: true } };
      }
    } catch (error) {
      reply = { token: request.token, id: request.id, generation: request.generation, ok: false,
        code: error instanceof ElectronVerificationError ? error.code : "UNAVAILABLE" };
    }
    const { token: authority, id, generation, ok } = reply;
    host.ipcRenderer.send(ELECTRON_CHANNEL + ":reply", ok ? { token: authority, id, generation, ok, result: reply.result }
      : { token: authority, id, generation, ok, code: reply.code });
  };
  host.contextBridge.exposeInMainWorld("runPhantomVerification", Object.freeze({ capabilities: () => Object.freeze({
    backend: "cooperating-electron", inputMode: "cooperating-dom", capture: "host-consent-only", arbitraryEvaluation: false,
  }) }));
  host.ipcRenderer.on(ELECTRON_CHANNEL + ":request", listener);
  return () => { if (!closed) { closed = true; host.ipcRenderer.removeListener(ELECTRON_CHANNEL + ":request", listener); } };
}
