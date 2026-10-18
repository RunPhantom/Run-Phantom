import { mock } from "bun:test";
import * as sqlite from "bun:sqlite";
import type { Database, DatabaseOptions, Statement } from "bun:sqlite";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

export type FaultNode = "control" | "K1" | "K2" | "K3" | "K4" | "T1" | "T2" | "T3-before" | "T3-after" | "T4" | "T5" | "T6" | "T7" | "L1-before" | "L1-after" | "L2-before" | "L2-after" | "Q1" | "Q2" | "Q3" | "O1" | "T3-native-before" | "L1-native-before";
export type SelectedErrorVariant = "readonly-rollback776";
type Phase = "ro" | "guarded" | "startup";
export interface FaultEvent {
  kind: "constructor" | "prepare-control" | "control" | "query" | "exec" | "close" | "readback";
  operation: "main" | "recovery";
  connection: number;
  phase: Phase;
  options: DatabaseOptions;
  sql?: string;
  guard?: number;
  inTransaction?: boolean;
  inTransactionAfter?: boolean;
  attempted: boolean;
  nativeExecuted: boolean;
  nativeSucceeded: boolean;
  fault?: "eligibility" | "selected" | "probe-prerequisite";
  error?: string;
  errorCode?: unknown;
  errorErrno?: unknown;
  selectedErrorIdentity?: { label: string; sameSelectedObject: boolean; isError: boolean; target: string };
}
interface Handle { db: Database; connection: number; phase: Phase; options: DatabaseOptions; closed: boolean; }
export interface FaultReceipt {
  node: FaultNode;
  runtime: { bun: string; revision: string; platform: string; sqlite: unknown };
  setupError?: string;
  operationError?: string;
  cleanupError?: string;
  accepted: boolean;
  nativePrototypeIdentity: boolean;
  preservedExports: boolean;
  prepareOwnedMatches: number;
  eligibilityHits: number;
  selectedHits: number;
  probePrerequisiteHits: number;
  eligibilityErrorDistinctFromSelected?: boolean;
  publicErrorSameAsSelected?: boolean;
  events: FaultEvent[];
  outstandingBeforeTeardown: number[];
  teardown: Array<{ connection: number; nativeExecuted: boolean; nativeSucceeded: boolean; error?: string }>;
  outstandingAfterTeardown: number[];
  failedOperationSnapshot?: { schema: unknown[]; history: unknown[]; data: Record<string, unknown[]> };
  recovery?: { accepted: boolean; error?: string; events: FaultEvent[] };
}

// Copy values before mock.module: retaining only the namespace would retain live bindings.
const nativeExports = { ...sqlite };
const NativeDatabase = nativeExports.Database;
const nativePrototype = NativeDatabase.prototype;
const nativeQuery = Object.getOwnPropertyDescriptor(nativePrototype, "query")!.value as Database["query"];
const nativePrepare = Object.getOwnPropertyDescriptor(nativePrototype, "prepare")!.value as Database["prepare"];
const nativeExec = Object.getOwnPropertyDescriptor(nativePrototype, "exec")!.value as Database["exec"];
const nativeClose = Object.getOwnPropertyDescriptor(nativePrototype, "close")!.value as Database["close"];
const probe = "SELECT name FROM sqlite_master LIMIT 1";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const nativeLooking = (text: string) => Object.assign(new Error(text), { code: "SQLITE_CANTOPEN", errno: 14 });

