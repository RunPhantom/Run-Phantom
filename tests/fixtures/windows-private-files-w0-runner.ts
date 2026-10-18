import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import type { Pointer } from "bun:ffi";
import { W0_LIMITS, checkedAddress, checkedRange, nativeSystemModuleMatches, ownerOnlyAcl, securityAttributes, sidText, wide, type AllowedAce } from "./windows-private-files-w0-codec";

const INVALID_HANDLE = 0xffffffffffffffffn;
const WAIT_TIMEOUT = 258;
const payload = Buffer.from("private-w0-synthetic\n", "ascii");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pointerOut = (bytes: Buffer) => bytes.readBigUInt64LE(0);
const u32 = () => Buffer.alloc(4);
const pointerSlot = () => Buffer.alloc(8);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

class DiagnosticFailure extends Error {
  constructor(readonly stage: string, readonly nativeCode?: number) { super(stage); }
}
function requireObserved(value: unknown, stage: string, nativeCode?: number): asserts value {
  if (!value) throw new DiagnosticFailure(stage, nativeCode);
}

const borrowedDefinitions = {
  ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  SetFilePointerEx: { args: ["u64", "i64", "ptr", "u32"], returns: "i32" },
  GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
  GetCurrentThreadId: { args: [], returns: "u32" },
  SignalObjectAndWait: { args: ["u64", "u64", "u32", "i32"], returns: "u32" },
} as const;
type BorrowedName = keyof typeof borrowedDefinitions;
interface BorrowedWork { kind: "native-w0-borrowed-handles"; file: bigint; entered: bigint; release: bigint; functions: Record<BorrowedName, bigint> }

async function borrowedWorker(): Promise<void> {
  const work = workerData as BorrowedWork;
  requireObserved(work?.kind === "native-w0-borrowed-handles" && parentPort && process.platform === "win32" && process.arch === "x64", "worker_protocol");
  const { linkSymbols } = await import("bun:ffi");
  const definitions = {
    ReadFile: { ...borrowedDefinitions.ReadFile, ptr: work.functions.ReadFile },
    SetFilePointerEx: { ...borrowedDefinitions.SetFilePointerEx, ptr: work.functions.SetFilePointerEx },
    GetFileInformationByHandleEx: { ...borrowedDefinitions.GetFileInformationByHandleEx, ptr: work.functions.GetFileInformationByHandleEx },
    GetCurrentThreadId: { ...borrowedDefinitions.GetCurrentThreadId, ptr: work.functions.GetCurrentThreadId },
    SignalObjectAndWait: { ...borrowedDefinitions.SignalObjectAndWait, ptr: work.functions.SignalObjectAndWait },
  };
  for (const value of Object.values(work.functions)) checkedAddress(value);
  const library = linkSymbols(definitions), api = library.symbols;
  try {
    const bytes = Buffer.alloc(W0_LIMITS.payloadBytes), read = u32(), identity = Buffer.alloc(24);
    requireObserved(api.SetFilePointerEx(work.file, 0n, null, 0) !== 0, "worker_seek");
    requireObserved(api.ReadFile(work.file, bytes, bytes.length, read, null) !== 0, "worker_read");
    requireObserved(api.GetFileInformationByHandleEx(work.file, 18, identity, identity.length) !== 0, "worker_identity");
    parentPort.postMessage({ kind: "native-ready", thread: api.GetCurrentThreadId(), bytes: read.readUInt32LE(), sha256: digest(bytes.subarray(0, read.readUInt32LE())), identity: identity.toString("hex") });
    const result = api.SignalObjectAndWait(work.entered, work.release, W0_LIMITS.nativeWaitMs, 0);
    parentPort.postMessage({ kind: "native-wait-completed", result });
  } finally { library.close(); parentPort.close(); }
}

