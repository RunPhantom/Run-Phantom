import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FILE_ALL_ACCESS, W0_LIMITS, checkedAddress, checkedRange, nativeSystemModuleMatches, ownerOnlyAcl, securityAttributes, sidText, wide } from "./fixtures/windows-private-files-w0-codec";

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

test("reports actual native Windows W0 observations without changing product authority", async () => {
  if (process.platform !== "win32") {
    console.log(JSON.stringify({ diagnostic: "windows-private-files-w0/v1", status: "NOT_EXECUTED_NATIVE_WINDOWS", platform: process.platform, qualification: "NO_WINDOWS_SUPPORT_ACCEPTANCE" }));
    expect(process.platform).not.toBe("win32");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "runphantom-w0-"));
  const entry = fileURLToPath(new URL("./fixtures/windows-private-files-w0-runner.ts", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["systemroot", "windir", "temp", "tmp"].includes(key.toLowerCase())));
  const child = spawn(process.execPath, ["--no-env-file", entry, "--synthetic-root", root], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", bytes = 0, stderrBytes = 0, overflow = false, deadline = false, reaped = false, spawnFailed = false;
  let exitCode: number | null = null, nativeResult = false;
  child.once("error", () => { spawnFailed = true; });
  const closed = new Promise<number | null>(resolve => child.once("close", code => { reaped = true; resolve(code); }));
  const bounded = (chunk: Buffer, stdout: boolean) => {
    bytes += chunk.length;
    if (!stdout) stderrBytes += chunk.length;
    if (bytes > 32768) { overflow = true; child.kill("SIGKILL"); return; }
    if (stdout) output += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => bounded(chunk, true));
  child.stderr.on("data", (chunk: Buffer) => bounded(chunk, false));
  const timer = setTimeout(() => { deadline = true; child.kill("SIGKILL"); }, W0_LIMITS.childMs);
  let primaryFailure: unknown, failed = false;
  try {
    const exit = await closed;
    exitCode = exit;
    expect(spawnFailed).toBe(false);
    expect(deadline).toBe(false);
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
  } catch (error) { failed = true; primaryFailure = error; }
  clearTimeout(timer);
  try {
    if (!reaped) {
      child.kill("SIGKILL");
      await closed;
    }
    if (!reaped) throw new Error("native_child_not_reaped");
    rmSync(root, { recursive: true, force: false });
  } catch (error) {
    console.log(JSON.stringify({ diagnostic: "windows-private-files-w0-supervisor/v1", pid: child.pid, exitCode, signal: child.signalCode, reaped, deadline, overflow, stderrBytes, nativeResult, rootRemovedAfterReap: false }));
    if (failed) throw new AggregateError([primaryFailure, error], "native_diagnostic_and_cleanup_failed");
    throw error;
  }
  console.log(JSON.stringify({ diagnostic: "windows-private-files-w0-supervisor/v1", pid: child.pid, exitCode, signal: child.signalCode, reaped, deadline, overflow, stderrBytes, nativeResult, rootRemovedAfterReap: !existsSync(root) }));
  if (failed) throw primaryFailure;
  expect(existsSync(root)).toBe(false);
}, W0_LIMITS.childMs + 3000);
