import { randomUUID } from "node:crypto";
import { TauriArtifactStore, type TauriCapture } from "./artifacts";
import { authority, parseReply, record, TAURI_LIMITS, TauriError, type TauriAuthority, type TauriObservation, type TauriOperation, type TauriReply, type TauriRequest, type TauriTransport } from "./contract";

/** Construct only from an owned fixture registration, never imported evidence. */
export class CooperatingTauriAdapter {
  readonly #authority: Readonly<TauriAuthority>;
  readonly #actions: ReadonlySet<string>;
  #generation = 0;
  #active?: AbortController;
  #closed = false;
  #close?: Promise<void>;
  constructor(registration: TauriAuthority & { actions: readonly string[] }, readonly transport: TauriTransport, readonly artifacts: TauriArtifactStore) {
    this.#authority = authority({ application: registration.application, window: registration.window, nonce: registration.nonce });
    if (!Array.isArray(registration.actions) || registration.actions.length > 16 || registration.actions.some(action => !/^[a-z][a-z0-9-]{0,63}$/.test(action))) throw new TauriError("denied");
    this.#actions = new Set(registration.actions);
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
    } catch (error) { if (error instanceof TauriError) throw error; throw new TauriError("unavailable"); }
    finally { clearTimeout(timer); if (abortListener) controller.signal.removeEventListener("abort", abortListener); if (this.#active === controller) this.#active = undefined; }
  }
  async observe(): Promise<TauriObservation> {
    const reply = await this.#exchange({ kind: "observe" });
    if (!("observation" in reply)) throw new TauriError("invalid-reply");
    return { ...reply.observation };
  }
  async action(action: string): Promise<TauriObservation> {
    if (!this.#actions.has(action)) throw new TauriError("denied");
    const reply = await this.#exchange({ kind: "action", action });
    if (!("observation" in reply)) throw new TauriError("invalid-reply");
    return { ...reply.observation };
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
