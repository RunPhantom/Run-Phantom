import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus } from "lucide-react";
import { Dialog as UiDialog, DialogContent } from "../ui/dialog";
import { Eyebrow, PageHeader } from "../ui/typography";
import { ago } from "../../utils/helpers";
import { Button } from "../ui/button";
import { Input, Select } from "../ui/input";
import { Field } from "./fields";
import { evaluationsApi, type Dataset } from "../../api/evaluations";
import { searchRuns } from "../../api/runs";
import { reviewQueuesApi as api, ReviewRequestError, type ReviewQueue, type ReviewCounts, type ReviewItem, type ReviewDraft, type ReviewSchema, type PromotionReceipt, type ReviewPage } from "./client";
import { ReviewDrafts, allowsReviewShortcut } from "./drafts";
import { ReviewTargetEditor, reviewTextarea } from "./ReviewTargetEditor";
import { QueueSchemaEditor, defaultQueueSchema } from "./QueueSchemaEditor";
import type { ReviewCursor, PromotionRequest } from "../../../../src/review-queues/protocol";
const panel = "rp-fade-rise min-w-0 rounded-lg border border-rp-line bg-rp-surface p-5 sm:p-6";
const heading = "font-display text-lg font-semibold leading-6 tracking-[-0.025em] text-rp-ink";
const evidenceLabel = "rp-eyebrow mt-5";
const evidenceWell = "mt-2 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rp-line-muted bg-rp-canvas-blue px-4 py-3 font-mono text-xs leading-5 text-rp-ink";
const alertBox = "rp-fade-rise rounded-md border border-rp-danger-border bg-rp-danger-soft px-4 py-3 text-[13px] leading-5 text-rp-danger";
const errorText = (error: unknown) => error instanceof Error ? error.message : "Local review request failed";
type Confirmation = { title: string; description: string; action: () => Promise<void> };
function ConfirmationDialog({ value, close }: { value: Confirmation | null; close: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <Dialog.Root open={!!value} onOpenChange={open => { if (!open && !busy) { close(); setError(""); } }}>
    <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(14_18_27/0.32)] data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
    <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-rp-line bg-rp-surface p-6 shadow-e4 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] motion-reduce:animate-none">
    <Dialog.Title className="font-display text-[17px] font-semibold leading-6 tracking-[-0.02em] text-rp-ink">{value?.title}</Dialog.Title>
    <Dialog.Description className="mt-3 text-sm leading-6 text-rp-ink-muted">{value?.description}</Dialog.Description>{error && <p role="alert" className="mt-3 text-sm text-rp-danger">{error}</p>}<div className="mt-6 flex flex-wrap justify-end gap-2">
    <Button variant="outline" className="min-h-10" disabled={busy} onClick={() => { close(); setError(""); }}>Cancel</Button>
    <Button variant="destructive" className="min-h-10" disabled={busy} onClick={async () => { if (!value) return; setBusy(true); try { await value.action(); close(); setError(""); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }}>{busy ? "Working…" : "Confirm"}</Button>
    </div>
    </Dialog.Content>
    </Dialog.Portal>
    </Dialog.Root>;
}

