import { useEffect, useRef, useState } from "react";
import type { DatasetRevision } from "../../../../src/evaluations/protocol";
import type { DatasetExecution as Execution, ExecutionDraft, AttemptStatus } from "../../../../src/evaluations/execution-protocol";
import { Button } from "../ui/button";
import { Field, Select } from "../verification/PredicateEditor";

export interface ExecutionCapabilities {
  enabled: boolean;
  endpoints: Array<{ name: string; available: boolean; reason: string; maximumAttemptCostUsd: number }>;
}
export interface DatasetExecutionClient {
  capabilities(signal: AbortSignal): Promise<ExecutionCapabilities>;
  start(draft: ExecutionDraft, signal: AbortSignal): Promise<Execution>;
  get(id: string, signal: AbortSignal): Promise<Execution>;
  cancel(id: string, signal: AbortSignal): Promise<Execution>;
}

const attemptLabels: Record<AttemptStatus, string> = { not_started: "Not started", running: "Request running", transport_success: "Response received", failed: "Request failed", timed_out: "Timed out", cancelled: "Cancelled", interrupted: "Interrupted", unavailable: "Unavailable" };

/** Unmounted until the native coordinator and durable admission routes are qualified. */
export function DatasetExecution(props: { revision: DatasetRevision; client: DatasetExecutionClient }) {
  return <DatasetExecutionForm key={`${props.revision.datasetId}:${props.revision.version}:${props.revision.hash}`} {...props} />;
}