async function run(node: FaultNode, filename: string, selectedErrorVariant?: SelectedErrorVariant): Promise<FaultReceipt> {
  assert(selectedErrorVariant === undefined || selectedErrorVariant === "readonly-rollback776"
    && ["K1", "Q1", "T3-native-before", "L1-native-before"].includes(node), "unsupported selected error variant or boundary");
  const identity = new NativeDatabase(":memory:");
  let engine: unknown;
  try { engine = nativeQuery.call(identity, "SELECT sqlite_version() AS version,sqlite_source_id() AS source_id").get(); }
  finally { nativeClose.call(identity, true); }
  const receipt: FaultReceipt = {
    node, runtime: { bun: Bun.version, revision: Bun.revision, platform: process.platform, sqlite: engine },
    accepted: false, nativePrototypeIdentity: true, preservedExports: false, prepareOwnedMatches: 0,
    eligibilityHits: 0, selectedHits: 0, probePrerequisiteHits: 0, events: [],
    outstandingBeforeTeardown: [], teardown: [], outstandingAfterTeardown: [],
  };
  const fallback = new Set<FaultNode>(["K2", "T2", "T3-before", "T3-after", "T5", "T7", "L1-before", "L1-after", "L2-before", "L2-after", "Q1", "Q2", "Q3", "O1"]);
  const selectedNativeError = selectedErrorVariant ? Object.assign(new Error(`component selected ${node}`), { code: "SQLITE_READONLY_ROLLBACK", errno: 776 })
    : node === "T3-native-before" || node === "L1-native-before" ? nativeLooking(`component selected ${node}`) : undefined;
  if (node === "T3-native-before" || node === "L1-native-before") fallback.add(node);
  const handles = new Map<Database, Handle>();
  let nextConnection = 0, operation: "main" | "recovery" = "main", injections = true;
  let restorers: Array<() => void> = [];
  const transactionState = (db: Database) => { try { return db.inTransaction; } catch { return undefined; } };
  const guard = (db: Database) => {
    // A distinct uncached native statement cannot consume the selected product .get fault.
    const statement = nativePrepare.call(db, "PRAGMA query_only");
    try { return (statement.get() as { query_only: number }).query_only; } finally { statement.finalize(); }
  };
  const event = (kind: FaultEvent["kind"], handle: Handle, sql?: string): FaultEvent => {
    const value: FaultEvent = {
      kind, operation, connection: handle.connection, phase: handle.phase, options: { ...handle.options },
      ...(sql === undefined ? {} : { sql }), ...(handle.phase === "guarded" ? { guard: guard(handle.db) } : {}),
      inTransaction: transactionState(handle.db), attempted: true, nativeExecuted: false, nativeSucceeded: false,
    };
    receipt.events.push(value); return value;
  };
  const execute = <T>(value: FaultEvent, action: () => T, before = false, after = false): T => {
    try {
      if (injections && before && selectedNativeError) { value.fault = "selected"; receipt.selectedHits++; throw selectedNativeError; }
      if (injections && before) { value.fault = "selected"; receipt.selectedHits++; throw node === "Q1" ? nativeLooking(`component selected ${node}`) : new Error(`component selected ${node}`); }
      value.nativeExecuted = true;
      const result = action(); value.nativeSucceeded = true;
      if (injections && after) { value.fault = "selected"; receipt.selectedHits++; throw new Error(`component selected ${node} after native completion`); }
      return result;
    } catch (error) {
      value.error = message(error);
      if (selectedNativeError && value.fault === "selected") value.selectedErrorIdentity = { label: `selected-native:${node}`, sameSelectedObject: error === selectedNativeError, isError: error instanceof Error, target: filename };
      if (error && typeof error === "object") { value.errorCode = (error as { code?: unknown }).code; value.errorErrno = (error as { errno?: unknown }).errno; }
      throw error;
    }
  };
  const replace = (target: object, key: PropertyKey, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    assert(descriptor, `missing own descriptor ${String(key)}`);
    Object.defineProperty(target, key, { ...descriptor, value });
    restorers.push(() => Object.defineProperty(target, key, descriptor));
  };
  const restore = () => { for (const undo of restorers.reverse()) undo(); restorers = []; };
  const teardown = () => {
    for (const handle of handles.values()) if (!handle.closed) {
      const record: FaultReceipt["teardown"][number] = { connection: handle.connection, nativeExecuted: true, nativeSucceeded: false };
      receipt.teardown.push(record);
      try { nativeClose.call(handle.db, true); handle.closed = true; record.nativeSucceeded = true; }
      catch (error) { record.error = message(error); receipt.cleanupError = message(error); }
    }
  };
  try {
    const symbols = Object.getOwnPropertySymbols(nativePrototype).filter(symbol => symbol.description === "prepareOwned"
      && typeof Object.getOwnPropertyDescriptor(nativePrototype, symbol)?.value === "function");
    receipt.prepareOwnedMatches = symbols.length;
    assert.equal(symbols.length, 1, "unsupported runtime: exactly one callable prepareOwned Symbol required");
    const ownedSymbol = symbols[0];
    type OwnedPrepare = (this: Database, sql: string, flags: number) => Statement;
    const nativeOwned = Object.getOwnPropertyDescriptor(nativePrototype, ownedSymbol)!.value as OwnedPrepare;
    const install = () => {
      const readbacks = new Set<Statement>();
      replace(nativePrototype, ownedSymbol, function (this: Database, sql: string, flags: number) {
        const statement = nativeOwned.call(this, sql, flags), handle = handles.get(this);
        if (!handle || !["BEGIN", "BEGIN DEFERRED", "BEGIN IMMEDIATE", "BEGIN EXCLUSIVE", "COMMIT", "ROLLBACK"].includes(sql)) return statement;
        const prepared = event("prepare-control", handle, sql); prepared.nativeExecuted = true; prepared.nativeSucceeded = true;
        const runDescriptor = Object.getOwnPropertyDescriptor(statement, "run");
        assert(runDescriptor && typeof runDescriptor.value === "function", "controller Statement must own callable run");
        const nativeRun = runDescriptor.value as Statement["run"];
        replace(statement, "run", function (this: Statement, ...args: Parameters<Statement["run"]>) {
          const value = event("control", handle, sql);
          const before = sql === "BEGIN" && (node === "T1" && handle.phase === "ro" || node === "T2" && handle.phase === "guarded")
            || sql === "COMMIT" && (handle.phase === "ro" && ["T3-before", "T4"].includes(node) || node === "T5" && handle.phase === "guarded")
            || sql === "ROLLBACK" && (node === "T6" && handle.phase === "ro" || node === "T7" && handle.phase === "guarded");
          const nativeBefore = node === "T3-native-before" && sql === "COMMIT" && handle.phase === "ro";
          try { return execute(value, () => nativeRun.apply(this, args), before || nativeBefore, node === "T3-after" && sql === "COMMIT" && handle.phase === "ro"); }
          finally { value.inTransactionAfter = transactionState(handle.db); }
        });
        return statement;
      });
      replace(nativePrototype, "query", function (this: Database, sql: string) {
        const handle = handles.get(this);
        if (!handle) return nativeQuery.call(this, sql);
        const value = event("query", handle, sql);
        if (injections && handle.phase === "ro" && sql === probe && fallback.has(node)) {
          receipt.eligibilityHits++; value.fault = "eligibility"; value.error = "forced own RO probe eligibility"; value.errorCode = "SQLITE_CANTOPEN"; value.errorErrno = 14;
          if (selectedNativeError) {
            const eligibilityError = nativeLooking(value.error);
            receipt.eligibilityErrorDistinctFromSelected = eligibilityError !== selectedNativeError;
            throw eligibilityError;
          }
          throw nativeLooking(value.error);
        }
        if (injections && handle.phase === "guarded" && sql === probe && node === "T7") {
          receipt.probePrerequisiteHits++; value.fault = "probe-prerequisite"; value.error = "forced guarded probe prerequisite"; value.errorCode = "SQLITE_CANTOPEN"; value.errorErrno = 14;
          throw nativeLooking(value.error);
        }
        const statement = execute(value, () => nativeQuery.call(this, sql), node === "Q1" && handle.phase === "guarded" && sql === probe);
        if (handle.phase === "guarded" && sql === "PRAGMA query_only" && !readbacks.has(statement)) {
          readbacks.add(statement);
          const getDescriptor = Object.getOwnPropertyDescriptor(statement, "get");
          assert(getDescriptor && typeof getDescriptor.value === "function", "product readback must own callable get");
          const nativeGet = getDescriptor.value as Statement["get"];
          replace(statement, "get", function (this: Statement, ...args: Parameters<Statement["get"]>) {
            const readback = event("readback", handle, sql);
            const result = execute(readback, () => nativeGet.apply(this, args), node === "Q3" && readback.guard === 0);
            if ((result as { query_only: number }).query_only === 0) handle.phase = "startup";
            return result;
          });
        }
        return statement;
      });
      replace(nativePrototype, "exec", function (this: Database, sql: string) {
        const handle = handles.get(this);
        if (!handle) return nativeExec.call(this, sql);
        const value = event("exec", handle, sql);
        return execute(value, () => nativeExec.call(this, sql), node === "Q2" && sql === "PRAGMA query_only = OFF" && handle.phase === "guarded"
          || node === "O1" && handle.phase === "startup" && sql === "PRAGMA busy_timeout = 1000");
      });
      replace(nativePrototype, "close", function (this: Database, ...args: Parameters<Database["close"]>) {
        const handle = handles.get(this);
        if (!handle) return nativeClose.apply(this, args);
        const value = event("close", handle);
        const selectedPhase = node.startsWith("L1-") && handle.phase === "ro" || node.startsWith("L2-") && handle.phase === "guarded";
        return execute(value, () => { const result = nativeClose.apply(this, args); handle.closed = true; return result; }, selectedPhase && node.endsWith("before"), selectedPhase && node.endsWith("after"));
      });
    };
    const ProductDatabase = new Proxy(NativeDatabase, {
      construct(_target, args: unknown[]) {
        if (args[0] !== filename) {
          const db = Reflect.construct(NativeDatabase, args, NativeDatabase) as Database;
          receipt.nativePrototypeIdentity &&= Object.getPrototypeOf(db) === nativePrototype; return db;
        }
        const options = { ...(args[1] as DatabaseOptions) }, connection = ++nextConnection;
        const phase: Phase = options.readonly ? "ro" : injections && fallback.has(node) ? "guarded" : "startup";
        const value: FaultEvent = { kind: "constructor", operation, connection, phase, options, attempted: true, nativeExecuted: false, nativeSucceeded: false };
        receipt.events.push(value);
        const selected = node === "K1" && options.readonly || ["K2", "K3"].includes(node) && connection === 2 || node === "K4";
        if (injections && selected && !selectedErrorVariant) {
          value.fault = "selected"; receipt.selectedHits++; value.error = `component selected ${node}`; value.errorCode = "SQLITE_CANTOPEN"; value.errorErrno = 14;
          throw nativeLooking(value.error);
        }
        return execute(value, () => {
          const db = Reflect.construct(NativeDatabase, args, NativeDatabase) as Database;
          receipt.nativePrototypeIdentity &&= Object.getPrototypeOf(db) === nativePrototype;
          handles.set(db, { db, connection, phase, options, closed: false }); return db;
        }, selected && selectedErrorVariant !== undefined);
      },
    });
    const replacement: Record<string, unknown> = { ...nativeExports, Database: ProductDatabase };
    const defaultValue: unknown = nativeExports.default;
    if (defaultValue === NativeDatabase) replacement.default = ProductDatabase;
    else if (defaultValue && typeof defaultValue === "object") replacement.default = Object.fromEntries(Object.entries(defaultValue).map(([key, value]) => [key, value === NativeDatabase ? ProductDatabase : value]));
    receipt.preservedExports = Object.keys(replacement).sort().join() === Object.keys(nativeExports).sort().join()
      && Object.entries(nativeExports).every(([key, value]) => key === "Database" || key === "default" || replacement[key] === value);
    assert(receipt.preservedExports, "native export shape not preserved");
    await mock.module("bun:sqlite", () => replacement);
    install();
    const product = await import("../../src/db");
    try { product.getDrizzleDb(); receipt.accepted = true; }
    catch (error) {
      receipt.operationError = message(error);
      if (selectedNativeError) receipt.publicErrorSameAsSelected = error === selectedNativeError;
    }
    // Capture the failed operation before restoring spies or releasing outstanding native handles.
    receipt.outstandingBeforeTeardown = [...handles.values()].filter(handle => !handle.closed).map(handle => handle.connection);
    if (node === "control" && receipt.accepted) product.closeDb();
    restore();
    teardown();
    if (node === "O1") {
      assert.equal(receipt.selectedHits, 1); assert.equal(receipt.accepted, false);
      assert.equal(receipt.outstandingBeforeTeardown.length, 0, "failed operation must close transferred handle before recovery");
      const failedEvents = receipt.events.filter(value => value.operation === "main");
      assert.equal(failedEvents.filter(value => value.kind === "constructor").length, 2);
      assert.equal(failedEvents.filter(value => value.kind === "close" && value.nativeSucceeded).length, 2);
      assert(!failedEvents.some(value => value.kind === "exec" && value.sql && /journal_mode|^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(value.sql)));
      const reader = new NativeDatabase(filename, { readwrite: true, create: false });
      try {
        const schema = nativeQuery.call(reader, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all() as Array<{ type: string; name: string }>;
        receipt.failedOperationSnapshot = { schema,
          history: nativeQuery.call(reader, "SELECT rowid AS receipt_rowid,id,hash,created_at FROM __drizzle_migrations ORDER BY rowid").all(),
          data: Object.fromEntries(schema.filter(row => row.type === "table" && row.name !== "__drizzle_migrations").map(row => [row.name,
            nativeQuery.call(reader, `SELECT rowid AS source_rowid,* FROM "${row.name.replace(/"/g, '""')}" ORDER BY rowid`).all()])),
        };
      } finally { nativeClose.call(reader, true); }
      operation = "recovery"; injections = false; install();
      const start = receipt.events.length;
      const recovery: NonNullable<FaultReceipt["recovery"]> = { accepted: false, events: [] };
      try { product.getDrizzleDb(); recovery.accepted = true; product.closeDb(); }
      catch (error) { recovery.error = message(error); }
      finally { recovery.events = receipt.events.slice(start); restore(); teardown(); }
      receipt.recovery = recovery;
    }
  } catch (error) { receipt.setupError = message(error); }
  finally {
    try { restore(); } catch (error) { receipt.cleanupError = message(error); }
    teardown();
    receipt.outstandingAfterTeardown = [...handles.values()].filter(handle => !handle.closed).map(handle => handle.connection);
  }
  return receipt;
}

if (import.meta.main) {
  const [node, filename, output, selectedErrorVariant] = process.argv.slice(2);
  assert(node && filename && output, "node, owned target and receipt path required");
  const receipt = await run(node as FaultNode, filename, selectedErrorVariant as SelectedErrorVariant | undefined);
  writeFileSync(output, JSON.stringify(receipt));
  if (receipt.setupError || receipt.cleanupError) process.exitCode = 1;
}
