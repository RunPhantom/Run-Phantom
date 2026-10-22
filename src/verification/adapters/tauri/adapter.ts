import { randomUUID } from "node:crypto";
import { TauriArtifactStore, type TauriCapture } from "./artifacts";
import { authority, parseReply, record, registeredActions, tauriError, TAURI_LIMITS, TauriError, type TauriAuthority, type TauriObservation, type TauriOperation, type TauriReply, type TauriRequest, type TauriTransport } from "./contract";

/** Construct only from an owned fixture registration, never imported evidence. */
export class CooperatingTauriAdapter {
  readonly #authority: Readonly<TauriAuthority>;
  readonly #actions: ReadonlySet<string>;
  #generation = 0;
  #active?: AbortController;
  #closed = false;
  #close?: Promise<void>;
  constructor(registration: TauriAuthority & { actions: readonly string[] }, readonly transport: TauriTransport, readonly artifacts: TauriArtifactStore) {
    const object = record(registration);
    if (Object.keys(object).sort().join() !== "actions,application,nonce,window") throw new TauriError("denied");
    this.#authority = authority({ application: object.application, window: object.window, nonce: object.nonce });
    this.#actions = new Set(registeredActions(object.actions));
  }
  get generation(): number { return this.#generation; }
  async #exchange(operation: TauriOperation): Promise<TauriReply> {
    if (this.#closed) throw new TauriError("closed");
    if (this.#active) throw new TauriError("busy");
    const controller = new AbortController(); this.#active = controller;
    const request: TauriRequest = { ...this.#authority, ...operation, version: 1, id: randomUUID(), generation: this.#generation };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const stop = new Promise<never>((_, reject) => {
        abortListener = () => reject(new TauriError("cancelled")); controller.signal.addEventListener("abort", abortListener, { once: true });
        timer = setTimeout(() => { reject(new TauriError("deadline")); controller.abort(); }, TAURI_LIMITS.operationMs);
      });
      const reply = parseReply(await Promise.race([this.transport.exchange(request, controller.signal), stop]), request);
      if (controller.signal.aborted || this.#closed || request.generation !== this.#generation) throw new TauriError("cancelled");
      if (reply.status !== "ok") throw new TauriError(reply.status);
      return reply;
    } catch (error) { throw tauriError(error); }
    finally { clearTimeout(timer); if (abortListener) controller.signal.removeEventListener("abort", abortListener); if (this.#active === controller) this.#active = undefined; }
  }
  async observe(): Promise<TauriObservation> {
    const reply = await this.#exchange({ kind: "observe" });
    if (!("observation" in reply)) throw new TauriError("invalid-reply");
    return { source: "cooperating-tauri", value: reply.observation.value, sequence: reply.observation.sequence };
  }
  async action(action: string): Promise<TauriObservation> {
    if (!this.#actions.has(action)) throw new TauriError("denied");
    const reply = await this.#exchange({ kind: "action", action });
    if (!("observation" in reply)) throw new TauriError("invalid-reply");
    return { source: "cooperating-tauri", value: reply.observation.value, sequence: reply.observation.sequence };
  }
  async compare(expected: number): Promise<{ status: "pass" | "fail"; source: "cooperating-tauri"; observation: TauriObservation }> {
    if (!Number.isSafeInteger(expected)) throw new TauriError("denied");
    const observation = await this.observe(); return { status: observation.value === expected ? "pass" : "fail", source: "cooperating-tauri", observation };
  }
  async capture(input: { mode: "private-raw"; consent: true }): Promise<TauriCapture> {
    const options = record(input);
    if (Object.keys(options).sort().join() !== "consent,mode" || options.mode !== "private-raw" || options.consent !== true) throw new TauriError("denied");
    const generation = this.#generation, reply = await this.#exchange({ kind: "capture", mode: "private-raw", consent: true });
    if (!("png" in reply) || generation !== this.#generation || this.#closed) throw new TauriError("cancelled");
    return this.artifacts.admit(reply.png, generation);
  }
  async cancel(): Promise<void> {
    if (this.#closed) throw new TauriError("closed");
    this.#generation++; const active = this.#active; this.#active = undefined; active?.abort();
    await this.#exchange({ kind: "cancel" });
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closed = true; this.#generation++; this.#active?.abort();
    this.#close = (async () => {
      let terminal = false; try { terminal = await this.transport.close(); } catch { /* Unknown ownership retains private files. */ }
      if (!terminal || !this.artifacts.close()) throw new TauriError("cleanup-unconfirmed");
    })(); return this.#close;
  }
}