export function ReviewQueues({ initialQueueId = "", initialItemId = "", onRetainedChange }: { initialQueueId?: string; initialItemId?: string; onRetainedChange?: (value: { retained: number; inFlight: number }) => void }) {
  const [queues, setQueues] = useState<Array<ReviewQueue & { counts: ReviewCounts }>>([]), [selected, setSelected] = useState(initialQueueId), [name, setName] = useState("");
  const [schema, setSchema] = useState<ReviewSchema>(defaultQueueSchema), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dirty = useRef(0), [workspaceBusy, setWorkspaceBusy] = useState(false), [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [creating, setCreating] = useState(false), createReason = useId();
  const refresh = useCallback(async () => { const values = await api.queues(); setQueues(values); }, []);
  useEffect(() => { let active = true; api.queues().then(values => { if (active) setQueues(values); }).catch(failure => { if (active) setError(errorText(failure)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  const queue = queues.find(value => value.id === selected);
  const reportDirty = useCallback((count: number, inFlight: number) => { dirty.current = count; onRetainedChange?.({ retained: count, inFlight }); }, [onRetainedChange]);
  const selectQueue = (id: string) => { if (workspaceBusy || dirty.current) { setError("Your drafts are retained. Save, retry or discard them before switching queues."); return; } setError(""); setSelected(id); };
  const createBlocker = workspaceBusy || dirty.current ? "Save or discard your drafts first." : !name.trim() ? "Name the queue to create it." : null;
  const empty = !loading && !queues.length && !error;
  const openQueue = (id: string) => { selectQueue(id); };
  return <main className="mx-auto w-full max-w-[1440px] space-y-5 rp-page text-rp-ink">
    <PageHeader eyebrow="Review queues" title="Review queues" description={empty ? "Read what an agent answered, write down what it should have said, and add the approved answers to a dataset." : undefined} actions={<>
      <Button variant="outline" disabled={loading || busy || workspaceBusy} onClick={() => void refresh().catch(failure => setError(errorText(failure)))}>Refresh</Button>
      {!empty && <Button disabled={loading} onClick={() => setCreating(true)}><Plus aria-hidden="true" />New queue</Button>}
    </>} />
    {error && <p role="alert" className={alertBox}>{error}</p>}
    {loading ? <p className="text-sm" role="status">Loading queues…</p>
      : empty ? <ReviewQueuesEmptyState onCreate={() => setCreating(true)} />
        : <section className={panel} aria-labelledby="review-queue-list-title">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="review-queue-list-title" className={heading}>Queues</h2><span className="font-mono text-12 text-rp-ink-muted">{queues.length} {queues.length === 1 ? "queue" : "queues"} · {queues.reduce((sum, value) => sum + value.counts.draft, 0)} items to review</span></div>
          <QueueTable queues={queues} selected={selected} disabled={workspaceBusy} onOpen={openQueue} />
          {selected && !queue && <p className="mt-3 text-sm" role="alert">This queue is unavailable or was deleted. Refresh queues to continue.</p>}
        </section>}
    {queue && <QueueWorkspace key={queue.id} queue={queue} initialItemId={queue.id === initialQueueId ? initialItemId : ""} onDirty={reportDirty} onBusy={setWorkspaceBusy} onChanged={refresh} onConfirm={setConfirmation} />}
    {queue && <details className={`${panel} group`} aria-label="Review retention">
      <summary className="rp-disclosure cursor-pointer text-[13px] font-medium text-rp-ink">Storage and deletion</summary>
      <div className="mt-3 space-y-3">
        <p className="text-[13px] leading-5 text-rp-ink-muted">Queues, the captured runs in them and your drafts are stored on this machine until you delete them. Limits: 100 queues, 10,000 items in a queue, 50,000 items in total and 256 MiB of content; past a limit nothing new is added and nothing old is removed. Deleting a run removes its queue items. Datasets you already added items to keep them.</p>
        <Button variant="destructive-outline" className="min-h-10" disabled={workspaceBusy} onClick={() => setConfirmation({ title: "Delete this review queue?", description: "The queue, its drafts, the captured runs in it and its history of additions will be deleted. Datasets keep the cases already added to them.", action: async () => { if (workspaceBusy || dirty.current) throw new Error("Save or discard retained drafts before deleting this queue."); await api.deleteQueue(queue.id); setSelected(""); await refresh(); } })}>Delete queue</Button>
      </div>
    </details>}
    <ConfirmationDialog value={confirmation} close={() => setConfirmation(null)} />
    <UiDialog open={creating} onOpenChange={open => { if (!busy) setCreating(open); }}>
      <DialogContent title="New review queue" description="A queue collects agent answers for you to check one by one. Each field below becomes part of a test case when you add approved items to a dataset." className="max-w-xl">
        <form className="mt-5 space-y-4" onSubmit={async event => { event.preventDefault(); if (createBlocker) { setError(createBlocker); return; } setBusy(true); setError(""); try { const made = await api.create(name, schema); await refresh(); setSelected(made.id); setName(""); setCreating(false); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }}>
          <Field label="New queue name">
            <Input className="min-h-10" maxLength={128} value={name} onChange={event => setName(event.target.value)} placeholder="Refund answers to check" />
          </Field>
          <QueueSchemaEditor schema={schema} onChange={setSchema} />
          {error && <p role="alert" className="text-[13px] text-rp-danger">{error}</p>}
          <div className="space-y-2"><Button className="min-h-10" disabled={busy || !!createBlocker} aria-describedby={createBlocker ? createReason : undefined}>Create queue</Button>{createBlocker && <p id={createReason} className="text-12 text-rp-ink-muted">{createBlocker}</p>}</div>
        </form>
      </DialogContent>
    </UiDialog>
  </main>;
}

function QueueTable({ queues, selected, disabled, onOpen }: { queues: Array<ReviewQueue & { counts: ReviewCounts }>; selected: string; disabled: boolean; onOpen: (id: string) => void }) {
  return <div className="mt-3 max-h-[320px] overflow-auto rounded-md border border-rp-line" role="region" aria-label="Queue list" tabIndex={0}>
    <table className="w-full min-w-[560px] border-collapse text-[13px]">
      <caption className="sr-only">Review queues with how many items wait for review, are approved and were added to a dataset.</caption>
      <thead className="sticky top-0 bg-rp-canvas-grey"><tr className="text-left">{["Queue", "Items", "To review", "Approved", "Added to a dataset", "Created"].map((label, index) => <th key={label} scope="col" className={`border-b border-rp-line px-3.5 py-2 font-mono text-11 font-medium uppercase tracking-[0.08em] text-rp-ink-muted ${index > 0 && index < 5 ? "text-right" : ""}`}>{label}</th>)}</tr></thead>
      <tbody>{queues.map(value => <tr key={value.id} data-selected={selected === value.id} className="border-t border-rp-line-muted first:border-t-0 hover:bg-rp-row-hover data-[selected=true]:bg-rp-wash data-[selected=true]:shadow-[inset_2px_0_0_var(--rp-blue)]">
        <th scope="row" className="px-3.5 py-2 text-left font-medium"><button type="button" disabled={disabled} aria-pressed={selected === value.id} aria-label={`Open queue ${value.name}`} className="max-w-[40ch] truncate rounded-control text-left font-semibold text-rp-blue underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)] disabled:text-rp-ink-muted" onClick={() => onOpen(value.id)}>{value.name}</button></th>
        <td className="px-3.5 py-2 text-right font-mono text-12 tabular-nums">{value.counts.total}</td>
        <td className={`px-3.5 py-2 text-right font-mono text-12 tabular-nums ${value.counts.draft ? "font-semibold text-rp-ink" : "text-rp-ink-muted"}`}>{value.counts.draft}</td>
        <td className="px-3.5 py-2 text-right font-mono text-12 tabular-nums">{value.counts.approved}</td>
        <td className="px-3.5 py-2 text-right font-mono text-12 tabular-nums">{value.counts.promoted}</td>
        <td className="whitespace-nowrap px-3.5 py-2 font-mono text-12 text-rp-ink-muted">{ago(value.createdAt)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

const SAMPLE_QUEUES: Array<ReviewQueue & { counts: ReviewCounts }> = [
  { id: "sample-1", name: "Refund answers to check", schema: defaultQueueSchema, schemaHash: "", createdAt: Date.now() - 3_600_000 * 26, counts: { total: 24, draft: 9, approved: 11, promoted: 4 } },
  { id: "sample-2", name: "Order status replies", schema: defaultQueueSchema, schemaHash: "", createdAt: Date.now() - 3_600_000 * 70, counts: { total: 12, draft: 0, approved: 4, promoted: 8 } },
  { id: "sample-3", name: "Tool failures the agent explained", schema: defaultQueueSchema, schemaHash: "", createdAt: Date.now() - 3_600_000 * 5, counts: { total: 6, draft: 6, approved: 0, promoted: 0 } },
];

function ReviewQueuesEmptyState({ onCreate }: { onCreate: () => void }) {
  return <div className="relative min-h-[420px]" data-review-queues-empty>
    <div aria-hidden="true" inert className="pointer-events-none select-none opacity-40 saturate-[0.4]">
      <p className="rp-type-eyebrow mb-2 text-rp-ink-subtle">Sample · not your data</p>
      <section className={panel}><h2 className={heading}>Queues</h2><QueueTable queues={SAMPLE_QUEUES} selected="" disabled onOpen={() => {}} /></section>
    </div>
    <div className="absolute inset-x-0 top-10 flex justify-center px-0 sm:top-16 sm:px-6">
      <section aria-labelledby="review-queues-get-started" className="w-full max-w-[600px] rounded-lg border border-rp-line bg-rp-surface p-5 shadow-e4 sm:p-7">
        <Eyebrow marker tone="accent">Nothing to review yet</Eyebrow>
        <h2 id="review-queues-get-started" className="rp-type-headline mt-3 text-rp-ink">Check agent answers by hand.</h2>
        <p className="rp-type-prose mt-2 text-rp-ink-muted">Add captured runs to a queue, write the answer you expected for each, and add the ones you approve to a dataset as test cases.</p>
        <div className="mt-5"><Button onClick={onCreate}><Plus aria-hidden="true" />Create a review queue</Button></div>
      </section>
    </div>
  </div>;
}

function QueueWorkspace({ queue, initialItemId, onDirty, onBusy, onChanged, onConfirm }: { queue: ReviewQueue; initialItemId: string; onDirty: (count: number, inFlight: number) => void; onBusy: (value: boolean) => void; onChanged: () => Promise<void>; onConfirm: (value: Confirmation) => void }) {
  const [pages, setPages] = useState<Array<{ cursor: ReviewCursor; data: ReviewPage }>>([]), [cursor, setCursor] = useState<ReviewCursor>({ limit: 50 });
  const [history, setHistory] = useState<ReviewCursor[]>([]), [windowItems, setWindow] = useState<ReviewItem[]>([]), [centerId, setCenter] = useState(initialItemId);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [refreshTick, setRefreshTick] = useState(0);
  const [runs, setRuns] = useState<Array<{ id: string; name: string }>>([]), [runQuery, setRunQuery] = useState(""), [runId, setRunId] = useState(""), [spans, setSpans] = useState<Array<{ id: string; name: string }>>([]), [spanId, setSpanId] = useState("");
  const [datasets, setDatasets] = useState<Dataset[]>([]), [datasetId, setDataset] = useState(""), [selection, setSelection] = useState<Map<string, number>>(new Map()), [receipt, setReceipt] = useState<PromotionReceipt | null>(null);
  const pendingPromotion = useRef<PromotionRequest | null>(null), windowRequest = useRef(0), [, forceRender] = useState(0);
  const drafts = useRef<ReviewDrafts | null>(null);
  if (!drafts.current) drafts.current = new ReviewDrafts(api, 600, stored => { setWindow(prior => prior.map(item => item.id === stored.id ? stored : item)); setRefreshTick(tick => tick + 1); });
  const state = drafts.current;
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => { const report = () => { forceRender(tick => tick + 1); onDirty(state.dirtyCount, Math.max(busy ? 1 : 0, [...state.entries.values()].filter(value => value.busy || value.approving).length)); }; report(); return state.subscribe(report); }, [state, onDirty, busy]);
  useEffect(() => { const unload = (event: BeforeUnloadEvent) => { if (state.dirtyCount) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", unload); return () => { window.removeEventListener("beforeunload", unload); state.dispose(); onDirty(0, 0); }; }, [state, onDirty]);
  useEffect(() => { let active = true; setLoading(true); api.page(queue.id, cursor).then(data => { if (!active) return; setPages(prior => [...prior.filter(page => JSON.stringify(page.cursor) !== JSON.stringify(cursor)), { cursor, data }].slice(-2)); }).catch(failure => { if (active) setError(errorText(failure)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [queue.id, cursor, refreshTick]);
  useEffect(() => { let active = true; Promise.all([searchRuns({ limit: 50 }), evaluationsApi.datasets()]).then(([result, available]) => { if (!active) return; setRuns(result.runs.slice(0,50).map(run => ({ id: run.id, name: run.name ?? run.id }))); setDatasets(available.slice(0,50)); }).catch(failure => { if (active) setError(errorText(failure)); }); return () => { active = false; }; }, []);
  useEffect(() => { let active = true; setSpans([]); setSpanId(""); if (runId) evaluationsApi.responseSpans(runId).then(result => { if (active) setSpans(result.spans); }).catch(failure => { if (active) setError(errorText(failure)); }); return () => { active = false; }; }, [runId]);
  const loadWindow = useCallback(async (id: string) => {
    const token = ++windowRequest.current; setCenter(id);
    try {
      const values = await api.window(queue.id, id); if (token !== windowRequest.current) return;
      values.forEach(item => state.hydrate(item)); setWindow(values); setCenter(id); return values.find(item => item.id === id);
    } catch (failure) {
      if (token === windowRequest.current && failure instanceof ReviewRequestError && failure.status === 404) { setWindow([]); setCenter(""); }
      throw failure;
    }
  }, [queue.id, state]);
  useEffect(() => { if (initialItemId) void loadWindow(initialItemId).catch(failure => setError(errorText(failure))); }, [initialItemId, loadWindow]);
  const page = pages.find(value => JSON.stringify(value.cursor) === JSON.stringify(cursor))?.data;
  const item = windowItems.find(value => value.id === centerId), pending = item ? state.entries.get(item.id) : undefined, draft = pending?.draft ?? item?.draft;
  const perform = useCallback(async (action: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await action(); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }, []);
  const approve = useCallback(async () => { if (!item) return; await perform(async () => { const result = await state.approve(item); setWindow(prior => prior.map(value => value.id === result.id ? result : value)); setSelection(prior => new Map(prior).set(result.id, result.revision)); setRefreshTick(tick => tick + 1); await onChanged(); setNotice("Approved. Select approved items below to add them to a dataset."); }); }, [item, state, perform, onChanged]);
  const step = useCallback(async (direction: -1 | 1) => { const index = windowItems.findIndex(value => value.id === centerId), next = windowItems[index + direction]; if (next) await loadWindow(next.id); }, [windowItems, centerId, loadWindow]);
  useEffect(() => { const shortcut = (event: KeyboardEvent) => { if (!allowsReviewShortcut(event) || busy) return; if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); void step(event.key === "ArrowLeft" ? -1 : 1).catch(failure => setError(errorText(failure))); } else if (event.key === "Enter" && item?.state === "draft" && !pending?.conflict) { event.preventDefault(); void approve(); } }; window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut); }, [busy, item, pending?.conflict, step, approve]);
  const edit = (next: ReviewDraft) => { if (!item) return; try { state.edit(item, next); setError(""); } catch (failure) { setError(errorText(failure)); } };
  const updateSelection = (id: string, revision: number, checked: boolean) => { if (pendingPromotion.current) { setError("Retry the pending promotion before changing its selection."); return; } if (checked && !selection.has(id) && selection.size >= 50) { setError("Select up to 50 approved items."); return; } setSelection(prior => { const next = new Map(prior); if (checked) next.set(id, revision); else next.delete(id); return next; }); };
  const choose = async (id: string) => { if (busy) return; setError(""); try { await loadWindow(id); } catch (failure) { setError(errorText(failure)); } };
  const disabled = busy || !!pending?.approving || item?.state !== "draft";
  return <div className="space-y-5">
    <section className={panel} aria-label="Add captured source">
    <h2 className="mb-3 text-14 font-semibold text-rp-ink">Add a run to {queue.name}</h2>
    <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <Field label="Find a source run">
    <div className="flex gap-2">
    <Input className="min-h-10" value={runQuery} maxLength={128} onChange={event => setRunQuery(event.target.value)} placeholder="Search captured runs" />
    <Button className="min-h-10" variant="outline" disabled={busy} onClick={() => void perform(async () => { const result = await searchRuns({ q: runQuery, limit: 50 }); setRuns(result.runs.slice(0,50).map(run => ({ id: run.id, name: run.name ?? run.id }))); })}>Search</Button>
    </div>
    </Field>
    <Field label="Source run">
    <Select className="min-h-10" value={runId} onChange={event => setRunId(event.target.value)}>
    <option value="">Choose a captured run</option>{runs.map(run => <option key={run.id} value={run.id}>{run.name} · {run.id.slice(0, 8)}</option>)}</Select>
    </Field>
    <Field label="Response span">
    <Select className="min-h-10" value={spanId} onChange={event => setSpanId(event.target.value)}>
    <option value="">Use the run response</option>{spans.map(span => <option key={span.id} value={span.id}>{span.name} · {span.id}</option>)}</Select>
    </Field>
    <Button className="min-h-10" disabled={busy || !runId} onClick={() => void perform(async () => { const inserted = await api.insert(queue.id, runId, spanId || undefined); await loadWindow(inserted.id); setRefreshTick(tick => tick + 1); await onChanged(); setNotice("Added to the queue."); })}>Add to queue</Button>
    </div>
    {!runId && <p className="mt-2 text-12 text-rp-ink-muted">Choose a source run to add it.</p>}
    </section>
    {error && <p role="alert" className={alertBox}>{error}</p>}
    <p role="status" aria-live="polite" className="text-sm text-rp-ink-muted">{state.dirtyCount ? `${state.dirtyCount} unsaved ${state.dirtyCount === 1 ? "draft" : "drafts"} on this page${pending?.busy ? " · saving…" : ""}` : notice || "All changes saved"}</p>
    {!!state.entries.size && <section aria-label="Retained drafts" className={`${panel} space-y-3`}>
    <h2 className="text-sm font-semibold">Retained drafts</h2>{[...state.entries].map(([id, value]) => <div key={id} className="flex flex-wrap items-center gap-2 text-xs">
    <Button variant="ghost" className="min-h-10" disabled={busy} onClick={() => void choose(id)}>{value.draft.name}</Button>
    <span role={value.error ? "alert" : undefined}>{value.error || (value.busy ? "Saving…" : "Awaiting save")}</span>{value.error && !value.conflict && <Button className="min-h-10" variant="outline" disabled={busy || value.busy} onClick={() => void perform(async () => { await state.retry(id); if (state.entries.get(id)?.error) throw new Error(state.entries.get(id)!.error!); await loadWindow(id); })}>Retry save</Button>}{value.conflict && <Button className="min-h-10" variant="outline" disabled={busy || value.busy} onClick={() => void perform(async () => { const latest = await loadWindow(id); if (!latest) throw new Error("The source item was deleted. Discard its retained draft to continue."); state.reapply(id,latest); await state.save(id); if (state.entries.get(id)?.error) throw new Error(state.entries.get(id)!.error!); await loadWindow(id); })}>Reapply to latest revision</Button>}<Button className="min-h-10" variant="ghost" disabled={busy || value.busy} onClick={() => onConfirm({ title: "Discard this retained draft?", description: "Your unsaved changes will be removed. The last acknowledged server revision remains.", action: async () => { state.discard(id); await loadWindow(id); } })}>Discard draft</Button>
    </div>)}</section>}
    <div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <section aria-label="Queue items" className={panel}>
    <h2 className={heading}>{queue.name}</h2>{page && <p className="mt-2 text-xs leading-5 text-rp-ink-muted">{page.counts.total} items · {page.counts.draft} to review · {page.counts.approved} approved · {page.counts.promoted} added to a dataset</p>}{loading && <p role="status" className="mt-4 text-sm">Loading items…</p>}{page && !page.items.length && <p className="mt-4 text-sm text-rp-ink-muted">This page has no items. Add a captured source to start reviewing.</p>}<ol className="mt-4 space-y-2">{page?.items.map(row => <li key={row.id} className={`flex items-start gap-2 rounded-md border transition-[background-color,border-color] duration-250 ease-standard ${centerId === row.id ? "border-rp-wash-border bg-rp-wash shadow-[inset_2px_0_0_var(--rp-blue)] [&_.rq-row-name]:text-rp-blue" : "border-rp-line bg-rp-surface hover:border-rp-wash-border hover:bg-rp-row-hover"}`}>
        {row.state === "approved" && <input className="ml-3 mt-4 size-4 accent-rp-blue" type="checkbox" aria-label={`Select ${row.name} for promotion`} checked={selection.has(row.id)} onChange={event => updateSelection(row.id,row.revision,event.target.checked)} />}<button type="button" disabled={busy} aria-current={centerId === row.id ? "true" : undefined} className="min-h-10 min-w-0 flex-1 rounded-md p-3 text-left text-[13px]" onClick={() => void choose(row.id)}>
    <span className="rq-row-name block break-words font-semibold">{row.name}</span>
    <span className="mt-1 block text-xs text-rp-ink-muted">{row.state === "approved" ? "Approved" : row.state === "promoted" ? "Added to a dataset" : "Draft"} · revision {row.revision}{state.entries.has(row.id) ? " · draft retained" : ""}</span>
    </button>
    </li>)}</ol>
    <div className="mt-4 flex gap-2">
    <Button className="min-h-10" variant="outline" disabled={loading || !history.length} onClick={() => { setCursor(history[history.length - 1]!); setHistory(prior => prior.slice(0,-1)); }}>Previous page</Button>
    <Button className="min-h-10" variant="outline" disabled={loading || !page?.nextCursor} onClick={() => { setHistory(prior => [...prior,cursor].slice(-20)); setCursor({ limit: 50, ...page!.nextCursor! }); }}>Next page</Button>
    </div>
    </section>
      {!item || !draft ? <section className={`${panel} py-12`}>
    <h2 className={heading}>Choose an item to review</h2>
    <p className="mt-3 text-sm leading-6 text-rp-ink-muted">Pick an item from the list. It opens with the captured input and response next to the fields you fill in.</p>
    </section> : <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
    <p className="rp-eyebrow">Revision {pending?.server.revision ?? item.revision} · {item.state === "draft" ? "Draft" : item.state === "approved" ? "Approved" : "Added to a dataset"}</p>
    <div className="flex gap-2">
    <Button variant="outline" className="min-h-10" disabled={busy || windowItems[0]?.id === centerId} onClick={() => void perform(() => step(-1))}>Previous item</Button>
    <Button variant="outline" className="min-h-10" disabled={busy || windowItems[windowItems.length - 1]?.id === centerId} onClick={() => void perform(() => step(1))}>Next item</Button>
    </div>
    </div>
        <div className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
    <section className={panel} aria-label="Captured run">
    <h2 className={heading}>Captured run</h2>
    <p className="mt-2 break-all text-xs text-rp-ink-muted">{item.source.runName} · <span className="rp-meta">{item.source.runId}</span></p>
    <p className="mt-1 break-all text-xs text-rp-ink-muted">Response <span className="rp-meta">{item.source.resolvedOutputSpanId ?? "unavailable"}</span></p>{(!item.source.complete || item.source.redacted || item.source.truncated) && <p role="status" className="mt-3 rounded-md border border-rp-warning-border bg-rp-warning-soft px-3 py-2 text-xs leading-5 text-rp-warning">Source evidence is incomplete, redacted or truncated. Targets remain operator supplied.</p>}<h3 className={evidenceLabel}>Captured input</h3>
    <pre className={`${evidenceWell} max-h-48`}>{item.source.input ?? "Input unavailable"}</pre>
    <h3 className={evidenceLabel}>Captured response</h3>
    <pre className={`${evidenceWell} max-h-80`}>{item.source.output ?? "Response unavailable"}</pre>{item.source.warnings.length > 0 && <ul className="mt-3 list-inside list-disc text-xs text-rp-ink-muted">{item.source.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}</section>
        <section className={`${panel} space-y-4`} aria-label="Review draft">
    <h2 className={heading}>Your review</h2>
    <p className="text-xs leading-5 text-rp-ink-muted">Approving marks this item ready to add to a dataset. It records your judgment, not an automatic result.</p>
    <Field label="Case name">
    <Input disabled={disabled} maxLength={128} value={draft.name} onChange={event => edit({ ...draft,name:event.target.value })} />
    </Field>
    <ReviewTargetEditor schema={queue.schema} draft={draft} disabled={disabled} onChange={edit} />
    <Field label="Reference input (optional)">
    <textarea disabled={disabled} className={reviewTextarea} maxLength={4096} value={draft.input ?? ""} onChange={event => edit({ ...draft,input:event.target.value || null })} />
    </Field>
    <Field label="Tags" hint="Separate tags with commas, up to 8.">
    <Input disabled={disabled} key={`${item.id}:${pending ? "pending" : item.revision}`} defaultValue={draft.tags.join(", ")} maxLength={1024} onChange={event => edit({ ...draft,tags:event.target.value.split(",").map(value => value.trim()).filter(Boolean) })} />
    </Field>
    <Field label="Review note" hint="Retained in this queue; excluded from dataset export.">
    <textarea disabled={disabled} className={reviewTextarea} maxLength={2000} value={draft.note} onChange={event => edit({ ...draft,note:event.target.value })} />
    </Field>
    <div className="flex flex-wrap gap-2">{item.state === "draft" ? <>
    <Button variant="outline" className="min-h-10" disabled={busy || !!pending?.busy || !!pending?.error || !pending} onClick={() => void perform(async () => { await state.save(item.id); if (state.entries.get(item.id)?.error) throw new Error(state.entries.get(item.id)!.error!); })}>Save draft</Button>
    <Button className="min-h-10" disabled={busy || !!pending?.error} onClick={() => void approve()}>Approve local review</Button>
    </> : item.state === "approved" ? <Button variant="outline" className="min-h-10" disabled={busy} onClick={() => void perform(async () => { const result = await state.reopen(item); setWindow(prior => prior.map(value => value.id === result.id ? result : value)); setSelection(prior => { const next = new Map(prior); next.delete(item.id); return next; }); setRefreshTick(tick => tick + 1); await onChanged(); })}>Reopen review</Button> : <p className="text-xs">This item is terminal. Its dataset example is frozen.</p>}<Button variant="ghost" className="min-h-10" disabled={busy || !!pending} onClick={() => { const { id, revision } = item; onConfirm({ title: "Delete this review item?", description: "Its retained source and review draft will be deleted. Existing promoted dataset examples remain.", action: async () => { await api.deleteItem(queue.id,id,revision); setWindow([]); setCenter(""); setSelection(prior => { const next = new Map(prior); next.delete(id); return next; }); setRefreshTick(tick => tick + 1); await onChanged(); } }); }}>Delete item</Button>
    </div>
    </section>
    </div>
    </div>}
    </div>
    <section className={`${panel} space-y-4`} aria-label="Dataset promotion">
    <div>
    <h2 className={heading}>Add approved items to a dataset</h2>
    <p className="mt-2 text-sm text-rp-ink-muted">{selection.size} approved {selection.size === 1 ? "item" : "items"} selected. Adding them saves one new revision of the dataset.</p>
    </div>
    <div className="flex flex-wrap items-end gap-3">
    <div className="min-w-0 flex-[1_1_240px]">
    <Field label="Destination dataset">
    <Select className="min-h-10" value={datasetId} disabled={!!pendingPromotion.current || busy} onChange={event => setDataset(event.target.value)}>
    <option value="">Choose an existing dataset</option>{datasets.map(value => <option key={value.id} value={value.id}>{value.name} · revision {value.latestVersion}</option>)}</Select>
    </Field>
    </div>
    <Button className="min-h-10" variant="outline" disabled={busy || !!pendingPromotion.current} onClick={() => void perform(async () => { setDatasets((await evaluationsApi.datasets()).slice(0,50)); })}>Refresh datasets</Button>
    <Button className="min-h-10" disabled={busy || !datasetId || !selection.size || state.dirtyCount > 0} onClick={() => void perform(async () => { const destination = datasets.find(value => value.id === datasetId); if (!destination) throw new Error("Destination dataset is unavailable."); const request = pendingPromotion.current ?? { queueId:queue.id,datasetId,expectedDatasetVersion:destination.latestVersion,idempotencyKey:crypto.randomUUID(),items:[...selection].map(([itemId,expectedRevision]) => ({ itemId,expectedRevision })) }; pendingPromotion.current = request; let result: PromotionReceipt; try { result = await api.promote(request); } catch (failure) { if (failure instanceof ReviewRequestError && [400,404,409,413].includes(failure.status)) pendingPromotion.current = null; throw failure; } setReceipt(result); pendingPromotion.current = null; setSelection(new Map()); setRefreshTick(tick => tick + 1); if (centerId) await loadWindow(centerId); setDatasets((await evaluationsApi.datasets()).slice(0,50)); await onChanged(); setNotice(`Added ${result.caseIds.length} examples to dataset revision ${result.datasetVersion}.`); })}>{pendingPromotion.current ? "Retry original promotion" : "Promote approved selection"}</Button>
    </div>{!datasets.length && <p className="text-sm text-rp-ink-muted">Create a dataset in Evaluations, then refresh this list.</p>}{pendingPromotion.current && <p className="text-xs" role="status">The request is kept. Retrying it checks whether it went through, without saving another revision.</p>}{receipt && <div className="rp-fade-rise rounded-md border border-rp-success-border bg-rp-success-soft px-4 py-3 text-[13px] text-rp-ink">
    <p>Saved revision {receipt.datasetVersion} · {receipt.caseIds.length} {receipt.caseIds.length === 1 ? "case" : "cases"} added</p>
    <p className="rp-meta mt-1 break-all">{receipt.datasetHash}</p>
    <Link className="mt-2 inline-block font-medium text-rp-blue underline-offset-4 transition-colors duration-250 ease-standard hover:text-rp-blue-hover hover:underline" to={`/evaluations?${new URLSearchParams({ datasetId: receipt.datasetId, version: String(receipt.datasetVersion) })}`}>Open saved dataset revision</Link>
    </div>}</section>
  </div>;
}
