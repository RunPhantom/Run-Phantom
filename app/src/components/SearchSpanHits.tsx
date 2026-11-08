import type { SearchSpanHit, SearchSnippet } from "../../../src/search-protocol";
function Snippet({label,value}:{label:string;value:SearchSnippet}) {
  if(value.state==="unavailable")return <p className="mt-2 text-xs leading-5 text-rp-ink-muted">{label} unavailable: missing, too large, or rejected during redaction.</p>;
  const pieces=[];let from=0;
  for(const [index,range] of value.highlights.entries()){pieces.push(value.text.slice(from,range.start));pieces.push(<mark key={index} className="rounded-[2px] bg-rp-wash px-0.5 text-rp-blue">{value.text.slice(range.start,range.end)}</mark>);from=range.end;}
  pieces.push(value.text.slice(from));
  return <div className="mt-2"><span className="rp-meta uppercase tracking-[0.12em]">{label}{value.truncated?" · excerpt":""}</span><p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-rp-ink">{pieces}</p></div>;
}
export function SearchSpanHits({items,open}:{items:SearchSpanHit[];open:(hit:SearchSpanHit)=>void}) {
  return <div className="min-w-0 space-y-1.5">{items.map(hit=><article data-span-hit={`${hit.runId}:${hit.spanId}`} key={`${hit.runId}:${hit.spanId}`} className="min-w-0 rounded-lg border border-rp-line bg-white px-3 py-3 text-rp-ink"><button type="button" onClick={()=>open(hit)} className="rp-ease min-h-8 max-w-full break-words text-left font-mono text-[12px] font-medium text-rp-blue hover:text-rp-blue-hover hover:underline hover:underline-offset-4">{hit.name}</button><Snippet label="Input" value={hit.input}/><Snippet label="Output" value={hit.output}/></article>)}</div>;
}
