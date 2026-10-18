import type { acquireComparisonOwner } from "./comparison-owner";
import { ComparisonOwnerRefusal } from "./comparison-owner";
import { COMPARISON_LIMITS, ComparisonError } from "./comparison-protocol";
import type { ComparisonFence, ComparisonReceipt } from "./comparison-store";
import { ComparisonStore } from "./comparison-store";
import { ComparisonProviderError, type createComparisonProviderClient } from "./providers";

type Owner = Awaited<ReturnType<typeof acquireComparisonOwner>>;
type ProviderClient = ReturnType<typeof createComparisonProviderClient>;
interface Entry { store: ComparisonStore; id: string; position: number; fence: ComparisonFence; cancel: AbortController }
/** Every operation and scope shares the real kernel owner's two fetch slots. */
export class ComparisonCoordinator {
  readonly #owner: Owner; readonly #client: ProviderClient;
  #pending: Entry[] = []; readonly #running = new Map<Entry, Promise<void>>(); readonly #scheduled: { store: ComparisonStore; id: string }[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined; #closed = false;
  readonly #idleWaiters = new Set<() => void>();
  constructor(owner: Owner, client: ProviderClient) { owner.capture(); this.#owner = owner; this.#client = client; }
  submit(store: ComparisonStore, value: unknown, fence: ComparisonFence): ComparisonReceipt { if (this.#closed) throw new ComparisonError("unavailable"); const receipt = store.submit(value, fence); this.enqueue(store, receipt, fence); return receipt; }
  enqueue(store: ComparisonStore, receipt: ComparisonReceipt, fence: ComparisonFence): void {
    this.#owner.assertCurrent(fence.owner); if (this.#closed) throw new ComparisonError("unavailable");
    if (receipt.tombstone || this.#scheduled.some(entry => entry.id === receipt.id && entry.store.sameScope(store))) return;
    const queued = receipt.attempts.filter(attempt => attempt.status === "queued"); if (!queued.length) return;
    if (this.#pending.length + queued.length > COMPARISON_LIMITS.queued * COMPARISON_LIMITS.targets) throw new ComparisonError("capacity");
    if (this.#scheduled.length >= COMPARISON_LIMITS.operationsGlobal) throw new ComparisonError("capacity");
    this.#scheduled.push({ store, id: receipt.id });
    for (const attempt of queued) this.#pending.push({ store, id: receipt.id, position: attempt.position, fence, cancel: new AbortController() });
    this.#pump();
  }
  #pump(): void {
    if (this.#closed) return;
    while (this.#running.size < COMPARISON_LIMITS.active && this.#pending.length) {
      const entry = this.#pending.shift()!; let busy = false;
      const work = this.#owner.dispatch(entry.fence.owner, async ownerSignal => {
        const signal = AbortSignal.any([ownerSignal, entry.cancel.signal]);
        try {
          const attempt = entry.store.start(entry.id, entry.position, entry.fence); if (!attempt) return;
          const result = await this.#client.execute({ target: attempt.request.targets[entry.position], compiled: attempt.request.compiled, options: attempt.request.options, signal, remainingMs: attempt.remainingMs });
          this.#owner.assertCurrent(entry.fence.owner);
          entry.store.finish(entry.id, entry.position, entry.fence, { status: "completed", result });
        } catch (error) {
          if (this.#closed) return; // Recovery after the next exclusive acquisition retains uncertain started charges.
          try {
            const code = error instanceof ComparisonProviderError ? error.code : error instanceof Error && "code" in error ? error.code : undefined;
            if (code === "authority_changed" || code === "deleted" || code === "not_found" || code === "inactive" || !this.#canPublish(entry)) { entry.store.terminatePending(entry.id); return; }
            entry.store.finish(entry.id, entry.position, entry.fence, { status: code === "timeout" ? "timeout" : code === "cancelled" ? "cancelled" : "failed", reason: code === "timeout" || code === "cancelled" ? code : code === "response_limit" || code === "limit_refused" ? "response_limit" : code === "protected_content" || code === "credentials" ? "protected_content" : "provider_error" });
          } catch { if (!this.#closed) { try { entry.store.terminatePending(entry.id); } catch { /* Invalid owner authority cannot publish or repair persisted content. */ } } }
        }
      }).catch(error => {
        if (error instanceof ComparisonOwnerRefusal && error.reason === "busy" && !this.#closed) { busy = true; this.#pending.unshift(entry); }
        else if (!this.#closed) { try { entry.store.terminatePending(entry.id); } catch { /* Startup recovery owns abandoned receipts after lease loss. */ } }
      }).finally(() => { this.#running.delete(entry); if (!this.#closed) this.#schedule(busy ? 25 : 0); this.#resolveIdle(); });
      this.#running.set(entry, work);
    }
    if (this.#running.size || this.#pending.length) this.#schedule(25); else this.#resolveIdle();
  }
  #schedule(delay: number): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; this.retireInvalidated(); this.#pump(); }, delay);
  }
  #canPublish(entry: Entry): boolean { try { entry.store.capture("edit"); return !entry.store.get(entry.id, entry.fence).tombstone; } catch { return false; } }
  /** Native owner call after actual prompt/scope mutations; finite polling also fences external changes. */
  retireInvalidated(): void {
    if (this.#closed) return;
    const rejected: Entry[] = [];
    for (const entry of [...this.#pending, ...this.#running.keys()]) {
      if (rejected.some(candidate => candidate.id === entry.id && candidate.store.sameScope(entry.store)) || this.#canPublish(entry)) continue;
      rejected.push(entry); try { entry.store.terminatePending(entry.id); } catch { /* Lease loss requires the next owner's recovery. */ }
      for (const candidate of [...this.#pending, ...this.#running.keys()]) if (candidate.id === entry.id && candidate.store.sameScope(entry.store)) candidate.cancel.abort();
    }
    this.#pending = this.#pending.filter(entry => !rejected.some(candidate => candidate.id === entry.id && candidate.store.sameScope(entry.store))); this.#resolveIdle();
  }
  cancel(store: ComparisonStore, id: unknown, fence: ComparisonFence): ComparisonReceipt {
    const receipt = store.cancel(id, fence);
    for (const entry of [...this.#pending, ...this.#running.keys()]) if (entry.id === receipt.id && entry.store.sameScope(store)) entry.cancel.abort();
    this.#pending = this.#pending.filter(entry => !(entry.id === receipt.id && entry.store.sameScope(store))); this.#resolveIdle(); return receipt;
  }
  clear(store: ComparisonStore, value: unknown, fence: ComparisonFence) {
    const result = store.clear(value, fence);
    for (const entry of [...this.#pending, ...this.#running.keys()]) if (entry.store.sameScope(store)) entry.cancel.abort();
    this.#pending = this.#pending.filter(entry => !entry.store.sameScope(store)); this.#resolveIdle(); return result;
  }
  #resolveIdle(): void { if (!this.#pending.length && !this.#running.size) for (const resolve of this.#idleWaiters) resolve(); if (!this.#pending.length && !this.#running.size) this.#idleWaiters.clear(); }
  idle(): Promise<void> { return !this.#pending.length && !this.#running.size ? Promise.resolve() : new Promise(resolve => this.#idleWaiters.add(resolve)); }
  close(): Promise<void> {
    this.#closed = true; if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; this.#pending = [];
    for (const entry of this.#running.keys()) entry.cancel.abort(); this.#resolveIdle(); return this.#owner.close();
  }
}
