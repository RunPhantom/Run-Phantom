import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FILE_ALL_ACCESS, W0_LIMITS, checkedAddress, checkedRange, nativeSystemModuleMatches, ownerOnlyAcl, securityAttributes, sidText, wide } from "./fixtures/windows-private-files-w0-codec";
import { ownW0DiagnosticChild, type W0ChildClose } from "./fixtures/windows-private-files-w0-supervisor";

const sid = Buffer.from("010100000000000520000000", "hex");
const allowed = { type: 0, flags: 0, mask: FILE_ALL_ACCESS, sid };

describe("Windows private-file W0 diagnostic controls", () => {
  test("keeps Win64 structure widths and inheritance explicit", () => {
    const bytes = securityAttributes(0x123456789an);
    expect(bytes.length).toBe(24);
    expect(bytes.readUInt32LE(0)).toBe(24);
    expect(bytes.readBigUInt64LE(8)).toBe(0x123456789an);
    expect(bytes.readInt32LE(16)).toBe(0);
    expect(wide("native-\u03bb").subarray(-2).equals(Buffer.alloc(2))).toBe(true);
    expect(() => wide("x\0y")).toThrow("invalid_wide_input");
  });
  test("refuses non-address handles, lossy pointers and out-of-allocation ranges", () => {
    for (const value of [null, 0n, -1n, Number.MAX_SAFE_INTEGER + 1, 0xffffffffffffffffn]) expect(() => checkedAddress(value)).toThrow();
    expect(checkedAddress(0x123456789an)).toBe(0x123456789an);
    expect(() => checkedRange(100n, 32, 99n, 1)).toThrow();
    expect(() => checkedRange(100n, 32, 132n, 1)).toThrow();
    expect(() => checkedRange(100n, 32, 101n, 32)).toThrow();
    expect(() => checkedRange(100n, 65537, 100n, 1)).toThrow();
    expect(() => checkedRange(100n, 32, 101n, 31)).not.toThrow();
  });
  test("decodes bounded SID bytes without a username or environment lookup", () => {
    expect(sidText(sid)).toBe("S-1-5-32");
    for (const invalid of [Buffer.alloc(7), Buffer.from([1, 16, 0, 0, 0, 0, 0, 5]), Buffer.concat([sid, Buffer.alloc(4)])]) expect(() => sidText(invalid)).toThrow();
  });
  test("requires the closed policy's protected owner-only effective ACE", () => {
    expect(ownerOnlyAcl(true, true, false, true, [allowed], sid, false)).toBe(true);
    expect(ownerOnlyAcl(true, true, false, true, [{ ...allowed, flags: 3 }], sid, true)).toBe(true);
    for (const flags of [1, 2, 8, 16]) expect(ownerOnlyAcl(true, true, false, true, [{ ...allowed, flags }], sid, false)).toBe(false);
    expect(ownerOnlyAcl(false, true, false, true, [allowed], sid, false)).toBe(false);
    expect(ownerOnlyAcl(true, false, false, true, [allowed], sid, false)).toBe(false);
    expect(ownerOnlyAcl(true, true, true, true, [], sid, false)).toBe(false);
    expect(ownerOnlyAcl(true, true, false, true, [], sid, false)).toBe(false);
    expect(ownerOnlyAcl(true, true, false, false, [allowed], sid, false)).toBe(false);
    expect(ownerOnlyAcl(true, true, false, true, [allowed, allowed], sid, false)).toBe(false);
    expect(ownerOnlyAcl(true, true, false, true, [{ ...allowed, type: 9 }], sid, false)).toBe(false);
    expect(ownerOnlyAcl(true, true, false, true, [{ ...allowed, mask: 0x120089 }], sid, false)).toBe(false);
    expect(ownerOnlyAcl(true, true, false, true, [{ ...allowed, sid: Buffer.alloc(sid.length) }], sid, false)).toBe(false);
  });
  test("accepts only the exact native System32 module identity", () => {
    expect(nativeSystemModuleMatches("C:\\Windows\\System32\\KERNEL32.DLL", "C:\\Windows\\System32", "kernel32.dll")).toBe(true);
    expect(nativeSystemModuleMatches("\\\\?\\C:\\Windows\\System32\\advapi32.dll", "C:\\Windows\\System32", "advapi32.dll")).toBe(true);
    for (const actual of ["kernel32.dll", "C:\\work\\kernel32.dll", "C:\\Windows\\System32-extra\\kernel32.dll"]) expect(nativeSystemModuleMatches(actual, "C:\\Windows\\System32", "kernel32.dll")).toBe(false);
  });
});

