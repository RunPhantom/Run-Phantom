import { useEffect, useId, useRef, useState } from "react";
import type { SearchFilterField } from "../../../src/search-protocol";
import { C } from "../utils/colors";
import { canonicalSearchQuery, FILTER_FIELDS, FILTER_OPERATORS, numericFilter, readSearchHistory, safeSearchHistory, saveSearchHistory, uiSearchFilter } from "../utils/search-state";

interface Props {
  query: string; onChange: (value:URLSearchParams)=>void; scopeKey: string; team?:boolean;
  suggestions: (field:"model"|"provider"|"tag",prefix:string,signal:AbortSignal)=>Promise<{values:string[]}>;
}
export function SearchFilters({query,onChange,scopeKey,team=false,suggestions}:Props) {
  const [open,setOpen]=useState(false), [field,setField]=useState<SearchFilterField>("model"), [operator,setOperator]=useState<keyof typeof FILTER_OPERATORS>("eq"), [value,setValue]=useState("");
  const [error,setError]=useState(""), [values,setValues]=useState<{key:string;values:string[]}>({key:"",values:[]}), [recent,setRecent]=useState<string[]>([]);
  const [journal,setJournal]=useState<{past:string[];future:string[]}>({past:[],future:[]});
  const [loadedScope,setLoadedScope]=useState("");
  const scopeStamp=JSON.stringify([scopeKey,team]), suggestionStamp=JSON.stringify([scopeKey,team,field,value,open]);
  const ready=!!scopeKey&&loadedScope===scopeStamp;
  const visibleValues=values.key===suggestionStamp?values.values:[];
  const visibleRecent=ready?recent:[];
  const last=useRef(query), skip=useRef<string|null>(null), generation=useRef(0), id=useId();
  const controller=useRef<AbortController|null>(null);
  let filter;try {filter=uiSearchFilter(new URLSearchParams(query).get("filter")??"");}catch {filter=null;}
  const storage=()=>team?sessionStorage:localStorage;
  useEffect(()=>{
    if(query===last.current)return;
    if(skip.current===query)skip.current=null;
    else if(safeSearchHistory(last.current))setJournal(previous=>({past:[...previous.past,last.current].slice(-20),future:[]}));
    last.current=query;
  },[query]);
  useEffect(()=>{
    setLoadedScope(scopeStamp);setJournal({past:[],future:[]});setValues({key:"",values:[]});setRecent([]);last.current=query;
    if(scopeKey)try{setRecent(readSearchHistory(team?sessionStorage:localStorage,scopeKey));}catch{setError("Recent searches are unavailable in this browser.");}
    // History belongs to one opaque profile/session/project/resource, not this component's route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scopeKey,team,scopeStamp]);
  useEffect(()=>{
    const denied=()=>{generation.current++;controller.current?.abort();setValues({key:"",values:[]});setRecent([]);setJournal({past:[],future:[]});};
    if(team)window.addEventListener("runphantom:search-denied",denied);
    return ()=>{if(team)window.removeEventListener("runphantom:search-denied",denied);};
  },[team]);
  useEffect(()=>{
    const current=++generation.current, abort=new AbortController();controller.current=abort;setValues({key:"",values:[]});
    if(!open||!scopeKey||!["model","provider","tag"].includes(field))return ()=>abort.abort();
    const timer=window.setTimeout(()=>{
      void suggestions(field as "model"|"provider"|"tag",value,abort.signal).then(result=>{if(current===generation.current&&!abort.signal.aborted)setValues({key:suggestionStamp,values:result.values});},cause=>{if(current===generation.current&&!abort.signal.aborted){setValues({key:"",values:[]});setError(cause instanceof Error?cause.message:"Suggestions unavailable");}});
    },200);
    return ()=>{clearTimeout(timer);abort.abort();};
  },[field,value,open,scopeKey,suggestions,suggestionStamp]);
  const apply=(encoded:string)=>{onChange(new URLSearchParams(encoded));};
  const undo=()=>{const previous=journal.past[journal.past.length-1];if(previous===undefined)return;skip.current=previous;setJournal({past:journal.past.slice(0,-1),future:safeSearchHistory(query)?[query,...journal.future].slice(0,20):journal.future});apply(previous);};
  const redo=()=>{const next=journal.future[0];if(next===undefined)return;skip.current=next;setJournal({past:[...journal.past,query].slice(-20),future:journal.future.slice(1)});apply(next);};
  const add=()=>{
    try{
      if(!filter)throw new Error("Clear the invalid typed filter before adding another.");
      if(numericFilter(field)&&!value.trim())throw new Error("Enter a captured numeric value.");
      const typed=uiSearchFilter(JSON.stringify({version:1,all:[...filter.all,{field,op:operator,value:numericFilter(field)?Number(value):value}]}));
      const next=new URLSearchParams(query);next.set("filter",JSON.stringify(typed));onChange(next);setValue("");setError("");
    }catch(cause){setError(cause instanceof Error?cause.message:"Filter unavailable");}
  };
  const remove=(index:number)=>{if(!filter)return;const next=new URLSearchParams(query),all=filter.all.filter((_,position)=>position!==index);if(all.length)next.set("filter",JSON.stringify({version:1,all}));else next.delete("filter");onChange(next);};
  const save=()=>{if(!scopeKey||!safeSearchHistory(query))return;try{onChange(new URLSearchParams(query));setRecent(saveSearchHistory(storage(),scopeKey,query));setError("");}catch{setError("Recent searches are unavailable in this browser.");}};
  const style={background:C.surface,color:C.fg3,borderColor:C.border};
  const control="min-w-0 w-full rounded-lg border px-2 py-2 text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--rp-accent)]";
  const resource=new URLSearchParams(query).get("resource")??"runs";
  return <section aria-label="Investigation filters" className="mt-3 min-w-0 text-[11px]" style={{color:C.fg2}}>
    <label className="grid gap-1">Results<select aria-label="Search result type" className={control} style={style} value={resource} onChange={event=>{const next=new URLSearchParams(query);if(event.target.value==="runs")next.delete("resource");else next.set("resource",event.target.value);onChange(next);}}><option value="runs">Run summaries</option><option value="span-hits">Matching spans</option></select></label>
    <button type="button" aria-expanded={open} onClick={()=>setOpen(!open)} className="mt-2 min-h-8 underline underline-offset-4">Advanced filters</button>
    {open&&<div className="mt-2 grid min-w-0 gap-2" onKeyDown={event=>{if(event.key==="Enter"&&event.target instanceof HTMLInputElement){event.preventDefault();add();}}}>
      <div className="flex flex-wrap gap-1" aria-label="Active typed filters">{filter?.all.map((clause,index)=><button type="button" key={JSON.stringify(clause)} onClick={()=>remove(index)} aria-label={`Remove ${FILTER_FIELDS.find(f=>f.value===clause.field)?.label} ${FILTER_OPERATORS[clause.op]} ${clause.value}`} className="max-w-full break-words rounded border px-2 py-1.5 text-left" style={style}>{FILTER_FIELDS.find(f=>f.value===clause.field)?.label} {FILTER_OPERATORS[clause.op]} <strong>{clause.value}</strong> ×</button>)}</div>
      <div className="grid grid-cols-2 gap-2"><label className="grid gap-1">Field<select aria-label="Filter field" className={control} style={style} value={field} onChange={event=>{setField(event.target.value as SearchFilterField);setOperator("eq");setValue("");setError("");}}>{FILTER_FIELDS.map(f=><option key={f.value} value={f.value}>{f.label}</option>)}</select></label>
        <label className="grid gap-1">Condition<select aria-label="Filter operator" className={control} style={style} value={operator} onChange={event=>setOperator(event.target.value as keyof typeof FILTER_OPERATORS)}>{Object.entries(FILTER_OPERATORS).filter(([op])=>numericFilter(field)||["eq","ne"].includes(op)).map(([op,label])=><option key={op} value={op}>{label}</option>)}</select></label></div>
      <label className="grid gap-1">Value{field==="status"?<select aria-label="Filter value" className={control} style={style} value={value} onChange={event=>setValue(event.target.value)}><option value="">Choose status</option>{["running","completed","failed"].map(s=><option key={s}>{s}</option>)}</select>:<input aria-label="Filter value" list={id} className={control} style={style} value={value} maxLength={256} inputMode={numericFilter(field)?"decimal":"text"} onChange={event=>setValue(event.target.value)} placeholder={numericFilter(field)?"Captured value, including zero":"Exact captured value"}/>}</label>
      <datalist id={id}>{visibleValues.map(item=><option key={item} value={item}/>)}</datalist>
      <button type="button" onClick={add} className={`${control} disabled:opacity-50`} style={style} disabled={!value||!filter||filter.all.length>=12}>Add filter</button>
      <p className="text-[10px] leading-4">All span conditions match one captured step. Unavailable cost, duration or tags never prove zero or absence.</p>
      <div className="flex flex-wrap gap-3"><button type="button" disabled={!ready||!journal.past.length} onClick={undo} className="min-h-8 underline disabled:opacity-40">Undo filters</button><button type="button" disabled={!ready||!journal.future.length} onClick={redo} className="min-h-8 underline disabled:opacity-40">Redo filters</button><button type="button" onClick={save} disabled={!ready||!safeSearchHistory(query)} className="min-h-8 underline disabled:opacity-40">Save search</button></div>
      {!safeSearchHistory(query)&&<p>Queries containing credentials are excluded from recent searches.</p>}
      <div aria-label="Recent searches" className="grid gap-1">{visibleRecent.map(item=><button type="button" key={item} onClick={()=>apply(item)} className="min-h-8 truncate text-left underline underline-offset-4">{new URLSearchParams(item).get("q")||"Saved filters"}</button>)}</div>
      {!!visibleRecent.length&&<button type="button" onClick={()=>{try{storage().removeItem(scopeKey);}catch{}setRecent([]);}} className="min-h-8 text-left underline">Clear recent searches</button>}
    </div>}
    {(error||!filter)&&<p role="alert" className="mt-2 break-words">{error||"Typed filters are invalid. Clear all filters to continue."}</p>}
  </section>;
}
