import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcpSessionError, OpenCodeAcpSessions } from "../src/acp-sessions";
import type { AgentStreamEvent } from "../src/agent-chat";

const fixture = path.join(import.meta.dir, "fixtures", "acp-provider.ts");
function setup(mode = "positive", timeout = 1_000) {
  const cwd = mkdtempSync(path.join(realpathSync(tmpdir()), "runphantom-acp-test-"));
  const pids: number[] = [];
  const env = { PATH: process.env.PATH, RUNPHANTOM_ACP_FIXTURE_MODE: mode, RUNPHANTOM_ACP_FIXTURE_SESSION_ID: "fixture_session" };
  const service = new OpenCodeAcpSessions({ command: process.execPath, args: [fixture, mode],
    env, requestTimeoutMs: timeout, onProcess(pid) { pids.push(pid); } });
  return { cwd, service, pids, env, async dispose() { await service.close(); rmSync(cwd, { recursive: true, force: true }); } };
}
function handlers() {
  const events: AgentStreamEvent[] = [];
  const texts: string[] = [];
  const errors: string[] = [];
  let id = "";
  return { events, texts, errors, get id() { return id; }, callbacks: {
    onEvent(event: AgentStreamEvent) { events.push(event); }, onProviderSession(value: string) { id = value; },
    onText(value: string) { texts.push(value); }, onStatus() {}, onError(value: string) { errors.push(value); },
  } };
}
function reaped(pids: number[]) {
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
}
async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("Expected the native ACP operation to reject");
}
async function failure(mode: string, category: string) {
  const owned = setup(mode);
  const seen = handlers();
  try {
    expect(await rejected(owned.service.chat({ backendUrl: "http://127.0.0.1:1", content: "Fixture question", cwd: owned.cwd }, seen.callbacks))).toMatchObject({ category });
    expect(seen.events.filter((event) => event.type === "done")).toHaveLength(0);
    expect(JSON.stringify(seen)).not.toContain("synthetic-private");
    reaped(owned.pids);
  } finally { await owned.dispose(); }
}

