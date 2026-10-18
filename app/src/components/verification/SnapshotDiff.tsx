import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Select } from "./PredicateEditor";
import { verificationApi } from "../../api/verification";
import { compactTree } from "../../../../src/verification/compact-tree";
import type { SavedSemanticSnapshot, SnapshotDiffResult } from "../../../../src/verification/snapshot-contract";

function capturedDate(timestamp: number): { label: string; short: string; iso?: string } {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? { label: date.toLocaleString(), short: date.toLocaleTimeString(), iso: date.toISOString() } : { label: "Timestamp outside display range", short: "Timestamp outside display range" };
}
function SnapshotTree({ snapshot }: { snapshot: SavedSemanticSnapshot }) {
  const captured = capturedDate(snapshot.capturedAt);
  return <article aria-label={`Captured tree: ${snapshot.name}`} className="min-w-0 space-y-3 rounded-md border border-[color:var(--rp-border)] p-3">
    <h3 className="break-words text-sm font-semibold">{snapshot.name}</h3>
    <p className="break-all text-xs text-[color:var(--rp-ink-muted)]">{snapshot.origin} · {snapshot.source === "paired-sdk" ? "Paired SDK" : "Imported evidence"}</p>
    <p className="break-words text-xs text-[color:var(--rp-ink-soft)]"><time dateTime={captured.iso}>{captured.label}</time> · Connection generation {snapshot.connectionGeneration ?? "unavailable on import"} · Document {snapshot.tree.documentGeneration.slice(0, 8)}</p>
    <p className="text-xs text-[color:var(--rp-ink-soft)]">{snapshot.tree.availability === "complete" ? "Complete within the visible observable scope." : `Partial capture: ${snapshot.tree.coverage.reasons.join(", ") || "some observations unavailable"}.`} Closed shadow roots are unobservable. Open shadow roots: {snapshot.tree.coverage.openShadowRoots}; same-origin frames: {snapshot.tree.coverage.sameOriginFrames}; inaccessible frames: {snapshot.tree.coverage.inaccessibleFrames}.</p>
    {!!snapshot.tree.coverage.unread.length && <ul className="text-xs text-[color:var(--rp-warning)]">{snapshot.tree.coverage.unread.map((entry, index) => <li key={index} className="break-words">{entry.tag}: {entry.reason}</li>)}</ul>}
    <div role="region" aria-label={`Semantic tree rows: ${snapshot.name}`} tabIndex={0} className="max-h-72 overflow-auto rounded-sm bg-[color:var(--rp-canvas)] p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--rp-accent)]">
      {snapshot.tree.nodes.length ? <ol className="space-y-2 text-xs">{compactTree(snapshot.tree).map(row => <li key={row.index} className="break-words" style={{ paddingInlineStart: Math.min(row.depth, 8) * 10 }}><span className="text-[color:var(--rp-ink-muted)]">{row.index + 1}. </span>{row.boundary && <span className="text-[color:var(--rp-ink-muted)]">[{row.boundary}] </span>}{row.text}{row.partial && <span className="text-[color:var(--rp-warning)]"> (partial)</span>}</li>)}</ol> : <p className="text-xs">{snapshot.tree.availability === "partial" ? "No semantic nodes retained; this partial capture cannot establish absence." : "No semantic nodes were observed in this captured scope."}</p>}
    </div>
  </article>;
}

