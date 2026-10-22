import type { Span } from "../utils/types";
import { C } from "../utils/colors";

const value = (item: string | number | null) => item === null ? "Not captured" : String(item);
export function CaptureVisibilityDetails({ span }: { span: Span }) {
  const capture = span.captureVisibility;
  if (!capture) return null;
  const retrieval = capture.retrieval, embedding = capture.embedding, stream = capture.stream;
  const title = retrieval ? "Retrieval evidence" : embedding ? "Embedding evidence" : "Stream evidence";
  const state = stream ? { completed: "Complete stream capture", cancelled: "Stream cancelled", error: "Stream failed", incomplete: "Incomplete stream capture", unknown: "Stream completion unknown" }[stream.state] : null;
  const rows: Array<[string, string | number | null]> = retrieval
    ? [["Collection", retrieval.collection], ["Top K", retrieval.topK], ["Results", retrieval.resultCount], ["Query", retrieval.queryText], ["Summary", retrieval.querySummary]]
    : embedding ? [["Model", embedding.model], ["Dimensions", embedding.dimensions], ["Input", embedding.inputText]] : [];
  if (stream) rows.push(["Time to first chunk", stream.timeToFirstChunkMs === null ? null : `${stream.timeToFirstChunkMs} ms`], ["Time per output chunk", stream.timePerOutputChunkMs === null ? null : `${stream.timePerOutputChunkMs} ms`]);
  if (capture.usage.cacheReadInputTokens !== null) rows.push(["Cache read tokens", capture.usage.cacheReadInputTokens]);
  if (capture.usage.cacheCreationInputTokens !== null) rows.push(["Cache creation tokens", capture.usage.cacheCreationInputTokens]);
  if (capture.usage.reasoningOutputTokens !== null) rows.push(["Reasoning tokens", capture.usage.reasoningOutputTokens]);
  return (
    <section aria-label={title} data-capture-span={span.id} className="rounded" style={{ border: `1px solid ${C.border}`, background: C.surface, color: C.fg2, minWidth: 0 }}>
      <details>
        <summary className="px-3 py-2 cursor-pointer text-sm font-medium" style={{ minHeight: 44, overflowWrap: "anywhere" }}>
          {title}{state ? ` · ${state}` : retrieval?.collection ? ` · ${retrieval.collection}` : ""}
        </summary>
        <div className="px-3 pb-3 space-y-3 text-xs" style={{ overflowWrap: "anywhere" }}>
          <dl className="grid gap-x-3 gap-y-2" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)" }}>
            {rows.map(([label, item]) => <div key={label} className="contents"><dt style={{ color: C.fg0 }}>{label}</dt><dd className="m-0 whitespace-pre-wrap">{value(item)}</dd></div>)}
          </dl>
          {retrieval?.filter && <div><div className="mb-1 font-medium">Captured filter</div><pre className="m-0 whitespace-pre-wrap break-words font-mono">{retrieval.filter}</pre></div>}
          {stream && <div className="space-y-2">
            <p className="m-0">{stream.coverage === "complete" ? "All declared chunks were captured." : stream.chunks.length ? "Partial observed chunks are retained. Completion is not established by this text." : "No chunk text was captured."}</p>
            {stream.chunks.length > 0 && <details><summary style={{ minHeight: 44, cursor: "pointer", paddingTop: 12 }}>Observed chunks ({stream.chunks.length})</summary>
              <ol className="m-0 pl-5 space-y-1">{stream.chunks.map(chunk => <li key={chunk.sequence}><span className="whitespace-pre-wrap">{chunk.text ?? "Text not captured"}</span></li>)}</ol>
            </details>}
            {stream.duplicateChunkCount > 0 && <p className="m-0">{stream.duplicateChunkCount} repeated chunk observations were combined.</p>}
          </div>}
          {(capture.coverage.reasons.length > 0 || (stream?.reasons.length ?? 0) > 0) && <p className="m-0" style={{ color: C.fg0 }}>
            {capture.coverage.reasons.includes("content-redacted") ? "Sensitive metadata was redacted. " : ""}
            {[...capture.coverage.reasons, ...(stream?.reasons ?? [])].some(reason => ["source-loss", "receiver-loss", "content-truncated"].includes(reason)) ? "Some evidence is missing or exceeds capture limits. " : ""}
            {stream?.state === "unknown" ? "The captured metadata does not prove stream completion." : ""}
          </p>}
        </div>
      </details>
    </section>
  );
}
