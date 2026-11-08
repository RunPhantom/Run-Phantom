import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
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
const panel = "rp-fade-rise min-w-0 rounded-lg border border-rp-line bg-white p-5 sm:p-6";
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
    <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-rp-line bg-white p-6 shadow-e4 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] motion-reduce:animate-none">
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
  const refresh = useCallback(async () => { const values = await api.queues(); setQueues(values); }, []);
  useEffect(() => { let active = true; api.queues().then(values => { if (active) setQueues(values); }).catch(failure => { if (active) setError(errorText(failure)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  const queue = queues.find(value => value.id === selected);
  const reportDirty = useCallback((count: number, inFlight: number) => { dirty.current = count; onRetainedChange?.({ retained: count, inFlight }); }, [onRetainedChange]);
  const selectQueue = (id: string) => { if (workspaceBusy || dirty.current) { setError("Your drafts are retained. Save, retry or discard them before switching queues."); return; } setError(""); setSelected(id); };
  return <main className="mx-auto w-full max-w-[1440px] space-y-6 px-5 py-8 text-rp-ink sm:px-10 sm:py-11">
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
    <div className="min-w-0">
    <p className="rp-eyebrow" data-tone="accent"><span aria-hidden="true" className="rp-eyebrow-marker" />Local curation</p>
    <h1 className="rp-page-title mt-3">Review queues</h1>
    <p className="rp-lede mt-3">Review frozen trace responses, edit structured targets, and add approved examples to a dataset.</p>
    </div>
    <Button variant="outline" className="min-h-10" disabled={loading || busy || workspaceBusy} onClick={() => void refresh().catch(failure => setError(errorText(failure)))}>Refresh queues</Button>
    </header>
    {error && <p role="alert" className={alertBox}>{error}</p>}
    <section className={panel} aria-label="Queue selection">
    <div className="grid items-end gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <Field label="Review queue">
    <Select className="min-h-10" value={selected} disabled={loading || workspaceBusy} onChange={event => selectQueue(event.target.value)}>
    <option value="">Choose a queue</option>{queues.map(value => <option key={value.id} value={value.id}>{value.name} · {value.counts.total} items</option>)}</Select>
    </Field>
    <form className="flex items-end gap-2" onSubmit={async event => { event.preventDefault(); if (workspaceBusy || dirty.current) { setError("Save or discard retained drafts before creating a queue."); return; } setBusy(true); setError(""); try { const made = await api.create(name, schema); await refresh(); setSelected(made.id); setName(""); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }}>
    <div className="min-w-0 flex-1">
    <Field label="New queue name">
    <Input className="min-h-10" maxLength={128} value={name} onChange={event => setName(event.target.value)} />
    </Field>
    </div>
    <Button className="min-h-10" disabled={busy || workspaceBusy || !name.trim()}>Create queue</Button>
    </form>
    </div>
    <div className="mt-4">
    <QueueSchemaEditor schema={schema} onChange={setSchema} />
    </div>{loading && <p className="mt-3 text-sm" role="status">Loading queues…</p>}{!loading && !queues.length && <p className="mt-3 text-sm text-rp-ink-muted">No review queues yet. Create a queue, then add a captured run.</p>}{selected && !queue && !loading && <p className="mt-3 text-sm" role="alert">This queue is unavailable or was deleted. Refresh queues to continue.</p>}</section>
    {queue && <QueueWorkspace key={queue.id} queue={queue} initialItemId={queue.id === initialQueueId ? initialItemId : ""} onDirty={reportDirty} onBusy={setWorkspaceBusy} onChanged={refresh} onConfirm={setConfirmation} />}
    {queue && <section className={`${panel} space-y-3`} aria-label="Review retention">
    <h2 className={heading}>Stored locally until you delete it</h2>
    <p className="text-xs leading-5 text-rp-ink-muted">Review queues retain safe source snapshots and drafts on this device. Limits: 100 queues, 10,000 items per queue, 50,000 items total and 256 MiB of logical source, draft, schema and receipt content. Retention stops at the limit; it does not silently evict drafts. Deleting a source run removes its queued items. Promoted dataset revisions keep their existing frozen examples.</p>
    <Button variant="destructive-outline" className="min-h-10" disabled={workspaceBusy} onClick={() => setConfirmation({ title: "Delete this review queue?", description: "The queue, all retained drafts and source snapshots, and its promotion receipts will be deleted. Existing dataset revisions remain.", action: async () => { if (workspaceBusy || dirty.current) throw new Error("Save or discard retained drafts before deleting this queue."); await api.deleteQueue(queue.id); setSelected(""); await refresh(); } })}>Delete queue</Button>
    </section>}
    <ConfirmationDialog value={confirmation} close={() => setConfirmation(null)} />
  </main>;
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
  const approve = useCallback(async () => { if (!item) return; await perform(async () => { const result = await state.approve(item); setWindow(prior => prior.map(value => value.id === result.id ? result : value)); setSelection(prior => new Map(prior).set(result.id, result.revision)); setRefreshTick(tick => tick + 1); await onChanged(); setNotice("Local review approved. This is operator curation, not an evaluation result."); }); }, [item, state, perform, onChanged]);
  const step = useCallback(async (direction: -1 | 1) => { const index = windowItems.findIndex(value => value.id === centerId), next = windowItems[index + direction]; if (next) await loadWindow(next.id); }, [windowItems, centerId, loadWindow]);
  useEffect(() => { const shortcut = (event: KeyboardEvent) => { if (!allowsReviewShortcut(event) || busy) return; if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); void step(event.key === "ArrowLeft" ? -1 : 1).catch(failure => setError(errorText(failure))); } else if (event.key === "Enter" && item?.state === "draft" && !pending?.conflict) { event.preventDefault(); void approve(); } }; window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut); }, [busy, item, pending?.conflict, step, approve]);
  const edit = (next: ReviewDraft) => { if (!item) return; try { state.edit(item, next); setError(""); } catch (failure) { setError(errorText(failure)); } };
  const updateSelection = (id: string, revision: number, checked: boolean) => { if (pendingPromotion.current) { setError("Retry the pending promotion before changing its selection."); return; } if (checked && !selection.has(id) && selection.size >= 50) { setError("Select up to 50 approved items."); return; } setSelection(prior => { const next = new Map(prior); if (checked) next.set(id, revision); else next.delete(id); return next; }); };
  const choose = async (id: string) => { if (busy) return; setError(""); try { await loadWindow(id); } catch (failure) { setError(errorText(failure)); } };
  const disabled = busy || !!pending?.approving || item?.state !== "draft";
  return <div className="space-y-5">
    <section className={panel} aria-label="Add captured source">
    <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <Field label="Find a source run">
    <div className="flex gap-2">
    <Input className="min-h-10" value={runQuery} maxLength={128} onChange={event => setRunQuery(event.target.value)} placeholder="Search captured runs" />
    <Button className="min-h-10" variant="outline" disabled={busy} onClick={() => void perform(async () => { const result = await searchRuns({ q: runQuery, limit: 50 }); setRuns(result.runs.slice(0,50).map(run => ({ id: run.id, name: run.name ?? run.id }))); })}>Search</Button>
    </div>
    </Field>
    <Field label="Source run">
    <Select className="min-h-10" value={runId} onChange={event => setRunId(event.target.value)}>
    <option value="">Choose a captured run</option>{runs.map(run => <option key={run.id} value={run.id}>{run.name}</option>)}</Select>
    </Field>
    <Field label="Response span">
    <Select className="min-h-10" value={spanId} onChange={event => setSpanId(event.target.value)}>
    <option value="">Use the run response</option>{spans.map(span => <option key={span.id} value={span.id}>{span.name} · {span.id}</option>)}</Select>
    </Field>
    <Button className="min-h-10" disabled={busy || !runId} onClick={() => void perform(async () => { const inserted = await api.insert(queue.id, runId, spanId || undefined); await loadWindow(inserted.id); setRefreshTick(tick => tick + 1); await onChanged(); setNotice("Source snapshot retained. Retrying intake keeps this original snapshot."); })}>Add to queue</Button>
    </div>
    </section>
    {error && <p role="alert" className={alertBox}>{error}</p>}
    <p role="status" aria-live="polite" className="text-sm text-rp-ink-muted">{state.dirtyCount ? `${state.dirtyCount} drafts retained on this page${pending?.busy ? " · saving…" : ""}` : notice || "All acknowledged edits saved"}</p>
    {!!state.entries.size && <section aria-label="Retained drafts" className={`${panel} space-y-3`}>
    <h2 className="text-sm font-semibold">Retained drafts</h2>{[...state.entries].map(([id, value]) => <div key={id} className="flex flex-wrap items-center gap-2 text-xs">
    <Button variant="ghost" className="min-h-10" disabled={busy} onClick={() => void choose(id)}>{value.draft.name}</Button>
    <span role={value.error ? "alert" : undefined}>{value.error || (value.busy ? "Saving…" : "Awaiting save")}</span>{value.error && !value.conflict && <Button className="min-h-10" variant="outline" disabled={busy || value.busy} onClick={() => void perform(async () => { await state.retry(id); if (state.entries.get(id)?.error) throw new Error(state.entries.get(id)!.error!); await loadWindow(id); })}>Retry save</Button>}{value.conflict && <Button className="min-h-10" variant="outline" disabled={busy || value.busy} onClick={() => void perform(async () => { const latest = await loadWindow(id); if (!latest) throw new Error("The source item was deleted. Discard its retained draft to continue."); state.reapply(id,latest); await state.save(id); if (state.entries.get(id)?.error) throw new Error(state.entries.get(id)!.error!); await loadWindow(id); })}>Reapply to latest revision</Button>}<Button className="min-h-10" variant="ghost" disabled={busy || value.busy} onClick={() => onConfirm({ title: "Discard this retained draft?", description: "Your unsaved changes will be removed. The last acknowledged server revision remains.", action: async () => { state.discard(id); await loadWindow(id); } })}>Discard draft</Button>
    </div>)}</section>}
    <div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <section aria-label="Queue items" className={panel}>
    <h2 className={heading}>{queue.name}</h2>{page && <p className="mt-2 text-xs leading-5 text-rp-ink-muted">{page.counts.total} items · {page.counts.draft} drafts · {page.counts.approved} approved · {page.counts.promoted} promoted</p>}{loading && <p role="status" className="mt-4 text-sm">Loading items…</p>}{page && !page.items.length && <p className="mt-4 text-sm text-rp-ink-muted">This page has no items. Add a captured source to start reviewing.</p>}<ol className="mt-4 space-y-2">{page?.items.map(row => <li key={row.id} className={`flex items-start gap-2 rounded-md border transition-[background-color,border-color] duration-250 ease-standard ${centerId === row.id ? "border-rp-wash-border bg-rp-wash shadow-[inset_2px_0_0_var(--rp-blue)] [&_.rq-row-name]:text-rp-blue" : "border-rp-line bg-white hover:border-rp-wash-border hover:bg-rp-row-hover"}`}>
        {row.state === "approved" && <input className="ml-3 mt-4 size-4 accent-rp-blue" type="checkbox" aria-label={`Select ${row.name} for promotion`} checked={selection.has(row.id)} onChange={event => updateSelection(row.id,row.revision,event.target.checked)} />}<button type="button" disabled={busy} aria-current={centerId === row.id ? "true" : undefined} className="min-h-10 min-w-0 flex-1 rounded-md p-3 text-left text-[13px]" onClick={() => void choose(row.id)}>
    <span className="rq-row-name block break-words font-semibold">{row.name}</span>
    <span className="mt-1 block text-xs text-rp-ink-muted">{row.state === "approved" ? "Local review approved" : row.state === "promoted" ? "Added to dataset" : "Draft"} · revision {row.revision}{state.entries.has(row.id) ? " · draft retained" : ""}</span>
    </button>
    </li>)}</ol>
    <div className="mt-4 flex gap-2">
    <Button className="min-h-10" variant="outline" disabled={loading || !history.length} onClick={() => { setCursor(history[history.length - 1]!); setHistory(prior => prior.slice(0,-1)); }}>Previous page</Button>
    <Button className="min-h-10" variant="outline" disabled={loading || !page?.nextCursor} onClick={() => { setHistory(prior => [...prior,cursor].slice(-20)); setCursor({ limit: 50, ...page!.nextCursor! }); }}>Next page</Button>
    </div>
    </section>
      {!item || !draft ? <section className={`${panel} py-12`}>
    <h2 className={heading}>Choose an item to review</h2>
    <p className="mt-3 text-sm leading-6 text-rp-ink-muted">The selected item opens with its frozen source and editable target. Only a five-item source window is loaded.</p>
    </section> : <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
    <p className="rp-eyebrow">Revision {pending?.server.revision ?? item.revision} · {item.state === "draft" ? "Draft review" : item.state === "approved" ? "Local operator review approved" : "Promoted to dataset"}</p>
    <div className="flex gap-2">
    <Button variant="outline" className="min-h-10" disabled={busy || windowItems[0]?.id === centerId} onClick={() => void perform(() => step(-1))}>Previous item</Button>
    <Button variant="outline" className="min-h-10" disabled={busy || windowItems[windowItems.length - 1]?.id === centerId} onClick={() => void perform(() => step(1))}>Next item</Button>
    </div>
    </div>
        <div className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
    <section className={panel} aria-label="Frozen source">
    <h2 className={heading}>Frozen source</h2>
    <p className="mt-2 break-all text-xs text-rp-ink-muted">{item.source.runName} · <span className="rp-meta">{item.source.runId}</span></p>
    <p className="mt-1 break-all text-xs text-rp-ink-muted">Response <span className="rp-meta">{item.source.resolvedOutputSpanId ?? "unavailable"}</span></p>{(!item.source.complete || item.source.redacted || item.source.truncated) && <p role="status" className="mt-3 rounded-md border border-rp-warning-border bg-rp-warning-soft px-3 py-2 text-xs leading-5 text-rp-warning">Source evidence is incomplete, redacted or truncated. Targets remain operator supplied.</p>}<h3 className={evidenceLabel}>Captured input</h3>
    <pre className={`${evidenceWell} max-h-48`}>{item.source.input ?? "Input unavailable"}</pre>
    <h3 className={evidenceLabel}>Captured response</h3>
    <pre className={`${evidenceWell} max-h-80`}>{item.source.output ?? "Response unavailable"}</pre>{item.source.warnings.length > 0 && <ul className="mt-3 list-inside list-disc text-xs text-rp-ink-muted">{item.source.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}</section>
        <section className={`${panel} space-y-4`} aria-label="Review draft">
    <h2 className={heading}>Review target</h2>
    <p className="text-xs leading-5 text-rp-ink-muted">Approval records local operator curation. It does not record a machine verdict or identify an authenticated reviewer.</p>
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
    <h2 className={heading}>Add approved examples to a dataset</h2>
    <p className="mt-2 text-sm text-rp-ink-muted">{selection.size} approved items selected. Promotion creates one frozen dataset revision and a retained retry receipt.</p>
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
    </div>{!datasets.length && <p className="text-sm text-rp-ink-muted">Create a dataset in Evaluations, then refresh this list.</p>}{pendingPromotion.current && <p className="text-xs" role="status">The original promotion request is retained. Retry it to check its receipt without creating another revision.</p>}{receipt && <div className="rp-fade-rise rounded-md border border-rp-success-border bg-rp-success-soft px-4 py-3 text-[13px] text-rp-ink">
    <p>Saved revision {receipt.datasetVersion} · {receipt.caseIds.length} frozen examples</p>
    <p className="rp-meta mt-1 break-all">{receipt.datasetHash}</p>
    <Link className="mt-2 inline-block font-medium text-rp-blue underline-offset-4 transition-colors duration-250 ease-standard hover:text-rp-blue-hover hover:underline" to={`/evaluations?${new URLSearchParams({ datasetId: receipt.datasetId, version: String(receipt.datasetVersion) })}`}>Open saved dataset revision</Link>
    </div>}</section>
  </div>;
}