describe("W0 inert direct-child supervisor controls (no process or native API)", () => {
  interface InertControl { directory: string; owner: ReturnType<typeof ownW0DiagnosticChild>; closed: Promise<W0ChildClose>; resolve(value: W0ChildClose): void }
  const active = new Set<InertControl>();
  const control = (kill: () => boolean, runMs = 10, confirmationMs = 10) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "runphantom-w0-control-"));
    let resolve!: (value: W0ChildClose) => void;
    const closed = new Promise<W0ChildClose>(value => { resolve = value; });
    const owner = ownW0DiagnosticChild(directory, { runMs, confirmationMs });
    owner.adopt({ pid: undefined, kill }, closed);
    const value = { directory, owner, closed, resolve }; active.add(value); return value;
  };
  const release = async (value: InertControl) => {
    value.resolve({ code: 0, signal: null }); await value.closed;
    const receipt = await value.owner.cleanup();
    expect(receipt.reaped).toBe(true);
    expect(receipt.rootRemovedAfterReap).toBe(true);
    expect(existsSync(value.directory)).toBe(false);
    active.delete(value);
  };
  afterEach(async () => {
    const failures: unknown[] = [];
    for (const value of active) { try { await release(value); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, "inert_supervisor_control_cleanup_failed");
  });
  test("observed normal close permits removal and preserves a later primary failure", async () => {
    let kills = 0;
    const c = control(() => { kills++; return true; }, 100, 100);
    c.resolve({ code: 0, signal: null });
    expect(await c.owner.run()).toEqual({ code: 0, signal: null });
    expect((await c.owner.cleanup()).rootRemovedAfterReap).toBe(true);
    expect(kills).toBe(0);
    expect(() => c.owner.throwFailure()).not.toThrow();
    const primary = new Error("actual_native_or_parse_failure"); c.owner.recordPrimary(primary);
    let caught: unknown; try { c.owner.throwFailure(); } catch (error) { caught = error; }
    expect(caught).toBe(primary);
    expect(existsSync(c.directory)).toBe(false);
  });
  test("false kill and absent close finish with retained root and separate cleanup failure", async () => {
    let kills = 0;
    const c = control(() => { kills++; return false; });
    try { await c.owner.run(); } catch { /* Inspected below, including the exact preserved primary. */ }
    const primary = c.owner.primaryError, receipt = await c.owner.cleanup();
    expect(primary).toBeInstanceOf(Error);
    expect((primary as Error).message).toBe("native_child_deadline");
    expect(receipt.deadline).toBe(true);
    expect(receipt.killAccepted).toBe(false);
    expect(receipt.reaped).toBe(false);
    expect(receipt.cleanupUnconfirmed).toBe(true);
    expect(receipt.rootRemovedAfterReap).toBe(false);
    expect(receipt.elapsedMs).toBeLessThan(1000);
    expect(existsSync(c.directory)).toBe(true);
    expect(kills).toBe(1);
    let caught: unknown; try { c.owner.throwFailure(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0]).toBe(primary);
    expect(c.owner.secondaryErrors.map(error => (error as Error).message)).toEqual(["native_kill_not_accepted", "native_child_cleanup_unconfirmed"]);
    await release(c);
  });
  test("thrown kill cannot replace the primary or authorize root deletion", async () => {
    const killFailure = new Error("controlled_kill_throw"), primary = new Error("controlled_primary");
    const c = control(() => { throw killFailure; });
    c.owner.fail(primary);
    let caught: unknown; try { await c.owner.run(); } catch (error) { caught = error; }
    expect(caught).toBe(primary);
    const receipt = await c.owner.cleanup();
    expect(receipt.killAccepted).toBeNull();
    expect(receipt.reaped).toBe(false);
    expect(receipt.rootRemovedAfterReap).toBe(false);
    expect(receipt.cleanupUnconfirmed).toBe(true);
    expect(existsSync(c.directory)).toBe(true);
    expect(c.owner.secondaryErrors[0]).toBe(killFailure);
    try { c.owner.throwFailure(); } catch (error) { caught = error; }
    expect((caught as AggregateError).errors).toContain(primary);
    expect((caught as AggregateError).errors).toContain(killFailure);
    expect(c.owner.primaryError).toBe(primary);
    await release(c);
  });
  test("repeated overflow requests are contained and never turn kill acceptance into reap", async () => {
    let kills = 0;
    const c = control(() => { kills++; return true; }), primary = new Error("native_output_limit");
    expect(() => c.owner.fail(primary)).not.toThrow();
    expect(() => c.owner.fail(new Error("later_output_limit"))).not.toThrow();
    try { await c.owner.run(); } catch { /* The exact first overflow identity remains authoritative. */ }
    const receipt = await c.owner.cleanup();
    expect(kills).toBe(1);
    expect(receipt.killAccepted).toBe(true);
    expect(receipt.reaped).toBe(false);
    expect(receipt.cleanupUnconfirmed).toBe(true);
    expect(receipt.rootRemovedAfterReap).toBe(false);
    expect(c.owner.primaryError).toBe(primary);
    expect(existsSync(c.directory)).toBe(true);
    await release(c);
  });
  test("a close observed during the confirmation reserve permits cleanup without losing the deadline failure", async () => {
    const c = control(() => true, 5, 100);
    try { await c.owner.run(); } catch { /* Deadline remains a failure after eventual confirmed closure. */ }
    const primary = c.owner.primaryError;
    const timer = setTimeout(() => c.resolve({ code: null, signal: "SIGKILL" }), 1);
    const receipt = await c.owner.cleanup(); clearTimeout(timer);
    expect(receipt.reaped).toBe(true);
    expect(receipt.killAccepted).toBe(true);
    expect(receipt.rootRemovedAfterReap).toBe(true);
    expect(existsSync(c.directory)).toBe(false);
    let caught: unknown; try { c.owner.throwFailure(); } catch (error) { caught = error; }
    expect(caught).toBe(primary);
  });
});

