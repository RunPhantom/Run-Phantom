import { expect, test } from "bun:test";
import { canonicalSearchQuery, safeSearchHistory, readSearchHistory, saveSearchHistory, teamSearchScope } from "../app/src/utils/search-state";
const memory=()=>{const data=new Map<string,string>();return {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};};
test("recent queries preserve literal canonical meaning and skip complete known secrets",()=>{
  const query=new URLSearchParams({q:"literal%_ 東京 ' OR 1=1 --",filter:JSON.stringify({version:1,all:[{field:"tag",op:"eq",value:"東京%_"},{field:"captured_cost_usd",op:"eq",value:0}]})}).toString();
  const canonical=canonicalSearchQuery(query);expect(new URLSearchParams(canonical).get("q")).toBe("literal%_ 東京 ' OR 1=1 --");expect(safeSearchHistory(canonical)).toBe(true);
  for(const secret of ["sk-proj-"+"Q7".repeat(35),"Bearer synthetic-token-123456","password=synthetic-password","rp_team_session_"+"Q7".repeat(20),"https://user:synthetic-password@example.test/reset/token-1234567890"]) {
    expect(safeSearchHistory(new URLSearchParams({q:secret}).toString())).toBe(false);
    expect(safeSearchHistory(new URLSearchParams({filter:JSON.stringify({version:1,all:[{field:"model",op:"eq",value:secret}]})}).toString())).toBe(false);
    expect(safeSearchHistory(new URLSearchParams({filter:JSON.stringify({version:1,all:[{field:"tag",op:"eq",value:secret}]})}).toString())).toBe(false);
  }
});
test("recent storage is capped, private scope separated and rejects malformed persisted records",()=>{
  const storage=memory(), a="runphantom:search:local:"+"a".repeat(64), b="runphantom:search:local:"+"b".repeat(64);
  for(let i=0;i<20;i++)saveSearchHistory(storage,a,"q="+i);
  expect(readSearchHistory(storage,a)).toHaveLength(10);expect(readSearchHistory(storage,b)).toEqual([]);
  saveSearchHistory(storage,a,new URLSearchParams({q:"sk-proj-"+"Q7".repeat(35)}).toString());expect(readSearchHistory(storage,a)).toHaveLength(10);
  storage.setItem(a,JSON.stringify(["q=valid","q=%00"]));expect(readSearchHistory(storage,a)).toEqual([]);
  storage.setItem(a,"x".repeat(16_385));expect(readSearchHistory(storage,a)).toEqual([]);
});
test("Team recent scopes bind noncredential session project and resource without exposing identifiers",async()=>{
  const a=await teamSearchScope("noncredential-session-id","project-A","runs");
  expect(a).toMatch(/^[a-f0-9]{64}$/);expect(a).not.toContain("project-A");
  expect(a).not.toBe(await teamSearchScope("noncredential-session-id","project-B","runs"));
  expect(a).not.toBe(await teamSearchScope("replaced-session","project-A","runs"));
  expect(a).not.toBe(await teamSearchScope("noncredential-session-id","project-A","span-hits"));
});