export function SnapshotDiff({ sessionId, connected, capable, disabled = false, runId }: { sessionId?: string; connected: boolean; capable: boolean; disabled?: boolean; runId?: string }) {
  const client = useQueryClient();
  const snapshots = useQuery({ queryKey: ["verification", "snapshots", runId], queryFn: () => verificationApi.snapshots(runId) });
  const [name, setName] = useState(""); const [beforeId, setBeforeId] = useState(""); const [afterId, setAfterId] = useState("");
  const [result, setResult] = useState<SnapshotDiffResult | null>(null); const [busy, setBusy] = useState(""); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const sequence = useRef(0); const running = useRef(false); const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { sequence.current++; running.current = false; }, []);
  const scope = `${sessionId ?? ""}:${connected}:${capable}:${runId ?? ""}`; const currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => { sequence.current++; running.current = false; setBusy(""); }, [scope]);
  const saved = snapshots.data ?? []; const before = saved.find(item => item.id === beforeId); const after = saved.find(item => item.id === afterId);
  async function perform(label: string, operation: (current: () => boolean) => Promise<void>) {
    if (running.current || disabled) return;
    running.current = true; const ownedScope = currentScope.current; const ticket = ++sequence.current;
    const current = () => sequence.current === ticket && currentScope.current === ownedScope;
    setBusy(label); setError(""); setNotice("");
    try { await operation(current); } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "Snapshot operation failed."); }
    finally { if (current()) { running.current = false; setBusy(""); } }
  }
  const refresh = () => client.invalidateQueries({ queryKey: ["verification", "snapshots"] });
  async function capture(current: () => boolean) {
    if (!sessionId || !connected || !capable) return;
    const snapshot = await verificationApi.captureSnapshot(sessionId, name.trim()); if (!current()) return;
    await refresh(); if (!current()) return;
    if (!beforeId) setBeforeId(snapshot.id); else setAfterId(snapshot.id);
    setResult(null); setNotice("Observation saved. Its content IDs describe captured evidence and cannot target live elements.");
  }
  async function remove(id: string, current: () => boolean) {
    await verificationApi.deleteSnapshot(id); if (!current()) return;
    if (beforeId === id) setBeforeId(""); if (afterId === id) setAfterId(""); setResult(null); await refresh(); if (current()) setNotice("Snapshot deleted.");
  }
  async function importFile(file: File) {
    await perform("Importing observations…", async current => {
      if (file.size > 96 * 1024) throw new Error("Choose a snapshot transfer no larger than 96 KiB.");
      const imported = await verificationApi.importSnapshots(JSON.parse(await file.text()), runId); if (!current()) return;
      await refresh(); if (!current()) return;
      setBeforeId(imported[0].id); setAfterId(imported[1]?.id ?? ""); setResult(null); setNotice("Evidence imported with new local IDs. No application session or live authority was created.");
    });
  }
  async function exportSelected(current: () => boolean) {
    const ids = [...new Set([beforeId, afterId].filter(Boolean))]; const artifact = await verificationApi.exportSnapshots(ids); if (!current()) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "runphantom-semantic-snapshots.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice("Captured observations exported. Local session, run and connection authority are excluded.");
  }
  return <section aria-labelledby="snapshot-diff-heading" className="min-w-0 space-y-4 rounded-md border border-[color:var(--rp-border)] bg-[color:var(--rp-surface)] p-4">
    <div className="space-y-2"><h2 id="snapshot-diff-heading" className="text-sm font-semibold">Semantic snapshots</h2><p className="text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">Save visible semantic observations and compare their represented content. Names use a partial ARIA approximation. Two captured observations; differences do not establish which action caused them.</p></div>
    <fieldset disabled={!!busy || disabled || !connected || !capable} className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-[1_1_240px]"><Field label="Snapshot name"><Input value={name} maxLength={128} onChange={event => setName(event.target.value)} placeholder="Before checkout" /></Field></div>
      <Button disabled={!name.trim()} onClick={() => void perform("Capturing observation…", capture)}>Capture snapshot</Button>
    </fieldset>
    {(!connected || !capable) && <p className="text-xs text-[color:var(--rp-ink-muted)]">{!connected ? "Connect an app to capture a new observation. Saved evidence remains available." : "This runtime has no semantic tree capability. Reconnect with the current SDK to capture."}</p>}
    <fieldset disabled={!!busy || disabled} className="space-y-3">
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Before snapshot"><Select aria-label="Before snapshot" value={beforeId} onChange={event => { setBeforeId(event.target.value); setResult(null); }}><option value="">Choose baseline</option>{saved.map(item => <option key={item.id} value={item.id}>{item.name} · {capturedDate(item.capturedAt).short}</option>)}</Select></Field>
        <Field label="After snapshot"><Select aria-label="After snapshot" value={afterId} onChange={event => { setAfterId(event.target.value); setResult(null); }}><option value="">Choose observation</option>{saved.map(item => <option key={item.id} value={item.id}>{item.name} · {capturedDate(item.capturedAt).short}</option>)}</Select></Field>
      </div>
      <div className="flex flex-wrap gap-2"><Button disabled={!before || !after} onClick={() => void perform("Comparing observations…", async current => { const compared = await verificationApi.compareSnapshots(beforeId, afterId); if (current()) { setResult(compared); setNotice("Comparison complete within the captured scope."); } })}>Compare snapshots</Button><Button variant="outline" disabled={!before && !after} onClick={() => void perform("Exporting observations…", exportSelected)}>Export selected snapshots</Button><Button variant="outline" onClick={() => fileInput.current?.click()}>Import snapshots</Button><Button variant="ghost" onClick={() => void perform("Refreshing saved observations…", async current => { await refresh(); if (current()) setNotice("Saved observations refreshed."); })}>Refresh snapshots</Button></div>
      <input ref={fileInput} type="file" accept="application/json,.json" aria-label="Snapshot transfer file" className="sr-only" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} />
    </fieldset>
    <div role="status" aria-live="polite" className="text-xs text-[color:var(--rp-ink-soft)]">{busy || notice}</div>
    {(error || snapshots.error) && <p role="alert" className="break-words text-xs text-[color:var(--rp-danger)]">{error || (snapshots.error instanceof Error ? snapshots.error.message : "Saved snapshots unavailable.")}</p>}
    {snapshots.isLoading ? <p className="text-xs">Loading saved observations…</p> : !saved.length ? <p className="text-xs text-[color:var(--rp-ink-muted)]">No saved snapshots. Capture an observation or import a snapshot transfer.</p> : <details><summary className="cursor-pointer text-xs">Saved observations ({saved.length}/100)</summary><ul className="mt-3 max-h-60 space-y-3 overflow-auto text-xs">{saved.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 flex-1 break-words">{item.name} · {item.tree.availability} · {item.source === "paired-sdk" ? "Paired SDK" : "Imported evidence"}<span className="block break-all text-[color:var(--rp-ink-muted)]">{item.origin}</span></span><Button variant="ghost" size="sm" disabled={!!busy || disabled} aria-label={`Delete snapshot ${item.name}`} onClick={() => void perform("Deleting snapshot…", current => remove(item.id, current))}>Delete</Button></li>)}</ul></details>}
    {(before || after) && <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">{before && <SnapshotTree snapshot={before} />}{after && after.id !== before?.id && <SnapshotTree snapshot={after} />}</div>}
    {before && after && before.tree.documentGeneration !== after.tree.documentGeneration && <p className="text-xs text-[color:var(--rp-warning)]">Different documents were captured. Content equality does not establish live element identity.</p>}
    {result && <article aria-label="Semantic snapshot comparison" className="space-y-3 border-t border-[color:var(--rp-border)] pt-4">
      <h3 className="text-sm font-semibold">{result.change === "no-observed-changes" ? "No observed semantic changes in the captured scope" : result.change === "observed-changes" ? "Observed semantic changes" : "Comparison unavailable"}</h3>
      <p className="text-xs">{result.counts.additions ?? "Unknown"} additions · {result.counts.removals ?? "Unknown"} removals · {result.counts.matched ?? "Unknown"} matched · {result.counts.incomparableBefore ?? "Unknown"}/{result.counts.incomparableAfter ?? "Unknown"} incomparable before/after. {result.orderChanged === true ? "Represented order changed." : ""} Duplicates are counted separately.</p>
      {result.availability !== "complete" && <p className="text-xs text-[color:var(--rp-warning)]">Partial or unavailable comparison. {result.reasons.join(". ")}</p>}
      <p className="text-xs text-[color:var(--rp-ink-muted)]">Ordered display edits can differ from the multiset counts. No action or cause is inferred.</p>
      <div role="region" aria-label="Snapshot diff rows" tabIndex={0} className="max-h-72 overflow-auto rounded-md bg-[color:var(--rp-canvas)] p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--rp-accent)]"><ol className="space-y-2 font-mono text-xs">{result.rows.map((row, index) => <li key={index} className="break-words"><span className={row.kind === "insert" ? "text-[color:var(--rp-success)]" : row.kind === "delete" ? "text-[color:var(--rp-danger)]" : "text-[color:var(--rp-ink-muted)]"}>{row.kind === "insert" ? "+ Insert" : row.kind === "delete" ? "− Remove" : "= Equal"} </span>{row.text}</li>)}</ol></div>
      {!!result.limits.omittedRows && <p className="text-xs text-[color:var(--rp-warning)]">{result.limits.omittedRows} ordered rows omitted by the display budget.</p>}
    </article>}
  </section>;
}