async function nativeProbe(syntheticRoot: string) {
  const observations: Record<string, unknown> = {};
  const cleanup = { handlesAcquired: 0, handlesClosed: 0, closedHandlesInvalid: 0, allocationsAcquired: 0, allocationsFreed: 0, nativeThreadSignaled: false, privateFileAbsent: false, privateDirectoryRemoved: false, syntheticParentEmpty: false, complete: false };
  const report = { diagnostic: "windows-private-files-w0/v1", status: "ERROR_NATIVE_WINDOWS", qualification: "DIAGNOSTIC_ONLY_NOT_PRODUCTION_AUTHORITY", runtime: { version: Bun.version, revision: Bun.revision }, platform: process.platform, arch: process.arch, observations, cleanup, failure: undefined as undefined | { stage: string; nativeCode?: number } };
  if (process.platform !== "win32") return { ...report, status: "NOT_EXECUTED_NATIVE_WINDOWS" };
  if (process.arch !== "x64" || Bun.version !== "1.4.0") return { ...report, status: "UNAVAILABLE_NATIVE_WINDOWS", failure: { stage: "locked_runtime_or_architecture_unavailable" } };
  requireObserved(path.isAbsolute(syntheticRoot) && /^runphantom-w0-[A-Za-z0-9]+$/.test(path.basename(syntheticRoot)), "synthetic_root_name");
  const before = lstatSync(syntheticRoot);
  requireObserved(before.isDirectory() && !before.isSymbolicLink() && readdirSync(syntheticRoot).length === 0, "synthetic_root_not_empty_directory");
  const { dlopen, linkSymbols, ptr, toArrayBuffer } = await import("bun:ffi");
  // Kernel32 is the fixed loaded Windows bootstrap. No path or library name comes from input.
  const kernel = dlopen("kernel32.dll", {
    GetModuleHandleW: { args: ["ptr"], returns: "u64" },
    GetModuleFileNameW: { args: ["u64", "ptr", "u32"], returns: "u32" },
    GetSystemDirectoryW: { args: ["ptr", "u32"], returns: "u32" },
    LoadLibraryExW: { args: ["ptr", "u64", "u32"], returns: "u64" },
    GetProcAddress: { args: ["u64", "ptr"], returns: "ptr" },
    FreeLibrary: { args: ["u64"], returns: "i32" },
    GetCurrentProcess: { args: [], returns: "u64" },
    GetLastError: { args: [], returns: "u32" },
    LocalFree: { args: ["u64"], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetHandleInformation: { args: ["u64", "ptr"], returns: "i32" },
    CreateDirectoryW: { args: ["ptr", "ptr"], returns: "i32" },
    RemoveDirectoryW: { args: ["ptr"], returns: "i32" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetFileType: { args: ["u64"], returns: "u32" },
    GetFileInformationByHandleEx: borrowedDefinitions.GetFileInformationByHandleEx,
    GetVolumeInformationByHandleW: { args: ["u64", "ptr", "u32", "ptr", "ptr", "ptr", "ptr", "u32"], returns: "i32" },
    WriteFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    ReadFile: borrowedDefinitions.ReadFile,
    SetFilePointerEx: borrowedDefinitions.SetFilePointerEx,
    FlushFileBuffers: { args: ["u64"], returns: "i32" },
    GetFileAttributesW: { args: ["ptr"], returns: "u32" },
    CreateEventW: { args: ["ptr", "i32", "i32", "ptr"], returns: "u64" },
    OpenThread: { args: ["u32", "i32", "u32"], returns: "u64" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    SignalObjectAndWait: borrowedDefinitions.SignalObjectAndWait,
    GetCurrentThreadId: borrowedDefinitions.GetCurrentThreadId,
  });
  const k = kernel.symbols;
  let advapiModule = 0n, directoryHandle = 0n, fileHandle = 0n, workerThread = 0n, worker: Worker | undefined;
  let directoryCreated = false, fileCreated = false, workerExited = false, workerExit: Promise<number> | undefined;
  const handles = new Set<bigint>(), allocations = new Set<bigint>();
  const privateDirectory = path.join(syntheticRoot, "private"), file = path.join(privateDirectory, "synthetic.bin");
  const own = (handle: bigint, stage: string) => { requireObserved(handle !== 0n && handle !== INVALID_HANDLE, stage); handles.add(handle); cleanup.handlesAcquired++; return handle; };
  const close = (handle: bigint) => {
    requireObserved(handles.has(handle), "close_unowned_handle");
    requireObserved(k.CloseHandle(handle) !== 0, "close_handle"); handles.delete(handle); cleanup.handlesClosed++;
    requireObserved(k.GetHandleInformation(handle, u32()) === 0, "closed_handle_still_valid"); cleanup.closedHandlesInvalid++;
  };
  const ownAllocation = (address: bigint) => { checkedAddress(address); allocations.add(address); cleanup.allocationsAcquired++; return address; };
  const memory = (address: bigint, length: number): Buffer => {
    checkedAddress(address); requireObserved(Number.isInteger(length) && length > 0 && length <= W0_LIMITS.descriptorBytes, "native_view_length");
    return Buffer.from(new Uint8Array(toArrayBuffer(Number(address) as Pointer, 0, length)));
  };
  const functionAt = (module: bigint, name: string) => checkedAddress(k.GetProcAddress(module, Buffer.from(name + "\0", "ascii")));
  const modulePath = (module: bigint) => {
    const out = Buffer.alloc(4096), size = k.GetModuleFileNameW(module, out, out.length / 2);
    requireObserved(size > 0 && size < out.length / 2, "module_path_unavailable"); return out.subarray(0, size * 2).toString("utf16le");
  };
  let closeAdvapi: (() => void) | undefined;
  try {
    const sys = Buffer.alloc(4096), chars = k.GetSystemDirectoryW(sys, sys.length / 2);
    requireObserved(chars > 0 && chars < sys.length / 2, "system_directory");
    const system = sys.subarray(0, chars * 2).toString("utf16le"), loadedKernel = k.GetModuleHandleW(wide("kernel32.dll"));
    requireObserved(loadedKernel !== 0n && nativeSystemModuleMatches(modulePath(loadedKernel), system, "kernel32.dll"), "bootstrap_module_identity");
    advapiModule = k.LoadLibraryExW(wide(system + "\\advapi32.dll"), 0n, 0x800);
    requireObserved(advapiModule !== 0n && nativeSystemModuleMatches(modulePath(advapiModule), system, "advapi32.dll"), "system_only_advapi_identity");
    observations.fixedSystemModules = true;
    const advapi = linkSymbols({
      OpenProcessToken: { ptr: functionAt(advapiModule, "OpenProcessToken"), args: ["u64", "u32", "ptr"], returns: "i32" },
      GetTokenInformation: { ptr: functionAt(advapiModule, "GetTokenInformation"), args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
      IsValidSid: { ptr: functionAt(advapiModule, "IsValidSid"), args: ["ptr"], returns: "i32" },
      GetLengthSid: { ptr: functionAt(advapiModule, "GetLengthSid"), args: ["ptr"], returns: "u32" },
      EqualSid: { ptr: functionAt(advapiModule, "EqualSid"), args: ["ptr", "ptr"], returns: "i32" },
      ConvertStringSecurityDescriptorToSecurityDescriptorW: { ptr: functionAt(advapiModule, "ConvertStringSecurityDescriptorToSecurityDescriptorW"), args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
      GetSecurityInfo: { ptr: functionAt(advapiModule, "GetSecurityInfo"), args: ["u64", "i32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
      GetSecurityDescriptorLength: { ptr: functionAt(advapiModule, "GetSecurityDescriptorLength"), args: ["ptr"], returns: "u32" },
      GetSecurityDescriptorControl: { ptr: functionAt(advapiModule, "GetSecurityDescriptorControl"), args: ["ptr", "ptr", "ptr"], returns: "i32" },
      GetSecurityDescriptorOwner: { ptr: functionAt(advapiModule, "GetSecurityDescriptorOwner"), args: ["ptr", "ptr", "ptr"], returns: "i32" },
      GetSecurityDescriptorDacl: { ptr: functionAt(advapiModule, "GetSecurityDescriptorDacl"), args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
      IsValidSecurityDescriptor: { ptr: functionAt(advapiModule, "IsValidSecurityDescriptor"), args: ["ptr"], returns: "i32" },
      IsValidAcl: { ptr: functionAt(advapiModule, "IsValidAcl"), args: ["ptr"], returns: "i32" },
      GetAclInformation: { ptr: functionAt(advapiModule, "GetAclInformation"), args: ["ptr", "ptr", "u32", "i32"], returns: "i32" },
      GetAce: { ptr: functionAt(advapiModule, "GetAce"), args: ["ptr", "u32", "ptr"], returns: "i32" },
    } as const);
    closeAdvapi = () => advapi.close();
    const a = advapi.symbols, tokenOut = pointerSlot();
    requireObserved(a.OpenProcessToken(k.GetCurrentProcess(), 8, tokenOut) !== 0, "process_token");
    const token = own(pointerOut(tokenOut), "token_handle"), needed = u32();
    requireObserved(a.GetTokenInformation(token, 1, null, 0, needed) === 0, "token_size_query");
    const sizeError = k.GetLastError(), tokenSize = needed.readUInt32LE();
    requireObserved(sizeError === 122 && tokenSize >= 20 && tokenSize <= 4096, "token_size_or_native_error", sizeError);
    const tokenBytes = Buffer.alloc(tokenSize);
    requireObserved(a.GetTokenInformation(token, 1, tokenBytes, tokenBytes.length, needed) !== 0, "token_user");
    const sidAddress = pointerOut(tokenBytes), tokenBase = checkedAddress(ptr(tokenBytes));
    checkedRange(tokenBase, tokenBytes.length, sidAddress, 8);
    const tokenSidHeader = memory(sidAddress, 8), expectedSidLength = 8 + 4 * tokenSidHeader[1];
    requireObserved(tokenSidHeader[0] === 1 && tokenSidHeader[1] <= 15, "token_sid_header");
    checkedRange(tokenBase, tokenBytes.length, sidAddress, expectedSidLength);
    requireObserved(a.IsValidSid(sidAddress) !== 0, "token_sid_valid");
    const sidLength = a.GetLengthSid(sidAddress); requireObserved(sidLength === expectedSidLength, "token_sid_length");
    const ownerSid = memory(sidAddress, sidLength), ownerText = sidText(ownerSid);
    close(token);
    const worldSid = Buffer.from("010100000000000100000000", "hex");
    requireObserved(a.IsValidSid(worldSid) !== 0 && a.GetLengthSid(worldSid) === worldSid.length && a.EqualSid(ownerSid, ownerSid) !== 0 && a.EqualSid(ownerSid, worldSid) === 0, "native_sid_equality_and_mismatch");
    observations.tokenSidBytes = ownerSid.length;
    observations.nativeSidEqualityAndMismatch = true;
    observations.nativeErrorInsufficientBuffer = sizeError;

    const descriptor = (sddl: string) => {
      const address = pointerSlot(), length = u32();
      requireObserved(a.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl), 1, address, length) !== 0, "sddl_conversion");
      const value = ownAllocation(pointerOut(address));
      requireObserved(length.readUInt32LE() > 0 && length.readUInt32LE() <= W0_LIMITS.descriptorBytes, "sddl_length"); return value;
    };
    const inspect = (sd: bigint, directory: boolean) => {
      requireObserved(a.IsValidSecurityDescriptor(sd) !== 0, "security_descriptor_valid");
      const length = a.GetSecurityDescriptorLength(sd), control = Buffer.alloc(2), revision = u32();
      requireObserved(length > 0 && length <= W0_LIMITS.descriptorBytes && a.GetSecurityDescriptorControl(sd, control, revision) !== 0 && (control.readUInt16LE() & 0x8000) !== 0, "self_relative_descriptor");
      const owner = pointerSlot(), ownerDefault = u32(), present = u32(), dacl = pointerSlot(), daclDefault = u32();
      requireObserved(a.GetSecurityDescriptorOwner(sd, owner, ownerDefault) !== 0 && a.GetSecurityDescriptorDacl(sd, present, dacl, daclDefault) !== 0, "descriptor_fields");
      const ownerAddress = pointerOut(owner); checkedRange(sd, length, ownerAddress, 8);
      const ownerHeader = memory(ownerAddress, 8), ownerLength = 8 + 4 * ownerHeader[1];
      requireObserved(ownerHeader[0] === 1 && ownerHeader[1] <= 15, "descriptor_owner_header"); checkedRange(sd, length, ownerAddress, ownerLength);
      requireObserved(a.IsValidSid(ownerAddress) !== 0, "descriptor_owner_valid");
      requireObserved(a.GetLengthSid(ownerAddress) === ownerLength, "descriptor_owner_length");
      const ownerMatches = a.EqualSid(ownerAddress, ownerSid) !== 0, acl = pointerOut(dacl), aces: AllowedAce[] = [];
      if (present.readUInt32LE() !== 0 && acl !== 0n) {
        checkedRange(sd, length, acl, 8);
        const header = memory(acl, 8), aclSize = header.readUInt16LE(2); checkedRange(sd, length, acl, aclSize);
        requireObserved(a.IsValidAcl(acl) !== 0, "acl_valid");
        const info = Buffer.alloc(12); requireObserved(a.GetAclInformation(acl, info, info.length, 2) !== 0, "acl_information");
        const count = info.readUInt32LE(); requireObserved(count <= 16 && info.readUInt32LE(4) <= aclSize, "acl_bounds");
        for (let i = 0; i < count; i++) {
          const out = pointerSlot(); requireObserved(a.GetAce(acl, i, out) !== 0, "ace_pointer");
          const ace = pointerOut(out); checkedRange(acl, aclSize, ace, 8); const prefix = memory(ace, 8), size = prefix.readUInt16LE(2);
          checkedRange(acl, aclSize, ace, size); requireObserved(prefix[0] === 0 && size >= 16, "unsupported_native_ace");
          const sidHeader = memory(ace + 8n, 8), expectedSize = 8 + 4 * sidHeader[1];
          requireObserved(sidHeader[0] === 1 && sidHeader[1] <= 15, "ace_sid_header"); checkedRange(ace, size, ace + 8n, expectedSize);
          requireObserved(a.IsValidSid(ace + 8n) !== 0, "ace_sid_valid");
          const sidSize = a.GetLengthSid(ace + 8n); requireObserved(sidSize === expectedSize, "ace_sid_length");
          aces.push({ type: prefix[0], flags: prefix[1], mask: prefix.readUInt32LE(4), sid: memory(ace + 8n, sidSize) });
        }
      }
      return { accepted: ownerOnlyAcl(ownerMatches, present.readUInt32LE() !== 0, acl === 0n, (control.readUInt16LE() & 0x1000) !== 0, aces, ownerSid, directory), ownerMatches, aceCount: aces.length, nullDacl: acl === 0n, protectedDacl: (control.readUInt16LE() & 0x1000) !== 0 };
    };
    const rootSd = descriptor(`O:${ownerText}D:P(A;OICI;FA;;;${ownerText})`), fileSd = descriptor(`O:${ownerText}D:P(A;;FA;;;${ownerText})`);
    requireObserved(inspect(rootSd, true).accepted && inspect(fileSd, false).accepted, "native_positive_descriptors");
    const nullSd = descriptor(`O:${ownerText}D:NO_ACCESS_CONTROL`), emptySd = descriptor(`O:${ownerText}D:P`), extraSd = descriptor(`O:${ownerText}D:P(A;;FA;;;${ownerText})(A;;FR;;;WD)`);
    const nullObservation = inspect(nullSd, false), emptyObservation = inspect(emptySd, false), extraObservation = inspect(extraSd, false);
    requireObserved(nullObservation.nullDacl && !nullObservation.accepted && emptyObservation.aceCount === 0 && !emptyObservation.accepted && extraObservation.aceCount === 2 && !extraObservation.accepted, "native_descriptor_negative_controls");
    observations.nativeDescriptorNegatives = true;
    observations.descriptorNegativeScope = "native-SDDL/descriptor-inspection-not-other-account-filesystem-access";
    requireObserved(k.CreateDirectoryW(wide(privateDirectory), securityAttributes(rootSd)) !== 0, "private_directory_create"); directoryCreated = true;
    directoryHandle = own(k.CreateFileW(wide(privateDirectory), 0x20080, 3, null, 3, 0x02200000, 0n), "private_directory_handle");
    const volumeName = Buffer.alloc(512), fsName = Buffer.alloc(128), serial = u32(), maxComponent = u32(), flags = u32();
    requireObserved(k.GetVolumeInformationByHandleW(directoryHandle, volumeName, volumeName.length / 2, serial, maxComponent, flags, fsName, fsName.length / 2) !== 0, "volume_information");
    requireObserved(fsName.toString("utf16le").split("\0")[0] === "NTFS" && (flags.readUInt32LE() & 8) !== 0, "qualified_ntfs_persistent_acls");
    observations.filesystem = "NTFS-persistent-ACLs-observed;network/path-race-support-unqualified";
    fileHandle = own(k.CreateFileW(wide(file), 0xc0030000, 0, securityAttributes(fileSd), 1, 0x04200080, 0n), "private_file_create"); fileCreated = true;
    const fromHandle = (handle: bigint) => {
      const out = pointerSlot(), result = a.GetSecurityInfo(handle, 1, 5, null, null, null, null, out);
      requireObserved(result === 0, "handle_security_info", result); return ownAllocation(pointerOut(out));
    };
    requireObserved(inspect(fromHandle(directoryHandle), true).accepted && inspect(fromHandle(fileHandle), false).accepted, "created_handle_owner_dacl_before_bytes");
    observations.nativeOwnerOnlyFile = true;
    observations.privateAclObservedBeforePayloadWrite = true;
    const wrote = u32(); requireObserved(k.WriteFile(fileHandle, payload, payload.length, wrote, null) !== 0 && wrote.readUInt32LE() === payload.length && k.FlushFileBuffers(fileHandle) !== 0, "native_payload_write");
    const identity = Buffer.alloc(24), standard = Buffer.alloc(24), attributes = Buffer.alloc(8);
    requireObserved(k.GetFileInformationByHandleEx(fileHandle, 18, identity, identity.length) !== 0 && k.GetFileInformationByHandleEx(fileHandle, 1, standard, standard.length) !== 0 && k.GetFileInformationByHandleEx(fileHandle, 9, attributes, attributes.length) !== 0, "native_handle_metadata");
    requireObserved(k.GetFileType(fileHandle) === 1 && standard.readBigInt64LE(8) === BigInt(payload.length) && standard.readUInt32LE(16) === 1 && standard[21] === 0 && (attributes.readUInt32LE() & 0x400) === 0, "native_regular_single_link_file");
    const read = u32(), bytes = Buffer.alloc(W0_LIMITS.payloadBytes);
    requireObserved(k.SetFilePointerEx(fileHandle, 0n, null, 0) !== 0 && k.ReadFile(fileHandle, bytes, bytes.length, read, null) !== 0 && bytes.subarray(0, read.readUInt32LE()).equals(payload), "native_same_handle_read");
    observations.payloadBytes = payload.length;
    observations.sameHandleParentRead = true;
    const entered = own(k.CreateEventW(null, 1, 0, null), "entered_event"), release = own(k.CreateEventW(null, 1, 0, null), "release_event");
    const functions = Object.fromEntries(Object.keys(borrowedDefinitions).map(name => [name, functionAt(loadedKernel, name)])) as Record<BorrowedName, bigint>;
    worker = new Worker(new URL(import.meta.url), { workerData: { kind: "native-w0-borrowed-handles", file: fileHandle, entered, release, functions } satisfies BorrowedWork, env: {} });
    workerExit = new Promise<number>(resolve => worker!.once("exit", code => { workerExited = true; resolve(code); }));
    let workerError = false, waitMessage = false;
    worker.on("error", () => { workerError = true; });
    const ready = await Promise.race([
      new Promise<{ thread: number; bytes: number; sha256: string; identity: string }>(resolve => worker!.on("message", value => {
        if (value?.kind === "native-ready") resolve(value as { thread: number; bytes: number; sha256: string; identity: string });
        if (value?.kind === "native-wait-completed") waitMessage = true;
      })),
      pause(W0_LIMITS.workerMs).then(() => { throw new DiagnosticFailure("worker_ready_deadline"); }),
    ]);
    requireObserved(!workerError && !workerExited && Number.isInteger(ready.thread) && ready.thread > 0 && ready.bytes === payload.length && ready.sha256 === digest(payload) && ready.identity === identity.toString("hex"), "native_worker_borrowed_same_handle");
    observations.sameHandleWorkerRead = true;
    workerThread = own(k.OpenThread(0x100800, 0, ready.thread), "native_worker_thread_handle");
    const entryDeadline = performance.now() + W0_LIMITS.acquisitionMs;
    while (k.WaitForSingleObject(entered, 0) === WAIT_TIMEOUT && performance.now() < entryDeadline) await pause(1);
    requireObserved(k.WaitForSingleObject(entered, 0) === 0 && k.WaitForSingleObject(workerThread, 0) === WAIT_TIMEOUT, "native_signal_and_wait_started");
    const acquisitionStarted = performance.now(); let heartbeat = false;
    const heartbeatTimer = setTimeout(() => { heartbeat = true; }, 10);
    await pause(W0_LIMITS.acquisitionMs); clearTimeout(heartbeatTimer);
    const elapsed = performance.now() - acquisitionStarted;
    requireObserved(heartbeat && elapsed < 250 && !waitMessage && !workerExited && k.WaitForSingleObject(workerThread, 0) === WAIT_TIMEOUT, "main_deadline_during_pending_native_wait");
    observations.mainDeadlineWhileNativeWaitPending = true;
    observations.mainDeadlineElapsedMs = Math.round(elapsed);
    const terminationStarted = performance.now();
    await Promise.race([worker.terminate().then(() => workerExit!), pause(W0_LIMITS.workerMs).then(() => { throw new DiagnosticFailure("worker_termination_deadline"); })]);
    requireObserved(workerExited && !workerError && k.WaitForSingleObject(workerThread, 0) === 0, "actual_native_thread_exit");
    cleanup.nativeThreadSignaled = true;
    observations.terminationElapsedMs = Math.round(performance.now() - terminationStarted);
    observations.terminationScope = "finite-600ms-native-wait;not-general-cancellation";
    const finalIdentity = Buffer.alloc(24);
    requireObserved(k.GetFileInformationByHandleEx(fileHandle, 18, finalIdentity, finalIdentity.length) !== 0 && finalIdentity.equals(identity) && inspect(fromHandle(fileHandle), false).accepted, "same_native_handle_after_worker_exit");
    close(fileHandle); fileHandle = 0n;
    cleanup.privateFileAbsent = k.GetFileAttributesW(wide(file)) === 0xffffffff && k.GetLastError() === 2;
    requireObserved(cleanup.privateFileAbsent, "delete_on_close_file_absence");
    report.status = "OBSERVED_NATIVE_WINDOWS";
  } catch (error) {
    report.failure = error instanceof DiagnosticFailure ? { stage: error.stage, nativeCode: error.nativeCode } : { stage: "native_binding_or_probe_exception" };
  } finally {
    if (worker && !workerExited) {
      try { await Promise.race([worker.terminate().then(() => workerExit!), pause(W0_LIMITS.workerMs).then(() => { throw new DiagnosticFailure("cleanup_worker_deadline"); })]); }
      catch { report.failure ??= { stage: "cleanup_worker_deadline" }; }
    }
    if (workerThread !== 0n && workerExited) cleanup.nativeThreadSignaled = k.WaitForSingleObject(workerThread, 0) === 0;
    const canClose = !worker || workerExited && workerThread !== 0n && cleanup.nativeThreadSignaled;
    if (canClose) {
      for (const handle of [...handles]) { try { close(handle); } catch { report.failure ??= { stage: "handle_cleanup" }; } }
      for (const address of [...allocations]) {
        if (k.LocalFree(address) === 0n) { allocations.delete(address); cleanup.allocationsFreed++; }
        else report.failure ??= { stage: "native_allocation_cleanup" };
      }
      if (fileCreated) cleanup.privateFileAbsent = k.GetFileAttributesW(wide(file)) === 0xffffffff && k.GetLastError() === 2;
      if (directoryCreated) cleanup.privateDirectoryRemoved = k.RemoveDirectoryW(wide(privateDirectory)) !== 0;
      cleanup.syntheticParentEmpty = readdirSync(syntheticRoot).length === 0;
      closeAdvapi?.();
      if (advapiModule !== 0n && k.FreeLibrary(advapiModule) === 0) report.failure ??= { stage: "module_cleanup" };
      kernel.close();
      cleanup.complete = handles.size === 0 && allocations.size === 0 && (!worker || cleanup.nativeThreadSignaled) && (!fileCreated || cleanup.privateFileAbsent) && (!directoryCreated || cleanup.privateDirectoryRemoved) && cleanup.syntheticParentEmpty;
    }
    if (!cleanup.complete || report.failure) report.status = "ERROR_NATIVE_WINDOWS";
  }
  return report;
}

if (!isMainThread) {
  await borrowedWorker();
} else {
  let result: unknown;
  try {
    requireObserved(process.argv.length === 4 && process.argv[2] === "--synthetic-root", "diagnostic_arguments");
    result = await nativeProbe(process.argv[3]);
  } catch (error) {
    result = { diagnostic: "windows-private-files-w0/v1", status: "ERROR_NATIVE_WINDOWS", qualification: "DIAGNOSTIC_ONLY_NOT_PRODUCTION_AUTHORITY", failure: { stage: error instanceof DiagnosticFailure ? error.stage : "native_setup_exception" } };
  }
  await Bun.write(Bun.stdout, JSON.stringify(result) + "\n");
  process.exit((result as { status: string }).status === "OBSERVED_NATIVE_WINDOWS" ? 0 : 1);
}
