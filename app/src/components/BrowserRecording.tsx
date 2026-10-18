import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, Square, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { parseRecordingBatch, RECORDING_LIMITS as L, type LayoutFrame, type RecordingEvent, type RecordingSummary } from "../../../src/verification/recording-types";

type Props = {
  summary: RecordingSummary | null; batches: readonly string[]; cursorEpochMs: number | null;
  onCursorChange: (epochMs: number) => void; loading?: boolean; error?: string;
  onStop?: () => Promise<void>; onExport?: () => Promise<void>; onDelete?: () => Promise<void>;
};
const labels = ["Layout", "Pointer", "Click", "Input", "Change", "Focus", "Scroll", "Key", "Document"];
const touch = "min-h-11";
function lastMatching<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) if (match(items[index])) return items[index];
}

function inertDocument(frame: LayoutFrame, marker: RecordingEvent | undefined): string {
  const rectangles = frame.nodes.map(node => {
    const [x, y, width, height] = node.rect, [r, g, b, a] = node.paint;
    const box = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="rgb(${r},${g},${b})" fill-opacity="${a / 255}" stroke="#d9deea" stroke-width="1"/>`;
    const mask = node.kind === 1 || node.kind === 2 ? `<rect x="${x + Math.min(8, width / 4)}" y="${y + height / 3}" width="${Math.max(0, width - Math.min(16, width / 2))}" height="${Math.min(7, height / 3)}" rx="2" fill="#7c8494"/>` : "";
    return box + mask;
  }).join("");
  const pointer = marker && marker.kind !== 0 && marker.x !== null && marker.y !== null ? `<circle cx="${marker.x}" cy="${marker.y}" r="7" fill="#0021cc" stroke="#ffffff" stroke-width="2"/>` : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"><style>html,body{margin:0;background:#f9fafc}svg{display:block;width:100vw;height:100vh}</style><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Masked captured layout" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${frame.viewport[0]} ${frame.viewport[1]}">${rectangles}${pointer}</svg></html>`;
}

export function BrowserRecording({ summary, batches, cursorEpochMs, onCursorChange, loading = false, error, onStop, onExport, onDelete }: Props) {
  const heading = useId(), slider = useId(), operationEpoch = useRef(0);
  const [localEpoch, setLocalEpoch] = useState<number | null>(null), [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(""), [operationError, setOperationError] = useState("");
  const decoded = useMemo(() => {
    try {
      if (batches.length > L.batches || batches.some(item => typeof item !== "string" || item.length > L.batchBytes) || batches.reduce((size, item) => size + new TextEncoder().encode(item).byteLength, 0) > L.recordingBytes) throw new Error();
      const entries = batches.map(parseRecordingBatch);
      if (entries.some((entry, index) => entry.sequence !== index)) throw new Error();
      const events = entries.flatMap(entry => entry.events);
      if (events.some((event, index) => index > 0 && (event.ordinal <= events[index - 1].ordinal || event.epochMs < events[index - 1].epochMs))) throw new Error();
      return { events, invalid: false };
    } catch { return { events: [] as RecordingEvent[], invalid: true }; }
  }, [batches]);
  const frames = decoded.events.filter((event): event is LayoutFrame => event.kind === 0);
  const start = frames[0]?.epochMs, end = decoded.events[decoded.events.length - 1]?.epochMs;
  const offset = summary?.clockOffsetMs;
  const aligned = offset !== null && offset !== undefined && Number.isFinite(offset);
  const external = aligned && cursorEpochMs !== null && Number.isFinite(cursorEpochMs) ? cursorEpochMs - offset : null;
  const cursor = external ?? localEpoch ?? start ?? null;
  const frame = cursor === null ? undefined : lastMatching(frames, item => item.epochMs <= cursor);
  const marker = cursor === null ? undefined : lastMatching(decoded.events, item => item.epochMs <= cursor && item.kind !== 0);
  const gone = summary?.status === "deleted", visibleFrame = gone ? undefined : frame;
  const outside = cursor !== null && start !== undefined && end !== undefined && (cursor < start || cursor > end);
  const ready = !loading && !decoded.invalid && !gone && start !== undefined && end !== undefined && !busy;
  const document = visibleFrame && !outside ? inertDocument(visibleFrame, marker) : undefined;
  const seek = (value: number) => { setLocalEpoch(value); if (aligned) onCursorChange(value + offset); };
  const playback = useRef({ cursor, seek, end, ready }); playback.current = { cursor, seek, end, ready };
  useEffect(() => {
    const owner = operationEpoch;
    owner.current++; setLocalEpoch(null); setPlaying(false); setBusy(""); setOperationError("");
    return () => { owner.current++; };
  }, [summary?.id]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const current = playback.current;
      if (!current.ready || current.cursor === null || current.end === undefined || current.cursor >= current.end) { setPlaying(false); return; }
      current.seek(Math.min(current.end, current.cursor + 100));
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing]);
  const perform = async (label: string, operation: (() => Promise<void>) | undefined) => {
    if (!operation) return;
    const epoch = ++operationEpoch.current; setPlaying(false); setBusy(label); setOperationError("");
    try { await operation(); } catch { if (epoch === operationEpoch.current) setOperationError(`${label} unavailable. Retained evidence can be inspected again.`); }
    finally { if (epoch === operationEpoch.current) setBusy(""); }
  };
  const problem = error || operationError || (decoded.invalid ? "Recording content is unavailable or corrupt." : "");
  return <section aria-labelledby={heading} data-masked-recording className="min-w-0 space-y-4 rounded-lg border border-[color:var(--rp-border)] bg-[color:var(--rp-surface)] p-4 sm:p-5">
    <header className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 space-y-1"><h2 id={heading} className="text-sm font-semibold text-[color:var(--rp-ink-strong)]">Masked layout recording</h2><p className="max-w-2xl text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">Main document geometry sampled every 500 ms. All text and input values are masked; embedded and shadow content is unavailable.</p></div><span className="rounded-full border border-[color:var(--rp-border)] px-2.5 py-1 text-xs">{summary ? summary.status : "Recording off"}</span></header>
    <div role="status" aria-live="polite" className="text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">{busy || (loading ? "Loading retained recording…" : !summary ? "Recording starts only with explicit consent in the trusted browser." : gone ? "Recording content deleted. Lifetime identity retained." : summary.loss ? `Partial capture · ${summary.reason} · ${summary.dropped === null ? "lost population unknown" : `${summary.dropped} reported drops`}` : `${summary.batches} retained batches · ${summary.events} retained observations`)}</div>
    {problem && <p role="alert" className="break-words text-xs text-[color:var(--rp-error)]">{problem}</p>}
    {summary && !gone && <p className="text-xs text-[color:var(--rp-ink-soft)]">{aligned ? `Trace alignment uncertainty: ±${summary.clockUncertaintyMs} ms.` : "Trace clock alignment unavailable. Seek uses this recording’s own clock."}</p>}
    {document ? <iframe title="Inert masked layout player" sandbox="" referrerPolicy="no-referrer" tabIndex={-1} srcDoc={document} data-recorded-frame={visibleFrame?.ordinal} className="block w-full rounded-md border border-[color:var(--rp-border)] bg-[color:var(--rp-canvas)]" style={{ aspectRatio: `${visibleFrame!.viewport[0]} / ${visibleFrame!.viewport[1]}`, minHeight: 140, maxHeight: 480 }} /> : <div className="flex min-h-36 items-center justify-center rounded-md border border-dashed border-[color:var(--rp-border)] bg-[color:var(--rp-canvas)] p-4 text-center text-xs text-[color:var(--rp-ink-soft)]">{outside ? "Cursor is outside the retained recording window." : gone ? "Recording content unavailable after deletion." : loading ? "Loading masked layout…" : "No retained layout frame at this cursor."}</div>}
    <div className="space-y-2"><label htmlFor={slider} className="block text-xs font-medium">Recording cursor {cursor !== null && start !== undefined ? `· ${((cursor - start) / 1000).toFixed(2)} s` : ""}</label><input id={slider} aria-label="Recording cursor" className="min-h-11 w-full accent-[color:var(--rp-accent)]" type="range" min={start ?? 0} max={end ?? 0} step={1} value={cursor === null || start === undefined || end === undefined ? 0 : Math.max(start, Math.min(end, cursor))} disabled={!ready} onChange={event => { setPlaying(false); seek(Number(event.target.value)); }} /></div>
    <div className="flex flex-wrap items-center gap-2"><Button className={touch} variant="outline" disabled={!ready} onClick={() => { if (!playing && cursor !== null && end !== undefined && cursor >= end && start !== undefined) seek(start); setPlaying(!playing); }}>{playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{playing ? "Pause recording" : "Play recording"}</Button><Button className={touch} variant="outline" disabled={!onStop || summary?.status !== "recording" || !!busy} onClick={() => void perform("Stop recording", onStop)}><Square aria-hidden="true" />Stop recording</Button><Button className={touch} variant="outline" disabled={!onExport || !ready} onClick={() => void perform("Export recording", onExport)}><Download aria-hidden="true" />Export masked data</Button><Button className={touch} variant="ghost" disabled={!onDelete || !summary || gone || !!busy} onClick={() => void perform("Delete recording", onDelete)}><Trash2 aria-hidden="true" />Delete recording</Button></div>
    {visibleFrame && !outside && <p className="text-xs text-[color:var(--rp-ink-soft)]">Frame {visibleFrame.ordinal} · {visibleFrame.nodes.length} retained nodes / {visibleFrame.visited} visited{visibleFrame.clipped ? " · layout clipped" : ""}{marker ? ` · ${labels[marker.kind]} observation` : ""}</p>}
  </section>;
}
