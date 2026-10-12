import { REVIEW_LIMITS as L, type ReviewDraft, type ReviewItem, type ReviewMutation } from "../../../../src/review-queues/protocol";
import { ReviewRequestError, type ReviewQueuesClient } from "./client";
export interface PendingDraft {
  server: ReviewItem; draft: ReviewDraft; generation: number; savedGeneration: number;
  busy: boolean; approving: boolean; error: string | null; conflict: boolean;
  timer?: ReturnType<typeof setTimeout>; flight?: Promise<void>;
  retry?: { kind: "save" | "approve" | "reopen"; mutation: ReviewMutation; generation: number };
}
const clone = (draft: ReviewDraft): ReviewDraft => ({ ...draft, tags: [...draft.tags], target: { ...draft.target } });
export class ReviewDrafts {
  readonly entries = new Map<string, PendingDraft>();
  private listeners = new Set<() => void>();
  constructor(private readonly api: Pick<ReviewQueuesClient, "mutate" | "window">, private readonly debounceMs = 600, private readonly onStored: (item: ReviewItem) => void = () => {}) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); }
  get dirtyCount() { return [...this.entries.values()].filter(entry => entry.generation !== entry.savedGeneration || entry.busy || entry.retry).length; }
  hydrate(item: ReviewItem): PendingDraft | undefined {
    const prior = this.entries.get(item.id);
    if (prior && (prior.generation !== prior.savedGeneration || prior.busy || prior.retry)) return prior;
    // Only dirty or in-flight drafts are retained outside the source window.
    if (prior) this.entries.delete(item.id);
    return undefined;
  }
  edit(item: ReviewItem, draft: ReviewDraft): void {
    let entry = this.entries.get(item.id);
    if (!entry) {
      if (this.entries.size >= L.MAX_DIRTY_DRAFTS) throw new Error("16 drafts are retained. Save, retry or discard a draft before editing another item.");
      entry = { server: item, draft: clone(item.draft), generation: 0, savedGeneration: 0, busy: false, approving: false, error: null, conflict: false };
      this.entries.set(item.id, entry);
    }
    if (entry.approving || entry.server.state !== "draft") throw new Error("Reopen the local review before editing this item.");
    if (entry.error && !entry.conflict && !entry.retry) entry.error = null;
    entry.draft = clone(draft); entry.generation++; clearTimeout(entry.timer);
    if (!entry.error) entry.timer = setTimeout(() => { void this.save(item.id); }, this.debounceMs);
    this.changed();
  }
  private async send(id: string, kind: "save" | "approve" | "reopen", reuse = false): Promise<void> {
    const entry = this.entries.get(id); if (!entry) return;
    while (entry.flight) await entry.flight;
    if (this.entries.get(id) !== entry || (kind === "save" && !reuse && entry.generation === entry.savedGeneration)) return;
    if (entry.conflict || (entry.error && !reuse)) return;
    clearTimeout(entry.timer);
    const captured = reuse && entry.retry ? entry.retry : { kind, generation: entry.generation, mutation: { expectedRevision: entry.server.revision, mutationId: crypto.randomUUID(), ...(kind === "reopen" ? {} : { draft: clone(entry.draft) }) } };
    entry.busy = true; entry.error = null; entry.retry = captured;
    entry.flight = (async () => {
      try {
        const result = await this.api.mutate(entry.server.queueId, id, captured.kind, captured.mutation);
        entry.server = result; this.onStored(result); entry.savedGeneration = captured.generation; entry.retry = undefined; entry.conflict = false;
        if (entry.generation === captured.generation) entry.draft = clone(result.draft);
      } catch (error) {
        entry.conflict = error instanceof ReviewRequestError && error.status === 409;
        if (error instanceof ReviewRequestError && !entry.conflict && error.status >= 400 && error.status < 500) entry.retry = undefined;
        entry.error = error instanceof Error ? error.message : "Save failed; your draft is retained";
        if (!(error instanceof ReviewRequestError)) {
          // A lost response does not establish that the synchronous server write was canceled.
          try {
            const current = (await this.api.window(entry.server.queueId, id)).find(item => item.id === id);
            if (current?.lastMutationId === captured.mutation.mutationId && current.revision === captured.mutation.expectedRevision + 1) {
              entry.server = current; this.onStored(current); entry.savedGeneration = captured.generation;
              entry.retry = undefined; entry.error = null;
              if (entry.generation === captured.generation) entry.draft = clone(current.draft);
            } else if (current && current.revision !== captured.mutation.expectedRevision) {
              entry.conflict = true; entry.error = "The item changed before its acknowledgment. Your draft is retained; reapply explicitly to the latest revision.";
            }
          } catch { /* Retain the exact retry request when the current row is also unavailable. */ }
        }
      } finally { entry.busy = false; entry.flight = undefined; this.changed(); }
    })();
    this.changed(); await entry.flight;
    if (!entry.error && !entry.approving && entry.generation !== entry.savedGeneration) await this.send(id, "save");
    else if (!entry.error && !entry.approving && entry.generation === entry.savedGeneration) { this.entries.delete(id); this.changed(); }
  }
  async save(id: string): Promise<void> { await this.send(id, "save"); }
  async retry(id: string): Promise<void> { await this.send(id, "save", true); }
  async approve(item: ReviewItem): Promise<ReviewItem> {
    let entry = this.entries.get(item.id);
    if (!entry) {
      if (this.entries.size >= L.MAX_DIRTY_DRAFTS) throw new Error("Save or discard a retained draft before approving another item.");
      entry = { server: item, draft: clone(item.draft), generation: 0, savedGeneration: 0, busy: false, approving: false, error: null, conflict: false }; this.entries.set(item.id, entry);
    }
    clearTimeout(entry.timer); entry.approving = true; this.changed();
    try { if (entry.flight) await entry.flight; await this.send(item.id, "approve"); if (entry.error) throw new Error(entry.error); return entry.server; }
    finally { entry.approving = false; if (!entry.error) this.entries.delete(item.id); this.changed(); }
  }
  async reopen(item: ReviewItem): Promise<ReviewItem> {
    if (this.entries.size >= L.MAX_DIRTY_DRAFTS && !this.entries.has(item.id)) throw new Error("Save or discard a retained draft before reopening.");
    this.entries.set(item.id, { server: item, draft: clone(item.draft), generation: 0, savedGeneration: 0, busy: false, approving: true, error: null, conflict: false });
    const entry = this.entries.get(item.id)!;
    await this.send(item.id, "reopen"); entry.approving = false; this.changed(); if (entry.error) throw new Error(entry.error);
    this.entries.delete(item.id); this.changed(); return entry.server;
  }
  reapply(id: string, latest: ReviewItem): void {
    const entry = this.entries.get(id); if (!entry || entry.busy) return;
    if (latest.state !== "draft") throw new Error("The latest item is approved or promoted. Reopen it before reapplying this draft.");
    entry.server = latest; entry.error = null; entry.conflict = false; entry.retry = undefined; entry.generation++; this.changed();
  }
  discard(id: string): void { const entry = this.entries.get(id); if (entry?.busy) throw new Error("Wait for the save acknowledgment before discarding."); clearTimeout(entry?.timer); this.entries.delete(id); this.changed(); }
  dispose(): void { for (const entry of this.entries.values()) clearTimeout(entry.timer); }
}
export function allowsReviewShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || (!event.metaKey && !event.ctrlKey)) return false;
  if (document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')) return false;
  const element = event.target instanceof Element ? event.target : null;
  return !element?.closest('input,textarea,select,button,[contenteditable="true"],[role="textbox"],[role="dialog"],[role="alertdialog"]');
}