describe("bounded ACP native process sessions", () => {
  test("real fixture streams typed updates and rejects permission without granting client capabilities", async () => {
    const owned = setup(); const seen = handlers();
    try {
      expect(await owned.service.chat({ backendUrl: "http://127.0.0.1:1", content: "Fixture question", cwd: owned.cwd }, seen.callbacks)).toEqual({ code: 0, signal: null, stderr: "" });
      expect(seen.id).toBe("fixture_session"); expect(seen.texts.at(-1)).toBe("Permission denied. Fixture answer ✓");
      expect(seen.events).toContainEqual({ type: "permission_denied", tool: "Read fixture", reason: "ACP permissions are denied in Run Phantom." });
      expect(seen.events).toContainEqual({ type: "tool_start", id: "tool1", name: "Read fixture" });
      expect(seen.events).toContainEqual({ type: "tool_finish", id: "tool1", ok: false });
      expect(seen.events).toContainEqual({ type: "thinking_delta", content: "Fixture thought" });
      expect(seen.events.at(-1)).toEqual({ type: "done" });
      expect(owned.service.list(owned.cwd)).toHaveLength(1);
      expect(owned.service.get(owned.cwd, seen.id)?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      reaped(owned.pids);
    } finally { await owned.dispose(); }
  });
  test("native loadSession replay is validated without duplicating current-turn text or own history", async () => {
    const owned = setup(); const first = handlers(); const second = handlers();
    try {
      await owned.service.chat({ backendUrl: "http://127.0.0.1:1", content: "First", cwd: owned.cwd }, first.callbacks);
      await owned.service.chat({ backendUrl: "http://127.0.0.1:1", content: "Second", cwd: owned.cwd, resumeSessionId: first.id }, second.callbacks);
      expect(second.texts.at(-1)).toBe("Permission denied. Fixture answer ✓");
      expect(JSON.stringify(second)).not.toContain("Old response");
      expect(owned.service.get(owned.cwd, first.id)?.messages).toHaveLength(4);
      reaped(owned.pids);
    } finally { await owned.dispose(); }
  });
  test("initialize is available with authentication unknown; login metadata grants nothing", async () => {
    const owned = setup();
    try { expect(await owned.service.availability(owned.cwd)).toEqual({ available: true, authentication: "unknown", protocolVersion: 1, version: "fixture-1", sessions: "runphantom_current_daemon" }); reaped(owned.pids); }
    finally { await owned.dispose(); }
  });
  test("permission with only allow options is cancelled rather than selecting an allow", async () => {
    const owned = setup("allow_only"); const seen = handlers();
    try {
      expect((await owned.service.chat({ backendUrl: "http://127.0.0.1:1", content: "Q", cwd: owned.cwd }, seen.callbacks)).code).toBe(0);
      expect(seen.texts.at(-1)).toBe("Permission denied. Fixture answer ✓");
      reaped(owned.pids);
    } finally { await owned.dispose(); }
  });
  for (const [mode, category] of [
    ["wrong_version", "unsupported_protocol"], ["auth", "authentication_required"], ["duplicate", "protocol_error"],
    ["malformed", "protocol_error"], ["utf8", "protocol_error"], ["oversize", "limit"], ["foreign", "protocol_error"],
    ["unknown", "protocol_error"], ["same_chunk_fault", "protocol_error"], ["response_limit", "limit"], ["stderr", "unavailable"], ["exit", "unavailable"], ["hold_initialize", "timeout"],
    ["lossy", "protocol_error"], ["wrong_response", "protocol_error"], ["terminal_stop", "limit"], ["repeat_permission", "limit"], ["many_frames", "limit"],
  ]) test(`refuses ${mode} and reaps its native fixture`, () => failure(mode, category));
  test("abort after partial text fences late output, sends native cancel and reaps owned process", async () => {
    const owned = setup("hold_prompt", 3_000); const seen = handlers(); const abort = new AbortController();
    try {
      const pending = owned.service.chat({ backendUrl: "http://127.0.0.1:1", content: "Question", cwd: owned.cwd, abortSignal: abort.signal }, { ...seen.callbacks, onText(value) { seen.texts.push(value); abort.abort(); } });
      expect(await rejected(pending)).toMatchObject({ category: "cancelled" });
      expect(seen.texts).toEqual(["Partial answer"]); expect(seen.events.some((event) => event.type === "done")).toBe(false);
      reaped(owned.pids);
    } finally { await owned.dispose(); }
  });
  test("global process cap refuses a third probe and cancellation frees both owned slots", async () => {
    const first = setup("hold_initialize", 2_000); const second = setup("hold_initialize", 2_000); const third = setup();
    try {
      const firstPending = first.service.availability(first.cwd); const secondPending = second.service.availability(second.cwd);
      expect(await third.service.availability(third.cwd)).toMatchObject({ available: false, reason: "busy" });
      const started = performance.now();
      await Promise.all([first.service.close(), second.service.close()]);
      await Promise.all([firstPending, secondPending]);
      expect(performance.now() - started).toBeLessThan(1_500);
      reaped([...first.pids, ...second.pids]);
      expect(await third.service.availability(third.cwd)).toMatchObject({ available: true });
    } finally { await first.dispose(); await second.dispose(); await third.dispose(); }
  });
  test("pre-aborted or oversized input never launches native process", async () => {
    const owned = setup(); const abort = new AbortController(); abort.abort();
    try {
      expect(await rejected(owned.service.chat({ backendUrl: "http://127.0.0.1:1", content: "Q", cwd: owned.cwd, abortSignal: abort.signal }, handlers().callbacks))).toBeInstanceOf(AcpSessionError);
      expect(await rejected(owned.service.chat({ backendUrl: "http://127.0.0.1:1", content: "Q".repeat(16_385), cwd: owned.cwd }, handlers().callbacks))).toMatchObject({ category: "limit" });
      expect(owned.pids).toHaveLength(0);
    } finally { await owned.dispose(); }
  });
  test("client filesystem requests receive method unavailable without any file authority", async () => {
    const owned=setup("client_fs");const seen=handlers();
    try { expect((await owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"Q",cwd:owned.cwd},seen.callbacks)).code).toBe(0);reaped(owned.pids); }
    finally { await owned.dispose(); }
  });
  test("unsupported update type is retained as incomplete metadata, with no raw unknown content", async () => {
    const owned=setup("unknown");const seen=handlers();
    try {
      expect(await rejected(owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"Q",cwd:owned.cwd},seen.callbacks))).toMatchObject({category:"protocol_error",unknownUpdate:"future_unsupported_update"});
      const detail=owned.service.get(owned.cwd,seen.id);
      expect(detail?.capture).toEqual({status:"incomplete",reason:"protocol_error",unknownUpdate:"future_unsupported_update"});
      expect(JSON.stringify(detail)).not.toContain("arbitrary");reaped(owned.pids);
    } finally { await owned.dispose(); }
  });
  test("same native session cannot accept a concurrent turn and explicit cancellation frees it", async () => {
    const owned=setup();const first=handlers();const second=handlers();
    try {
      await owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"First",cwd:owned.cwd},first.callbacks);
      owned.env.RUNPHANTOM_ACP_FIXTURE_MODE="hold_prompt";
      let observed!:()=>void;const started=new Promise<void>(resolve=>{observed=resolve;});
      const pending=owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"Second",cwd:owned.cwd,resumeSessionId:first.id},{...second.callbacks,onText(value){second.texts.push(value);observed();}});
      await started;
      expect(await rejected(owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"Concurrent",cwd:owned.cwd,resumeSessionId:first.id},handlers().callbacks))).toMatchObject({category:"busy"});
      expect(owned.service.cancel(owned.cwd,first.id)).toBe(true);
      expect(await rejected(pending)).toMatchObject({category:"cancelled"});
      expect(owned.service.cancel(owned.cwd,first.id)).toBe(false);reaped(owned.pids);
      expect(owned.service.get(owned.cwd,first.id)?.capture).toMatchObject({status:"incomplete",reason:"cancelled"});
    } finally {await owned.dispose();}
  });
  test("session records and detached copies stay inside their canonical workspace", async () => {
    const owned=setup();const foreign=setup();const seen=handlers();
    try {
      await owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"Q",cwd:owned.cwd},seen.callbacks);
      expect(owned.service.get(foreign.cwd,seen.id)).toBeNull();expect(owned.service.list(foreign.cwd)).toEqual([]);
      const copy=owned.service.get(owned.cwd,seen.id)!;copy.messages[0].content="Changed detached copy";
      expect(owned.service.get(owned.cwd,seen.id)?.messages[0].content).toBe("Q");
      reaped(owned.pids);
    } finally {await owned.dispose();await foreign.dispose();}
  });
  test("unsupported native load and failed setup do not claim an unsent prompt in history", async () => {
    const owned=setup();const seen=handlers();
    try {
      await owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"First",cwd:owned.cwd},seen.callbacks);
      const before=owned.service.get(owned.cwd,seen.id);
      owned.env.RUNPHANTOM_ACP_FIXTURE_MODE="no_load";
      expect(await rejected(owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"Never sent",cwd:owned.cwd,resumeSessionId:seen.id},handlers().callbacks))).toMatchObject({category:"unsupported_protocol"});
      expect(owned.service.get(owned.cwd,seen.id)).toEqual(before);reaped(owned.pids);
    } finally {await owned.dispose();}
  });
  test("closed owner permanently refuses new work after joining in-flight probes", async () => {
    const owned=setup("hold_initialize",3_000);
    try {
      const pending=owned.service.availability(owned.cwd);
      await owned.service.close();await pending;reaped(owned.pids);
      const count=owned.pids.length;
      expect(await owned.service.availability(owned.cwd)).toMatchObject({available:false,reason:"unavailable"});
      expect(await rejected(owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"Q",cwd:owned.cwd},handlers().callbacks))).toMatchObject({category:"unavailable"});
      expect(owned.pids).toHaveLength(count);
    } finally{await owned.dispose();}
  });
  test("workspace generation change cancels held native turn, joins process and marks incomplete", async () => {
    const owned=setup("hold_prompt",3_000);const seen=handlers();let current=true;
    try {
      let observed!:()=>void;const started=new Promise<void>(resolve=>{observed=resolve;});
      const pending=owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"Q",cwd:owned.cwd},{...seen.callbacks,onText(value){seen.texts.push(value);observed();}}, {isCurrent:()=>current});
      await started;current=false;
      expect(await rejected(pending)).toMatchObject({category:"scope_changed"});
      expect(seen.texts).toEqual(["Partial answer"]);reaped(owned.pids);
      expect(owned.service.get(owned.cwd,seen.id)?.capture).toMatchObject({status:"incomplete",reason:"scope_changed"});
    }finally{await owned.dispose();}
  });
  test("stale workspace before admission cannot start native work", async () => {
    const owned=setup();
    try{
      expect(await rejected(owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"Q",cwd:owned.cwd},handlers().callbacks,{isCurrent:()=>false}))).toMatchObject({category:"scope_changed"});
      expect(owned.pids).toHaveLength(0);
    }finally{await owned.dispose();}
  });
  test("drain joins held work before reopening admission in a new generation", async () => {
    const owned=setup("hold_initialize",3_000);
    try{
      const held=owned.service.availability(owned.cwd);
      await owned.service.drain();await held;reaped(owned.pids);
      owned.env.RUNPHANTOM_ACP_FIXTURE_MODE="positive";
      expect(await owned.service.availability(owned.cwd)).toMatchObject({available:true});reaped(owned.pids);
    }finally{await owned.dispose();}
  });
  test("32 actual native-created sessions fill retention and the 33rd is refused before spawn", async () => {
    const owned=setup();
    try{
      for(let index=0;index<32;index++){
        owned.env.RUNPHANTOM_ACP_FIXTURE_SESSION_ID=`fixture_${index}`;
        await owned.service.chat({backendUrl:"http://127.0.0.1:1",content:`Question ${index}`,cwd:owned.cwd},handlers().callbacks);
      }
      expect(owned.service.list(owned.cwd)).toHaveLength(32);expect(owned.pids).toHaveLength(32);
      expect(await rejected(owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"No 33rd session",cwd:owned.cwd},handlers().callbacks))).toMatchObject({category:"limit"});
      expect(owned.pids).toHaveLength(32);reaped(owned.pids);
    }finally{await owned.dispose();}
  });
  test("64 actual own transcript messages fill one session and further turns cannot spawn", async () => {
    const owned=setup();const seen=handlers();
    try{
      for(let index=0;index<32;index++)await owned.service.chat({backendUrl:"http://127.0.0.1:1",content:`Turn ${index}`,cwd:owned.cwd,resumeSessionId:index?seen.id:undefined},seen.callbacks);
      expect(owned.service.get(owned.cwd,seen.id)?.messages).toHaveLength(64);expect(owned.pids).toHaveLength(32);
      expect(await rejected(owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"Too many messages",cwd:owned.cwd,resumeSessionId:seen.id},handlers().callbacks))).toMatchObject({category:"limit"});
      expect(owned.pids).toHaveLength(32);reaped(owned.pids);
    }finally{await owned.dispose();}
  });
  test("retained content limit includes previous turns and refuses excessive prompt without native dispatch", async () => {
    const owned=setup();const seen=handlers();
    try{
      for(let index=0;index<3;index++)await owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"x".repeat(16_384),cwd:owned.cwd,resumeSessionId:index?seen.id:undefined},seen.callbacks);
      expect(owned.pids).toHaveLength(3);
      const before=owned.service.get(owned.cwd,seen.id);
      expect(await rejected(owned.service.chat({backendUrl:"http://127.0.0.1:1",content:"x".repeat(16_384),cwd:owned.cwd,resumeSessionId:seen.id},handlers().callbacks))).toMatchObject({category:"limit"});
      expect(owned.service.get(owned.cwd,seen.id)).toEqual(before);expect(owned.pids).toHaveLength(3);reaped(owned.pids);
    }finally{await owned.dispose();}
  });
});
