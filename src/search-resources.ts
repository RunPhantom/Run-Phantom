import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { resolve as resolvePath } from "node:path";
import { acquireSearchCapacity } from "./search-capacity";
import { capturedTagsSql, compileSearchFilter, parseSearchFilter, type SearchFilter } from "./search-filter";
import { hasDuplicateJsonKeys } from "./json-keys";
import { redactTeamText } from "./team/ingest";
import { TEAM_LIMITS as L } from "./team/protocol";
import { searchResourceWorker, type RawSearchHit, type RawSearchResource, type SearchResourceWork } from "./search-resource-worker";
import type { SearchSnippet, SearchSpanHit, SearchHitPage, SearchSuggestionResult } from "./search-protocol";
export type { SearchSnippet, SearchSpanHit, SearchHitPage, SearchSuggestionResult } from "./search-protocol";
export interface SearchResourceOptions { dbPath: string; projectId?: string; signal?: AbortSignal }
export class SearchResourceError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code === "invalid_search" ? "Search parameters or cursor are invalid" : code === "too_large" ? "Search evidence exceeds its byte limit" : code === "search_busy" ? "Search is busy; retry shortly" : code === "cancelled" ? "Search cancelled" : code === "query_timeout" ? "Search deadline exceeded; narrow the query" : "Search could not complete"); }
}
const invalid = (): never => { throw new SearchResourceError("invalid_search", 400); };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function databasePath(value: unknown): string { return typeof value === "string" && value ? resolvePath(value) : invalid(); }
export function localSearchScope(resource: "runs" | "span-hits", dbPath: string): string { return hash(["local", databasePath(dbPath), resource]); }
function inputRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !keys.includes(key))) return invalid();
  return input;
}
function text(value: unknown, maxChars = 256, maxBytes = 512): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > maxChars || Buffer.byteLength(value) > maxBytes || Array.from(value).some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127)) return invalid();
  return value;
}
function limit(value: unknown, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if ((typeof value !== "string" && typeof value !== "number") || value === "" || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > max) return invalid();
  return Number(value);
}
function typedFilter(input: Record<string, unknown>): SearchFilter {
  try {
    const all = parseSearchFilter(input.filter).all;
    for (const field of ["model", "provider", "status"] as const) {
      const value = text(input[field]);
      if (value && !(field === "status" && value === "all")) all.push({ field, op: "eq", value });
    }
    return parseSearchFilter({ version: 1, all });
  } catch { return invalid(); }
}
function cursorAnchor(value: unknown, key: string): [number | null, string, string] | undefined {
  const encoded = text(value, 4096, 4096);
  if (!encoded) return;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return invalid();
    const raw = Buffer.from(encoded,"base64url").toString("utf8");
    if (Buffer.from(raw).toString("base64url") !== encoded || hasDuplicateJsonKeys(raw)) return invalid();
    const c = JSON.parse(raw) as { v: unknown; k: unknown; a: unknown };
    if (!c || Object.keys(c).sort().join(",") !== "a,k,v" || c.v !== 1 || c.k !== key || !Array.isArray(c.a) || c.a.length !== 3) return invalid();
    const [time, run, span] = c.a as unknown[];
    if (time !== null && (typeof time !== "number" || !Number.isFinite(time))) return invalid();
    if (!text(run,1024,1024) || !text(span,1024,1024)) return invalid();
    return [time as number | null, run as string, span as string];
  } catch { return invalid(); }
}
const asciiLower = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase());
function snippet(raw: string | null, q: string, maxChars = 512): SearchSnippet {
  if (raw === null) return { state: "unavailable", text: "", highlights: [], truncated: false };
  // Whole-field admission already occurred in SQL. Scrub before ANY cutting.
  const clean = redactTeamText(raw);
  if (clean === "[UNAVAILABLE]" || clean === "[TRUNCATED]" || clean === "[UNSERIALIZABLE]") return { state: "unavailable", text: "", highlights: [], truncated: false };
  const folded = asciiLower(clean), needle = asciiLower(q);
  const match = needle ? folded.indexOf(needle) : -1;
  let start = Math.max(0, match - 96), end = Math.min(clean.length, start + maxChars - 2);
  if (start && /[\uDC00-\uDFFF]/.test(clean[start]) && /[\uD800-\uDBFF]/.test(clean[start-1])) start--;
  end = Math.min(clean.length, start + maxChars - 2);
  if (end < clean.length && /[\uD800-\uDBFF]/.test(clean[end-1]) && /[\uDC00-\uDFFF]/.test(clean[end])) end--;
  const out = (start ? "…" : "") + clean.slice(start,end) + (end < clean.length ? "…" : "");
  const highlights: SearchSnippet["highlights"] = [];
  const lower = asciiLower(out);
  if (needle) for (let from=0; highlights.length<16;) {
    const at=lower.indexOf(needle,from); if(at<0) break;
    highlights.push({start:at,end:at+needle.length}); from=at+needle.length;
  }
  return { state: "available", text: out, highlights, truncated: start>0 || end<clean.length };
}
function sanitizeHit(row: RawSearchHit, q: string): SearchSpanHit {
  const name = snippet(row.name,"",128).text || "Captured span";
  for (let cap=512;cap>=32;cap=Math.floor(cap/2)) {
    const result = {runId:row.runId,spanId:row.spanId,name,input:snippet(row.input,q,cap),output:snippet(row.output,q,cap)};
    if (Buffer.byteLength(JSON.stringify(result))<=4096) return result;
  }
  throw new SearchResourceError("too_large",413);
}
async function execute(work: Omit<SearchResourceWork,"deadline"|"cancellation">, options: SearchResourceOptions): Promise<RawSearchResource> {
  if(options.signal?.aborted) throw new SearchResourceError("cancelled",499);
  const release=acquireSearchCapacity(options.projectId ? "team" : "local",2);
  if(!release) throw new SearchResourceError("search_busy",503);
  const cancellation=new SharedArrayBuffer(4);
  let worker: Worker;
  try { worker=new Worker(`(${searchResourceWorker.toString()})()`,{eval:true,workerData:{...work,cancellation,deadline:Date.now()+5000}}); }
  catch { release(); throw new SearchResourceError("internal_error",500); }
  return new Promise((resolve,reject)=>{
    let settled=false, result: RawSearchResource | undefined, error: SearchResourceError | undefined;
    const settle=(failure?:SearchResourceError)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener("abort",abort);if(failure)reject(failure);else resolve(result!);};
    const abort=()=>{Atomics.store(new Int32Array(cancellation),0,1);settle(new SearchResourceError("cancelled",499));};
    const timer=setTimeout(()=>{Atomics.store(new Int32Array(cancellation),0,1);settle(new SearchResourceError("query_timeout",504));},5000);
    options.signal?.addEventListener("abort",abort,{once:true});
    worker.once("message",(message:{ok:boolean;result?:RawSearchResource;code?:string})=>{if(message.ok)result=message.result;else error=new SearchResourceError(message.code??"internal_error",message.code==="too_large"?413:message.code==="quota_exceeded"?422:message.code==="query_timeout"?504:500);});
    worker.once("error",()=>{error=new SearchResourceError("internal_error",500);});
    worker.once("exit",()=>{release();settle(error??(result?undefined:new SearchResourceError("internal_error",500)));});
    if(options.signal?.aborted)abort();
  });
}
function project(options: SearchResourceOptions): SearchResourceWork["project"] {
  return options.projectId ? {id:options.projectId,bytes:L.PROJECT_BYTES,runs:L.PROJECT_RUNS,spans:L.PROJECT_SPANS} : undefined;
}
/** Explicit span evidence resource. Existing run summaries remain payload-free. */
export async function searchSpanHits(value: unknown, options: SearchResourceOptions): Promise<SearchHitPage> {
  const input=inputRecord(value,["q","model","provider","status","filter","limit","cursor","from","to"]);
  const q=text(input.q), filter=typedFilter(input), pageSize=limit(input.limit,50,50), dbPath=databasePath(options.dbPath), scope=options.projectId?"team":"local";
  const window: Record<string,number> = {};
  for(const field of ["from","to"] as const) if(input[field]!==undefined) { if(!Number.isSafeInteger(Number(input[field])) || Number(input[field])<0 || input[field]==="") return invalid(); window[field]=Number(input[field]); }
  if(window.from!==undefined && window.to!==undefined && window.from>=window.to) return invalid();
  const key=hash([dbPath,options.projectId??null,"span-hits",q,filter,window]), anchor=cursorAnchor(input.cursor,key);
  const compiled=compileSearchFilter(filter,scope,true), params:(string|number)[]=[], where=[compiled.sql];
  const join=`s.run_id=r.id${options.projectId?" AND s.project_id=r.project_id":""}`;
  if(options.projectId) {where.push("r.project_id=?");params.push(options.projectId);}
  // Keep parameter order identical to the fixed WHERE ordering.
  params.unshift(...compiled.params);
  const payload=(field:"input"|"output")=>scope==="local"?`s.${field}_payload`:`json_extract(s.data,'$.${field}Payload')`;
  if(q) {where.push(`(${["s.name",payload("input"),payload("output")].map(column=>`instr(lower(${column}),lower(?))>0`).join(" OR ")})`);params.push(q,q,q);}
  for(const field of ["from","to"] as const) if(window[field]!==undefined) {where.push(`r.started_at${field==="from"?">=":"<"}?`);params.push(window[field]);}
  if(anchor) {
    const [time,run,span]=anchor;
    const tail="(r.id<? OR (r.id=? AND s.id<?))";
    if(time===null) {where.push(`r.started_at IS NULL AND ${tail}`);params.push(run,run,span);}
    else {where.push(`(r.started_at<? OR r.started_at IS NULL OR (r.started_at=? AND ${tail}))`);params.push(time,time,run,run,span);}
  }
  const admit=(column:string)=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=8192 THEN ${column} ELSE NULL END`;
  const sql=`SELECT r.id AS runId,s.id AS spanId,r.started_at AS startedAt,${admit("s.name")} AS name,${admit(payload("input"))} AS input,${admit(payload("output"))} AS output FROM runs r JOIN spans s ON ${join} WHERE ${where.join(" AND ")} ORDER BY r.started_at DESC,r.id DESC,s.id DESC LIMIT ?`;
  params.push(pageSize+1);
  const started=Date.now(), raw=await execute({dbPath,sql,params,limit:pageSize,mode:"hits",key,project:project(options)},options);
  if(options.signal?.aborted) throw new SearchResourceError("cancelled",499);
  const result={items:raw.items.map(row=>sanitizeHit(row,q)),hasMore:raw.hasMore,nextCursor:raw.nextCursor,elapsedMs:Date.now()-started};
  if(Buffer.byteLength(JSON.stringify(result))>120_000) throw new SearchResourceError("too_large",413);
  return result;
}
export async function searchSuggestions(value: unknown, options: SearchResourceOptions): Promise<SearchSuggestionResult> {
  const input=inputRecord(value,["field","prefix","limit"]), field=text(input.field), prefix=text(input.prefix), count=limit(input.limit,20,20);
  if(!["model","provider","tag"].includes(field)) return invalid();
  const scope=options.projectId?"team":"local", params:(string|number)[]=[], where:string[]=[];
  if(options.projectId) {where.push("s.project_id=?");params.push(options.projectId);}
  const source=field==="tag"?`spans s JOIN json_each(${capturedTagsSql(scope)}) tag` : "spans s";
  const column=field==="tag"?"tag.value":`s.${field}`;
  where.push(`typeof(${column})='text'`,`${column}<>''`,`length(CAST(${column} AS BLOB))<=512`,`instr(lower(${column}),lower(?))=1`);params.push(prefix,count+1);
  const sql=`SELECT DISTINCT ${column} AS value FROM ${source} WHERE ${where.join(" AND ")} ORDER BY value LIMIT ?`;
  const raw=await execute({dbPath:databasePath(options.dbPath),sql,params,limit:count,mode:"suggestions",key:"",project:project(options)},options);
  if(options.signal?.aborted) throw new SearchResourceError("cancelled",499);
  return {values:raw.values.filter(value=>value.length<=256 && !Array.from(value).some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127) && redactTeamText(value)===value),hasMore:raw.hasMore};
}