function DatasetExecutionForm({ revision, client }: { revision: DatasetRevision; client: DatasetExecutionClient }) {
  const [enabled, setEnabled] = useState(false), [capabilities, setCapabilities] = useState<ExecutionCapabilities | null>(null);
  const [endpoint, setEndpoint] = useState(""), [concurrency, setConcurrency] = useState(1), [attempts, setAttempts] = useState(1), [deadline, setDeadline] = useState(30_000);
  const [permission, setPermission] = useState(false), [retryPermission, setRetryPermission] = useState(false);
  const [execution, setExecution] = useState<Execution | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const generation = useRef(0), request = useRef<AbortController | null>(null);
  const identity = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => () => { generation.current++; request.current?.abort(); }, [revision.datasetId, revision.version]);
  const selected = capabilities?.endpoints.find(item => item.name === endpoint);
  const active = execution?.status === "queued" || execution?.status === "running";
  async function perform<T>(work: (signal: AbortSignal) => Promise<T>, consume: (value: T) => void) {
    const current = ++generation.current; request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError("");
    try { const value = await work(controller.signal); if (generation.current === current) consume(value); }
    catch (cause) { if (generation.current === current) setError(cause instanceof Error ? cause.message : "Execution request could not finish."); }
    finally { if (generation.current === current) setBusy(false); }
  }
  function optIn(checked: boolean) {
    generation.current++; request.current?.abort(); setBusy(false); setEnabled(checked); setPermission(false); setRetryPermission(false); setEndpoint(""); setCapabilities(null); setError("");
    if (checked) void perform(signal => client.capabilities(signal), setCapabilities);
  }
  function start() {
    if (!selected?.available || !permission || (attempts > 1 && !retryPermission)) return;
    const fields = { datasetId: revision.datasetId, version: revision.version, datasetHash: revision.hash, endpointName: endpoint,
      concurrency, timeoutMs: deadline, maxAttempts: attempts, maxCostPerAttemptUsd: selected.maximumAttemptCostUsd,
      maxTotalCostUsd: selected.maximumAttemptCostUsd * revision.cases.length * attempts, allowSideEffects: true as const };
    const signature = JSON.stringify(fields);
    if (identity.current?.signature !== signature) identity.current = { signature, key: crypto.randomUUID() };
    const draft = { ...fields, operationKey: identity.current.key };
    void perform(signal => client.start(draft, signal), value => { setExecution(value); identity.current = null; });
  }
  function download() {
    if (!execution) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(execution, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `dataset-execution-${execution.id}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return <section aria-label="Explicit dataset execution" className="space-y-4 border-t border-[color:var(--rp-border)] pt-5">
    <h2 className="text-sm font-semibold">Run the frozen dataset</h2>
    <p className="max-w-2xl text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">Execute revision {revision.version} of {revision.datasetName} through a locally registered agent endpoint. This starts new agent work and may invoke tools. Grading existing captured runs remains a separate action.</p>
    <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={enabled} disabled={busy || active} onChange={event => optIn(event.target.checked)} /><span>Enable explicit execution for this dataset</span></label>
    {enabled && <div className="space-y-4">
      {!capabilities && !error && <p role="status" className="text-xs">Checking registered execution capability…</p>}
      {capabilities && !capabilities.enabled && <p className="text-xs">Dataset execution is disabled in this daemon. Your captured evaluations remain available.</p>}
      {capabilities?.enabled && <>
        <Field label="Registered execution endpoint"><Select value={endpoint} disabled={busy || active} onChange={event => { setEndpoint(event.target.value); setPermission(false); }}><option value="">Choose a registered endpoint</option>{capabilities.endpoints.map(item => <option key={item.name} value={item.name} disabled={!item.available}>{item.name}{item.available ? "" : " (unavailable)"}</option>)}</Select></Field>
        {selected && <p className="text-xs">{selected.reason} Maximum admitted cost: ${(selected.maximumAttemptCostUsd * revision.cases.length * attempts).toFixed(6)} USD. Actual provider cost may be unavailable.</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Concurrent cases"><Select value={concurrency} disabled={busy || active} onChange={event => setConcurrency(Number(event.target.value))}><option value={1}>1 case</option><option value={2}>2 cases, shared global limit</option></Select></Field>
          <Field label="Maximum attempts per case"><Select value={attempts} disabled={busy || active} onChange={event => { setAttempts(Number(event.target.value)); setRetryPermission(false); }}><option value={1}>1 — no retry</option><option value={2}>2 — retry on failure</option><option value={3}>3 — retry on failure</option></Select></Field>
          <Field label="Total admission deadline"><Select value={deadline} disabled={busy || active} onChange={event => setDeadline(Number(event.target.value))}><option value={10_000}>10 seconds</option><option value={30_000}>30 seconds</option><option value={120_000}>120 seconds</option></Select></Field>
        </div>
        <p className="text-xs">{revision.cases.length} frozen cases · {revision.cases.length * attempts} planned attempt slots. Failures, timeouts and cancellations remain in the result. Endpoint acceptance does not prove completed capture or final server persistence.</p>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={permission} disabled={busy || active} onChange={event => setPermission(event.target.checked)} /><span>I allow new endpoint and tool side effects for every case.</span></label>
        {attempts > 1 && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={retryPermission} disabled={busy || active} onChange={event => setRetryPermission(event.target.checked)} /><span>I allow repeated side effects when an attempt fails or times out.</span></label>}
        <Button disabled={busy || active || !revision.cases.length || !selected?.available || !permission || (attempts > 1 && !retryPermission)} onClick={start}>Run frozen revision {revision.version}</Button>
      </>}
    </div>}
    {error && <p role="alert" className="break-words text-xs text-[color:var(--rp-danger)]">{error}</p>}
    {execution && <div aria-label="Dataset execution results" className="space-y-3 text-xs">
      <p role="status">Execution {execution.status} · {execution.cases.length} frozen cases · revision {execution.dataset.version}</p>
      <p className="break-all">Execution identity: {execution.id}</p>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void perform(signal => client.get(execution.id, signal), setExecution)}>Refresh execution</Button>{active && <Button variant="outline" disabled={busy} onClick={() => void perform(signal => client.cancel(execution.id, signal), setExecution)}>Cancel remaining work</Button>}<Button variant="outline" onClick={download}>Download execution JSON</Button></div>
      <ol className="space-y-4">{execution.cases.map(item => <li key={item.case.id} className="space-y-2 border-b border-[color:var(--rp-border)] pb-3"><h3 className="font-semibold">{item.case.name}</h3><details><summary className="cursor-pointer">Frozen case input</summary><pre className="mt-2 whitespace-pre-wrap break-words">{item.case.input ?? "Unavailable"}</pre></details><p>Captured grading: {item.grading.status}. {item.grading.reason}</p><ol className="space-y-2">{item.attempts.map(attempt => <li key={attempt.id} className="space-y-1"><p>Attempt {attempt.index + 1}: {attemptLabels[attempt.status]} · {attempt.sideEffects === "not_dispatched" ? "No dispatch" : "External side effects may have occurred"}</p><p className="break-words">{attempt.reason}</p><p className="break-all">Attempt identity: {attempt.id}</p><p>Actual cost: {attempt.actualCostUsd === null ? "Unavailable" : `${attempt.actualCostUsd} USD`}</p>{attempt.runId && <a className="break-all underline" href={`/runs/${encodeURIComponent(attempt.runId)}`}>Open newly captured run</a>}</li>)}</ol></li>)}</ol>
    </div>}
  </section>;
}
