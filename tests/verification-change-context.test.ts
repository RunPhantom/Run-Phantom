import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ChangeContextReader, verifyChangeContextJson } from "../src/verification/change-context";
import type { VerificationReport } from "../src/verification/protocol";
import { compileChangeGitFixture } from "./fixtures/change-context-git";

let native: ReturnType<typeof compileChangeGitFixture>;
beforeAll(() => { native = compileChangeGitFixture(); }, 30_000);
afterEach(() => { native?.assertClosed(); });
afterAll(() => { native?.close(); });

const report: VerificationReport = { id: "00000000-0000-4000-8000-000000000001", sessionId: "fixture", runId: null, flowId: null,
  name: "Synthetic measured-handoff shape fixture", createdAt: 1, status: "fail", reason: "Retained failing outcome", evidence: [] };
test("closed finite wire rejects duplicate, unknown, malformed UTF-8 and controls before parsed-object handling", () => {
  const valid = JSON.stringify({ workspaceId: report.id }); expect(() => verifyChangeContextJson(Buffer.from(valid))).not.toThrow();
  for (const raw of [valid.replace("}", ',"workspaceId":'+JSON.stringify(report.id)+'}'), valid.replace("}", ',"cwd":"/private"}'),
    valid.replace(report.id, "-".repeat(36)), valid.replace("workspaceId", "workspace\\u0049d"), "x".repeat(257), Buffer.from([255]), valid.replace(report.id, "\\u0000")]) {
    expect(() => verifyChangeContextJson(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))).toThrow();
  }
});
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Divyam Talwar", "-c", "user.email=divyamtalwar15@gmail.com", ...args], { cwd, encoding: "utf8", timeout: 1000 });
  if (result.status !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

describe("native change metadata has no repository command authority", () => {
  test("repository clean filters cannot execute while reading status or numstat", async () => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-git-policy-")));
    const marker = path.join(cwd, "filter-executed");
    const reader = new ChangeContextReader({ workspace: () => ({ cwd, revision: "native-fixture" }),
      authority: () => ({ id: "local", role: "owner", generation: 1 }), report: () => report });
    try {
      git(cwd, "init", "-q"); writeFileSync(path.join(cwd, "data.txt"), "original\n"); git(cwd, "add", "--", "data.txt"); git(cwd, "commit", "-qm", "Establish owned git filter safety fixture");
      const head = git(cwd, "rev-parse", "HEAD");
      const helper = `'${native.executable("filter").replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
      git(cwd, "config", "filter.qa.clean", helper); git(cwd, "config", "filter.qa.process", helper);
      writeFileSync(path.join(cwd, ".gitattributes"), "data.txt filter=qa\n");
      writeFileSync(path.join(cwd, "data.txt"), "changed\n");
      const control = spawnSync("git", ["hash-object", "--path=data.txt", "data.txt"], { cwd, timeout: 1000 });
      expect(control.error).toBeUndefined(); expect(control.status).not.toBeNull(); expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      const result = await reader.capture(reader.offer().workspaceId, report.id);
      expect(result.head).toBe(head);
      expect(result.handoff.status).toBe("fail"); expect(existsSync(marker)).toBe(false);
    } finally { reader.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
});

async function until(predicate: () => boolean): Promise<void> {
  const end = performance.now() + 700;
  while (!predicate()) { if (performance.now() >= end) throw new Error("Owned held-process fixture was not reached"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function heldProject() {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-held-git-")));
  git(cwd, "init", "-q"); writeFileSync(path.join(cwd, "tracked.txt"), "original\n"); git(cwd, "add", "--", "tracked.txt"); git(cwd, "commit", "-qm", "Retain real git process race fixture");
  const marker = path.join(cwd, "held"); const release = path.join(cwd, "release");
  const executable = native.executable("held");
  return { cwd, marker, release, executable };
}

describe("held native reads cannot publish after their authority changes", () => {
  test("role, owner generation, same-path selection, report removal, lease cancellation and request abort fence held real git reads", async () => {
    for (const mutation of ["role", "generation", "selection", "report", "lease", "abort", "expiry"]) {
      const f = heldProject(); const selected = { cwd: f.cwd, revision: "selection-1" };
      const owner = { id: "local", role: "owner" as "owner" | "reader", generation: 1 };
      let retained: VerificationReport | undefined = report;
      const reader = new ChangeContextReader({ workspace: () => selected, authority: () => owner, report: () => retained, gitExecutable: f.executable });
      const signal = new AbortController(); const offered = reader.offer();
      const originalNow = Date.now;
      let pending: Promise<unknown> | undefined;
      try {
        const result = reader.capture(offered.workspaceId, report.id, signal.signal).then(() => "published", error => error.status); pending = result;
        await until(() => existsSync(f.marker));
        if (mutation === "role") owner.role = "reader";
        if (mutation === "generation") owner.generation++;
        if (mutation === "selection") selected.revision = "selection-2";
        if (mutation === "report") retained = undefined;
        if (mutation === "lease") reader.cancel(offered.workspaceId);
        if (mutation === "abort") signal.abort();
        if (mutation === "expiry") Date.now = () => offered.expiresAt + 1;
        writeFileSync(f.release, "release\n");
        expect(await result).toBe(mutation === "role" ? 403 : 409);
        expect(report.status).toBe("fail");
      } finally { Date.now = originalNow; reader.close(); await pending; rmSync(f.cwd, { recursive: true, force: true }); }
    }
  });
  test("two actual process slots reject a third read without queueing, then release only after held children drain", async () => {
    const fixtures = [heldProject(), heldProject(), heldProject()];
    const readers = fixtures.map(f => new ChangeContextReader({ workspace: () => ({ cwd: f.cwd, revision: "quota" }),
      authority: () => ({ id: "local", role: "owner", generation: 1 }), report: () => report, gitExecutable: f.executable }));
    const pending: Promise<unknown>[] = [];
    try {
      pending.push(...readers.slice(0, 2).map(reader => reader.capture(reader.offer().workspaceId, report.id)));
      const refused = await readers[2].capture(readers[2].offer().workspaceId, report.id).then(() => "published", error => error.status);
      expect(refused).toBe(409);
      expect(existsSync(fixtures[2].marker)).toBe(false);
      for (const f of fixtures.slice(0, 2)) writeFileSync(f.release, "release\n");
      const results = await Promise.all(pending); expect(results).toHaveLength(2);
      expect(fixtures.slice(0, 2).every(f => existsSync(f.marker))).toBe(true);
      writeFileSync(fixtures[2].release, "release\n");
      const subsequent = await readers[2].capture(readers[2].offer().workspaceId, report.id); expect(subsequent.handoff.status).toBe("fail");
    } finally { readers.forEach(reader => reader.close()); await Promise.allSettled(pending); fixtures.forEach(f => rmSync(f.cwd, { recursive: true, force: true })); }
  });
});

describe("unsupported and finite native workspaces stay explicitly incomplete", () => {
  test("no Git, unborn HEAD, alternates, promisor storage and aggregate deadlines never imply a clean tested revision", async () => {
    for (const kind of ["no-git", "unborn", "alternates", "promisor", "deadline"]) {
      const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-limited-git-")));
      if (kind !== "no-git") git(cwd, "init", "-q");
      if (!["no-git", "unborn"].includes(kind)) { writeFileSync(path.join(cwd, "item.txt"), "one\n"); git(cwd, "add", "--", "item.txt"); git(cwd, "commit", "-qm", "Bound unsupported metadata fixture"); }
      if (kind === "alternates") writeFileSync(path.join(cwd, ".git/objects/info/alternates"), "/unavailable/objects\n");
      if (kind === "promisor") git(cwd, "config", "remote.fixture.promisor", "true");
      let executable: string | undefined;
      if (kind === "deadline") executable = native.executable("slow");
      const reader = new ChangeContextReader({ workspace: () => ({ cwd, revision: kind }), authority: () => ({ id: "local", role: "owner", generation: 1 }), report: () => report, gitExecutable: executable });
      try {
        const started = performance.now(); const result = await reader.capture(reader.offer().workspaceId, report.id);
        expect(result.complete).toBe(false); expect(result.testedRevision).toBeNull(); expect(result.handoff.status).toBe("fail");
        expect(result.reasons).toContain(kind === "no-git" ? "not-git" : kind === "unborn" ? "unborn-head" : kind === "deadline" ? "deadline" : "unsupported-git-storage");
        if (kind === "deadline") expect(performance.now() - started).toBeLessThan(1500);
      } finally { reader.close(); rmSync(cwd, { recursive: true, force: true }); }
    }
  });
});

describe("persisted workspace selections have a distinct finite authority boundary", () => {
  test("native state bytes, descriptor identity, directory replacement and malformed selections are fenced without changing legacy fallback", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-selected-workspace-")));
    const module = path.resolve("src/active-workspace.ts");
    const code = `
      import fs from "node:fs"; import os from "node:os"; import path from "node:path";
      import { getSelectedActiveWorkspace, getActiveWorkspace } from ${JSON.stringify(module)};
      const project = path.join(process.cwd(), "欢迎"); fs.mkdirSync(project);
      const state = path.join(os.homedir(), ".runphantom", "active-workspace.json"); fs.mkdirSync(path.dirname(state), { recursive:true });
      const results = { missingRefused:getSelectedActiveWorkspace()===null, legacyFallback:getActiveWorkspace()?.cwd===process.cwd() };
      const value = { cwd:fs.realpathSync(project), updated_at:"2026-10-13T00:00:00.000Z" };
      const raw = JSON.stringify(value); fs.writeFileSync(state,raw); const first=getSelectedActiveWorkspace();
      results.valid=!!first && first.cwd===value.cwd && /^[a-f0-9]{64}$/.test(first.revision);
      fs.writeFileSync(state,raw); const reselection=getSelectedActiveWorkspace(); results.samePathReselection=!!reselection && reselection.revision!==first?.revision;
      fs.writeFileSync(state,JSON.stringify({updated_at:value.updated_at,cwd:value.cwd})); const reordered=getSelectedActiveWorkspace(); results.rawBytesBound=!!reordered && reordered.revision!==reselection?.revision;
      fs.writeFileSync(state+".new",raw); fs.renameSync(state+".new",state); const replacement=getSelectedActiveWorkspace(); results.fileReplacement=!!replacement && replacement.revision!==reordered?.revision;
      fs.renameSync(project,project+"-old"); fs.mkdirSync(project); const directoryReplacement=getSelectedActiveWorkspace(); results.directoryReplacement=!!directoryReplacement && directoryReplacement.revision!==replacement?.revision;
      results.invalid=[];
      for (const invalid of [JSON.stringify({cwd:value.cwd}),JSON.stringify({...value,updated_at:"not-time"}),JSON.stringify({...value,extra:true}),'{"cwd":'+JSON.stringify(value.cwd)+',"updated_at":'+JSON.stringify(value.updated_at)+',"cwd":'+JSON.stringify(value.cwd)+'}',Buffer.from([255,254]),"x".repeat(8193),JSON.stringify({...value,cwd:value.cwd+String.fromCharCode(0)})]) {fs.writeFileSync(state,invalid);results.invalid.push(getSelectedActiveWorkspace()===null);}
      fs.writeFileSync(state+".target",raw);fs.unlinkSync(state);fs.symlinkSync(state+".target",state);results.symlinkRefused=getSelectedActiveWorkspace()===null;
      results.legacyStillReadsItsOriginalSelection=getActiveWorkspace()?.cwd===value.cwd;
      console.log(JSON.stringify(results));
    `;
    try {
      const result = spawnSync(process.execPath, ["--no-env-file", "-e", code], { cwd: root,
        env: { HOME: path.join(root, "isolated-profile"), PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8", timeout: 2000 });
      expect(result.status).toBe(0); const proof = JSON.parse(result.stdout);
      for (const key of ["missingRefused", "legacyFallback", "valid", "samePathReselection", "rawBytesBound", "fileReplacement", "directoryReplacement", "symlinkRefused", "legacyStillReadsItsOriginalSelection"]) expect(proof[key]).toBe(true);
      expect(proof.invalid).toEqual([true, true, true, true, true, true, true]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("finite native git process bounds retain unavailable evidence", () => {
  test("fatal encoding and stdout limits cannot appear as a clean empty workspace", async () => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-git-bounds-")));
    try {
      for (const [name, reason] of [["encoding", "invalid-utf8"], ["bytes", "git-output-limit"]] as const) {
        const executable = native.executable(name);
        const reader = new ChangeContextReader({ workspace: () => ({ cwd, revision: "bounded-native" }),
          authority: () => ({ id: "local", role: "owner", generation: 1 }), report: () => report, gitExecutable: executable });
        try {
          const result = await reader.capture(reader.offer().workspaceId, report.id);
          expect(result.complete).toBe(false); expect(result.reasons).toContain(reason); expect(result.changes).toEqual([]);
          expect(result.testedRevision).toBeNull(); expect(result.handoff.status).toBe("fail");
        } finally { reader.close(); }
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
