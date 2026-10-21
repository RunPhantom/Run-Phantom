import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { acquireClaudeTranscript, TRANSCRIPT_LIMITS, type TranscriptAcquisition } from "../src/coding-hooks/claude";
import { parseClaudeHookInput, type ClaudeHookInput } from "../src/coding-hooks/shared";
let directory: string, root: string, file: string;
const session="11111111-1111-4111-8111-111111111111";
const body='{"type":"assistant","sessionId":"'+session+'","message":{"id":"msg_fixture","content":[{"type":"text","text":"business output"}]}}\n';
function hook(path=file,event="Stop",agent?:string):ClaudeHookInput {
  const r=parseClaudeHookInput(JSON.stringify({session_id:session,hook_event_name:event,transcript_path:path,source:"startup",agent_id:agent,agent_transcript_path:event==="SubagentStop"?path:undefined}));
  if(r.status!=="accepted")throw new Error("fixture admission failed");return r.value;
}
const authority=()=>({projectsRoot:root,homeDirectory:directory,cursor:0,prefixBytes:0,expectedPrefixSha256:null,expectedIncarnationKey:null});
// Diagnose unexpected native refusals without printing source paths or transcript bytes.
async function expectAccepted(result: TranscriptAcquisition, candidate = file): Promise<void> {
  if (result.status === "accepted") { expect(result.status).toBe("accepted"); return; }
  const facts: Record<string, unknown> = { status: result.status, reason: result.reason };
  const shape = (parent: string, child: string) => {
    const value = relative(parent, child), parts = value.split(sep);
    return { boundary: !value ? "empty" : isAbsolute(value) ? "absolute" : parts[0] === ".." ? "parent" : "inside", segments: parts.length, sessionLeaf: basename(child) === `${session}.jsonl` };
  };
  try {
    const [nativeRoot, nativeCandidate, lexicalRootStat, canonicalRootStat, candidateStat] = await Promise.all([realpath(root), realpath(candidate), lstat(root, { bigint: true }), realpath(root).then(value => lstat(value, { bigint: true })), lstat(candidate, { bigint: true })]);
    facts.rootSpellingMatches = nativeRoot === root; facts.candidateSpellingMatches = nativeCandidate === candidate;
    facts.lexical = shape(nativeRoot, resolve(candidate)); facts.canonical = shape(nativeRoot, nativeCandidate);
    facts.rootIdentityMatches = lexicalRootStat.dev === canonicalRootStat.dev && lexicalRootStat.ino === canonicalRootStat.ino && lexicalRootStat.birthtimeNs === canonicalRootStat.birthtimeNs;
    facts.candidateIsRegular = candidateStat.isFile(); facts.candidateIdentityAvailable = candidateStat.ino > 0n && candidateStat.birthtimeNs > 0n;
  } catch { facts.diagnosticIO = "unavailable"; }
  throw new Error(`Expected accepted transcript acquisition; native refusal facts: ${JSON.stringify(facts)}`);
}
beforeEach(async()=>{directory=await realpath(mkdtempSync(join(tmpdir(),"runphantom-f11-transcript-")));root=join(directory,".claude","projects");mkdirSync(join(root,"fixture-project"),{recursive:true});file=join(root,"fixture-project",session+".jsonl");writeFileSync(file,body);});
afterEach(()=>rmSync(directory,{recursive:true,force:true}));
describe("trusted descriptor transcript acquisition",()=>{
  test("reads exact immutable source bytes and reports observed descriptor incarnation",async()=>{
    const r=await acquireClaudeTranscript(hook(),authority());await expectAccepted(r);if(r.status!=="accepted")return;
    expect(r.value.text).toBe(body);expect(r.value.fileBytes).toBe(Buffer.byteLength(body));expect(r.value.startOffset).toBe(0);expect(r.value.endOffset).toBe(Buffer.byteLength(body));
    expect(r.value.incarnationKey).toMatch(/^[a-f0-9]{64}$/);expect(r.value.prefixSha256).toMatch(/^[a-f0-9]{64}$/);expect(r.value.prefixBytes).toBe(Buffer.byteLength(body));expect(readFileSync(file,"utf8")).toBe(body);
    expect(Object.hasOwn(r.value,"path")).toBe(false);
  });
  test("a frozen prefix length survives ordinary append and reads only after the admitted cursor",async()=>{
    const first=await acquireClaudeTranscript(hook(),authority());await expectAccepted(first);if(first.status!=="accepted")return;
    writeFileSync(file,body+body);
    const second=await acquireClaudeTranscript(hook(),{...authority(),cursor:first.value.endOffset,prefixBytes:first.value.prefixBytes,expectedPrefixSha256:first.value.prefixSha256,expectedIncarnationKey:first.value.incarnationKey});
    await expectAccepted(second);if(second.status!=="accepted")return;
    expect(second.value.text).toBe(body);expect(second.value.incarnationKey).toBe(first.value.incarnationKey);expect(second.value.prefixSha256).toBe(first.value.prefixSha256);expect(second.value.endOffset).toBe(Buffer.byteLength(body)*2);
  });
  test("truncation and changed source prefix cannot be treated as a newer snapshot",async()=>{
    const first=await acquireClaudeTranscript(hook(),authority());await expectAccepted(first);if(first.status!=="accepted")return;
    const prior={...authority(),cursor:first.value.endOffset,prefixBytes:first.value.prefixBytes,expectedPrefixSha256:first.value.prefixSha256,expectedIncarnationKey:first.value.incarnationKey};
    writeFileSync(file,"{}\n");expect((await acquireClaudeTranscript(hook(),prior)).reason).toBe("source_changed");
    writeFileSync(file,body.replace("business output","private changed"));expect((await acquireClaudeTranscript(hook(),{...prior,cursor:0})).reason).toBe("source_changed");
  });
  test("a replaced inode is refused despite the exact same content and prefix",async()=>{
    const first=await acquireClaudeTranscript(hook(),authority());await expectAccepted(first);if(first.status!=="accepted")return;
    rmSync(file);writeFileSync(file,body);
    expect((await acquireClaudeTranscript(hook(),{...authority(),prefixBytes:first.value.prefixBytes,expectedPrefixSha256:first.value.prefixSha256,expectedIncarnationKey:first.value.incarnationKey})).reason).toBe("source_changed");
  });
  test("outside-root and wrong-session paths are refused before source interpretation",async()=>{
    const outside=join(directory,session+".jsonl");writeFileSync(outside,"private outside marker");
    expect((await acquireClaudeTranscript(hook(outside),authority())).reason).toBe("path_not_authorized");
    const wrong=join(root,"fixture-project","another-session.jsonl");writeFileSync(wrong,"private another marker");expect((await acquireClaudeTranscript(hook(wrong),authority())).reason).toBe("path_not_authorized");
    expect(readFileSync(outside,"utf8")).toBe("private outside marker");expect(readFileSync(wrong,"utf8")).toBe("private another marker");
  });
  test("final and ancestor symlinks cannot redirect acquisition",async()=>{
    const target=join(directory,"outside");mkdirSync(target);writeFileSync(join(target,session+".jsonl"),"outside secret");
    rmSync(file);symlinkSync(join(target,session+".jsonl"),file);expect((await acquireClaudeTranscript(hook(),authority())).reason).toBe("path_not_authorized");
    rmSync(join(root,"fixture-project"),{recursive:true});symlinkSync(target,join(root,"fixture-project"));expect((await acquireClaudeTranscript(hook(),authority())).reason).toBe("path_not_authorized");
  });
  test("directories, absent files, relative paths and network URLs are explicit unavailable",async()=>{
    rmSync(file);mkdirSync(file);expect((await acquireClaudeTranscript(hook(),authority())).reason).toBe("not_regular_file");
    rmSync(file,{recursive:true});expect((await acquireClaudeTranscript(hook(),authority())).reason).toBe("source_unavailable");
    expect((await acquireClaudeTranscript(hook("./relative.jsonl"),authority())).reason).toBe("path_not_authorized");expect((await acquireClaudeTranscript(hook("https://fixture.invalid/file.jsonl"),authority())).reason).toBe("path_not_authorized");
  });
  test("an oversized actual file is refused before allocating a source snapshot",async()=>{
    writeFileSync(file,Buffer.alloc(TRANSCRIPT_LIMITS.fileBytes+1,32));expect((await acquireClaudeTranscript(hook(),authority())).reason).toBe("file_limit");
  });
  test("invalid UTF8 never silently becomes replacement-character evidence",async()=>{
    writeFileSync(file,new Uint8Array([0xc3,0x28]));expect((await acquireClaudeTranscript(hook(),authority())).reason).toBe("invalid_utf8");
  });
  test("already-aborted acquisition refuses and leaves source untouched",async()=>{
    const c=new AbortController();c.abort();expect((await acquireClaudeTranscript(hook(),authority(),c.signal)).reason).toBe("aborted");expect(readFileSync(file,"utf8")).toBe(body);
  });
  test.each([-1,1.5,TRANSCRIPT_LIMITS.fileBytes+1].map(value=>[value]))("invalid cursor %j cannot cause seek or unbounded allocation",async cursor=>{
    expect((await acquireClaudeTranscript(hook(),{...authority(),cursor})).reason).toBe("invalid_authority");
  });
  test("an exact authorized subagent path preserves the independent descriptor source",async()=>{
    const agent="agent_fixture",sub=join(root,"fixture-project",session,"subagents","agent-"+agent+".jsonl");mkdirSync(join(root,"fixture-project",session,"subagents"),{recursive:true});writeFileSync(sub,body);
    const r=await acquireClaudeTranscript(hook(sub,"SubagentStop",agent),authority());await expectAccepted(r,sub);if(r.status==="accepted")expect(r.value.text).toBe(body);
    expect((await acquireClaudeTranscript(hook(sub,"SubagentStop","different"),authority())).reason).toBe("path_not_authorized");
  });
  test("home shorthand uses only the trusted profile and exact projects root",async()=>{
    const r=await acquireClaudeTranscript(hook("~/.claude/projects/fixture-project/"+session+".jsonl"),authority());await expectAccepted(r);
    expect((await acquireClaudeTranscript(hook("~/outside/"+session+".jsonl"),authority())).reason).toBe("path_not_authorized");
  });
});

