import type { SearchFilter, SearchFilterClause, SearchFilterField } from "../../../src/search-protocol";
import { parseJsonEvidence } from "../../../src/evaluations/json-evidence";
import { hasDuplicateJsonKeys } from "../../../src/json-keys";
import { redactText } from "../../../src/verification/serialization";
import { defaultIsSensitiveKey, redactUrl } from "../../../src/verification/redaction";

export const FILTER_FIELDS: Array<{value:SearchFilterField;label:string}> = [
  {value:"status",label:"Status"},{value:"model",label:"Model"},{value:"provider",label:"Provider"},
  {value:"duration_ms",label:"Duration (ms)"},{value:"captured_cost_usd",label:"Captured cost (USD)"},{value:"tag",label:"Tag"},
];
export const FILTER_OPERATORS = {eq:"equals",ne:"is not",lt:"less than",lte:"at most",gt:"greater than",gte:"at least"} as const;
const bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
const invalid=():never=>{throw new Error("Typed filters contain an invalid field, operator or value");};
const closed=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join(",")===keys.sort().join(",");
export function numericFilter(field:SearchFilterField):boolean{return field==="duration_ms"||field==="captured_cost_usd";}
// Browser wire validation only; SQL/compiler modules never enter the UI bundle.
export function uiSearchFilter(encoded:string):SearchFilter {
  if(!encoded)return {version:1,all:[]};
  if(bytes(encoded)>8192||hasDuplicateJsonKeys(encoded))return invalid();
  let value:unknown;try{value=parseJsonEvidence(encoded);}catch{return invalid();}
  if(!closed(value,["version","all"])||value.version!==1||!Array.isArray(value.all)||value.all.length>12)return invalid();
  const all:SearchFilterClause[]=value.all.map((clause:unknown)=>{
    if(!closed(clause,["field","op","value"])||!FILTER_FIELDS.some(f=>f.value===clause.field))return invalid();
    const field=clause.field as SearchFilterField, op=clause.op as SearchFilterClause["op"];
    if(!(numericFilter(field)?["eq","ne","lt","lte","gt","gte"]:["eq","ne"]).includes(op))return invalid();
    if(numericFilter(field)) {if(typeof clause.value!=="number"||!Number.isFinite(clause.value)||clause.value<0||clause.value>Number.MAX_SAFE_INTEGER)return invalid();}
    else if(typeof clause.value!=="string"||!clause.value||clause.value.length>256||bytes(clause.value)>512||Array.from(clause.value).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)||field==="status"&&!["running","completed","failed"].includes(clause.value))return invalid();
    return {field,op,value:clause.value as string|number};
  });
  all.sort((a,b)=>FILTER_FIELDS.findIndex(f=>f.value===a.field)-FILTER_FIELDS.findIndex(f=>f.value===b.field)||(JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0));
  return {version:1,all:all.filter((clause,index)=>index===0||JSON.stringify(clause)!==JSON.stringify(all[index-1]))};
}
export function canonicalSearchQuery(encoded:string):string {
  const input=new URLSearchParams(encoded), out=new URLSearchParams(), seen=new Set<string>();
  for(const [key,value] of input) {
    if(!["q","status","model","provider","filter","resource"].includes(key)||seen.has(key))return invalid();seen.add(key);
    if(key==="filter") {const filter=uiSearchFilter(value);if(filter.all.length)out.set(key,JSON.stringify(filter));}
    else {
      if(value.length>256||bytes(value)>1024||Array.from(value).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))return invalid();
      if(key==="status"&&value&&!["all","running","completed","failed"].includes(value)||key==="resource"&&value&&!["runs","span-hits"].includes(value))return invalid();
      if(value&&!(key==="status"&&value==="all")&&!(key==="resource"&&value==="runs"))out.set(key,value);
    }
  }
  out.sort();return out.toString();
}
export function safeSearchHistory(encoded:string):boolean {
  try {
    const query=new URLSearchParams(canonicalSearchQuery(encoded)), values=[query.get("q")??"",query.get("model")??"",query.get("provider")??"",...uiSearchFilter(query.get("filter")??"").all.flatMap(c=>typeof c.value==="string"?[c.value]:[])];
    return values.every(value=>{
      if(redactText(value)!==value||/rp_team_(?:session|setup|invite|ingest)_[A-Za-z0-9_-]{16,}|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/i.test(value))return false;
      for(const match of value.matchAll(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi))if(redactUrl(match[0],defaultIsSensitiveKey)!==match[0])return false;
      for(const match of value.matchAll(/\b([A-Za-z][A-Za-z0-9_.-]{0,127})["']?\s*[:=]/g))if(defaultIsSensitiveKey(match[1]))return false;
      return true;
    });
  } catch{return false;}
}
type HistoryStorage=Pick<Storage,"getItem"|"setItem"|"removeItem">;
export function readSearchHistory(storage:HistoryStorage,key:string):string[] {
  try {const raw=storage.getItem(key);if(!raw)return [];if(bytes(raw)>16_384)throw new Error();const values:unknown=JSON.parse(raw);if(!Array.isArray(values)||values.length>10||!values.every(v=>typeof v==="string"&&safeSearchHistory(v)&&canonicalSearchQuery(v)===v))throw new Error();return values as string[];}
  catch {storage.removeItem(key);return [];}
}
export function saveSearchHistory(storage:HistoryStorage,key:string,query:string):string[] {
  if(!safeSearchHistory(query))return readSearchHistory(storage,key);
  const canonical=canonicalSearchQuery(query);if(!canonical)return readSearchHistory(storage,key);
  const values=[canonical,...readSearchHistory(storage,key).filter(v=>v!==canonical)].slice(0,10);
  while(bytes(JSON.stringify(values))>16_384)values.pop();
  storage.setItem(key,JSON.stringify(values));return values;
}
export async function teamSearchScope(sessionId:string,projectId:string,resource:string):Promise<string> {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(["team",sessionId,projectId,resource])));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
}
let sessionGeneration=0;
export function discardTeamSearchHistory(projectId?:string):void {
  sessionGeneration++;
  // Scopes are opaque; project denial clears current-session histories conservatively.
  for(const key of Object.keys(sessionStorage))if(key.startsWith("runphantom:search:team:"))sessionStorage.removeItem(key);
  window.dispatchEvent(new CustomEvent("runphantom:search-denied",{detail:{projectId}}));
}
export async function synchronizeTeamSearchSession(sessionId:string):Promise<void> {
  const generation=++sessionGeneration, marker=await teamSearchScope(sessionId,"","principal");
  if(generation!==sessionGeneration)return;
  const key="runphantom:search:team:principal", previous=sessionStorage.getItem(key);
  if(previous&&previous!==marker)discardTeamSearchHistory();
  sessionStorage.setItem(key,marker);
}
