import type { SearchSpanHit, SearchSnippet } from "../../../src/search-protocol";
import { C } from "../utils/colors";
function Snippet({label,value}:{label:string;value:SearchSnippet}) {
  if(value.state==="unavailable")return <p className="text-[11px]" style={{color:C.fg1}}>{label} unavailable: missing, too large, or rejected during redaction.</p>;
  const pieces=[];let from=0;
  for(const [index,range] of value.highlights.entries()){pieces.push(value.text.slice(from,range.start));pieces.push(<mark key={index} style={{background:C.selected,color:C.fg4}}>{value.text.slice(range.start,range.end)}</mark>);from=range.end;}
  pieces.push(value.text.slice(from));
  return <div className="mt-2"><span className="text-[10px]" style={{color:C.fg1}}>{label}{value.truncated?" · excerpt":""}</span><p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5">{pieces}</p></div>;
}
export function SearchSpanHits({items,open}:{items:SearchSpanHit[];open:(hit:SearchSpanHit)=>void}) {
  return <div className="min-w-0">{items.map(hit=><article data-span-hit={`${hit.runId}:${hit.spanId}`} key={`${hit.runId}:${hit.spanId}`} className="min-w-0 border-b py-3" style={{borderColor:C.border,color:C.fg3}}><button type="button" onClick={()=>open(hit)} className="min-h-8 max-w-full break-words text-left text-[12px] font-medium underline underline-offset-4">{hit.name}</button><Snippet label="Input" value={hit.input}/><Snippet label="Output" value={hit.output}/></article>)}</div>;
}