test("exact 8MiB descriptor snapshot is bounded and accepted without a larger fallback",async()=>{
  writeFileSync(file,Buffer.alloc(TRANSCRIPT_LIMITS.fileBytes,32));const r=await acquireClaudeTranscript(hook(),authority());await expectAccepted(r);if(r.status!=="accepted")return;
  expect(r.value.text.length).toBe(TRANSCRIPT_LIMITS.fileBytes);expect(r.value.fileBytes).toBe(TRANSCRIPT_LIMITS.fileBytes);expect(r.value.prefixBytes).toBe(TRANSCRIPT_LIMITS.prefixBytes);
});
test("a resumed cursor requires the exact prior incarnation and prefix provenance",async()=>{
  expect((await acquireClaudeTranscript(hook(),{...authority(),cursor:1})).reason).toBe("invalid_authority");
  expect((await acquireClaudeTranscript(hook(),{...authority(),prefixBytes:4,expectedPrefixSha256:"a".repeat(64)})).reason).toBe("invalid_authority");
});
test("UTF8 byte offsets and business Unicode survive the exact observed snapshot",async()=>{
  const raw=body.replace("business output","🧪中文 café");writeFileSync(file,raw);const r=await acquireClaudeTranscript(hook(),authority());await expectAccepted(r);if(r.status!=="accepted")return;
  expect(r.value.text).toBe(raw);expect(r.value.endOffset).toBe(Buffer.byteLength(raw));expect(r.value.endOffset).toBeGreaterThan(raw.length);
});
test("cancellation during real async acquisition cannot return a publishable snapshot",async()=>{
  const controller=new AbortController();queueMicrotask(()=>controller.abort());const r=await acquireClaudeTranscript(hook(),authority(),controller.signal);expect(r.reason).toBe("aborted");expect(readFileSync(file,"utf8")).toBe(body);
});

test.skipIf(process.platform==="win32")("an actual FIFO is refused without opening or waiting for a producer",async()=>{
  rmSync(file);const made=spawnSync("mkfifo",[file],{stdio:"pipe"});expect(made.status).toBe(0);
  const started=performance.now();expect((await acquireClaudeTranscript(hook(),authority())).reason).toBe("not_regular_file");
  expect(performance.now()-started).toBeLessThan(TRANSCRIPT_LIMITS.acquisitionMs);
});