test("reports actual native Windows W0 observations without changing product authority", async () => {
  if (process.platform !== "win32") {
    console.log(JSON.stringify({ diagnostic: "windows-private-files-w0/v1", status: "NOT_EXECUTED_NATIVE_WINDOWS", platform: process.platform, qualification: "NO_WINDOWS_SUPPORT_ACCEPTANCE" }));
    expect(process.platform).not.toBe("win32");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "runphantom-w0-"));
  const owner = ownW0DiagnosticChild(root);
  const entry = fileURLToPath(new URL("./fixtures/windows-private-files-w0-runner.ts", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["systemroot", "windir", "temp", "tmp"].includes(key.toLowerCase())));
  let output = "", bytes = 0, stderrBytes = 0, overflow = false, spawnFailed = false, nativeResult = false;
  try {
    const child = spawn(process.execPath, ["--no-env-file", entry, "--synthetic-root", root], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<W0ChildClose>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    owner.adopt(child, closed);
    child.once("error", error => { spawnFailed = true; owner.fail(error); });
    const bounded = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (!stdout) stderrBytes += chunk.length;
      if (bytes > 32768) { overflow = true; owner.fail(new Error("native_output_limit")); return; }
      if (stdout) output += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => bounded(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => bounded(chunk, false));
    const { code: exit } = await owner.run();
    expect(spawnFailed).toBe(false);
    expect(owner.ownership().deadline).toBe(false);
    expect(overflow).toBe(false);
    const lines = output.trim().split("\n");
    expect(lines.length).toBe(1);
    const result = JSON.parse(lines[0]);
    nativeResult = true;
    console.log(JSON.stringify(result));
    expect(exit).toBe(0);
    expect(result.status).toBe("OBSERVED_NATIVE_WINDOWS");
    expect(result.qualification).toBe("DIAGNOSTIC_ONLY_NOT_PRODUCTION_AUTHORITY");
    expect(result.observations.nativeOwnerOnlyFile).toBe(true);
    expect(result.observations.nativeSidEqualityAndMismatch).toBe(true);
    expect(result.observations.sameHandleWorkerRead).toBe(true);
    expect(result.observations.nativeDescriptorNegatives).toBe(true);
    expect(result.observations.mainDeadlineWhileNativeWaitPending).toBe(true);
    expect(result.cleanup.complete).toBe(true);
  } catch (error) { owner.recordPrimary(error); }
  const receipt = await owner.cleanup();
  console.log(JSON.stringify({ diagnostic: "windows-private-files-w0-supervisor/v2", ...receipt, overflow, stderrBytes, spawnFailed, nativeResult }));
  owner.throwFailure();
  expect(existsSync(root)).toBe(false);
}, W0_LIMITS.childMs + 3000);
