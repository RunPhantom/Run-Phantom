import type { SearchSpanHit, SearchSnippet } from "../../../src/search-protocol";
import type { RunListRow } from "../api/runs";
import { cn } from "@/lib/utils";
import { runDisplayName, runStatus, runStatusTone } from "../utils/helpers";
import { STATUS_DOT } from "../runs/RunsTable";

export function highlightedText(value: SearchSnippet) {
  const pieces=[];let from=0;
  for(const [index,range] of value.highlights.entries()){pieces.push(value.text.slice(from,range.start));pieces.push(<mark key={index} className="rounded-[2px] bg-rp-wash text-rp-blue">{value.text.slice(range.start,range.end)}</mark>);from=range.end;}
  pieces.push(value.text.slice(from));
  return pieces;
}
function Snippet({label,value}:{label:string;value:SearchSnippet}) {
  if(value.state==="unavailable")return <p className="mt-2 text-xs leading-5 text-rp-ink-muted">{label} unavailable: missing, too large, or rejected during redaction.</p>;
  return <div className="mt-2"><span className="rp-meta uppercase tracking-[0.12em]">{label}{value.truncated?" · excerpt":""}</span><p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-rp-ink">{highlightedText(value)}</p></div>;
}

/** Which run a step belongs to, so steps with the same name in different runs can be told apart. */
function HitRun({ runId, run, shortId }: { runId: string; run: RunListRow | undefined; shortId: string }) {
  if (!run) {
    return <p className="flex min-w-0 items-center gap-2 text-12 text-rp-ink-muted" data-span-hit-run><span className="truncate">Run details unavailable</span><span className="truncate font-mono text-11 text-rp-ink-subtle" title={runId}>{shortId}</span></p>;
  }
  const status = runStatus(run);
  const tone = runStatusTone(status.status);
  return (
    <p className="flex min-w-0 items-center gap-2 text-12" data-span-hit-run>
      <span className="truncate font-medium text-rp-ink" title={runDisplayName(run)}>{runDisplayName(run)}</span>
      <span className="shrink-0 font-mono text-11 text-rp-ink-subtle" title={run.id}>{shortId}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-rp-ink-muted" title={status.detail}>
        <span aria-hidden="true" className={cn("size-2 rounded-full", STATUS_DOT[tone])} />{status.label}
      </span>
    </p>
  );
}

export function SearchSpanHits({items,open,runs,shortIds}:{items:SearchSpanHit[];open:(hit:SearchSpanHit)=>void;runs?:ReadonlyMap<string,RunListRow>;shortIds?:ReadonlyMap<string,string>}) {
  return <div className="min-w-0 space-y-1.5">{items.map(hit=><article data-span-hit={`${hit.runId}:${hit.spanId}`} key={`${hit.runId}:${hit.spanId}`} className="min-w-0 rounded-lg border border-rp-line bg-rp-surface px-3 py-3 text-rp-ink">{runs&&<HitRun runId={hit.runId} run={runs.get(hit.runId)} shortId={shortIds?.get(hit.runId)??hit.runId.slice(0,8)}/>}<button type="button" onClick={()=>open(hit)} className="rp-ease mt-1 min-h-8 max-w-full break-words text-left font-mono text-[12px] font-medium text-rp-blue hover:text-rp-blue-hover hover:underline hover:underline-offset-4">{hit.name}</button><Snippet label="Input" value={hit.input}/><Snippet label="Output" value={hit.output}/></article>)}</div>;
}
