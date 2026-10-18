import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";

// Frozen C0..C8 + S: actual SQL is executed and independently checked, not mocked.
const legacy = [
  ["0000_massive_winter_soldier", 1778475472563, "52899c23e0fdf365b2d0e283f11207d8406fd8e3f01acc9f83567d81e279730d"],
  ["0001_cynical_betty_brant", 1778475541625, "c48b564e9ed782d25276077b04a2e207f3f15886245b24a40efff4c274ae4702"],
  ["0002_flowery_shinobi_shaw", 1787429370282, "c761f4aab08c1e08add602bb96a4a70417d1fb4e319544b9dd00a7d0f4bb7010"],
  ["0003_span_identity_per_run", 1787429370283, "7b1e1d7c2d46d593bace5b085b5ece7d91437fc2c49083ad32b8c48017323c11"],
  ["0004_spotty_thunderbolt", 1788822552935, "7299fbdf12b94a15842eb869631ba9d16fedb4efd01785590773d5919c31c1d8"],
  ["0005_sweet_smasher", 1788823828928, "22639daefc1ccbad932e1cb6beabe2a1f8f9fea44de58083f8b31c3189948707"],
  ["0006_lying_proemial_gods", 1788826316549, "a5e09300f1b4500900c3833a8ed7dfb844adf078fb133ca802544dc2ddd7dcdc"],
  ["0007_evidence_storage", 1791756634149, "aef0ee70d71c0ba6bd84061cdd07032455e18f688f0aef2938050be29e00b586"],
  ["0008_otlp_evidence", 1791757794360, "bca976855ea092b54886964466fb7447612cbbfb8c84133565972409a6174069"],
  ["0014_semantic_snapshots", 1791773224836, "69fc773324ff10dda96832470c1e1c5aeb8205f590165ce7f0e116af891f245e"],
] as const;
const probe = "SELECT name FROM sqlite_master LIMIT 1";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function snapshot(db: Database) {
  return {
    schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all(),
    history: db.query("SELECT rowid AS receipt_rowid,id,hash,created_at FROM __drizzle_migrations ORDER BY rowid").all(),
    data: ["runs", "spans", "verification_snapshots"].map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()),
  };
}
function readSnapshot(filename: string) {
  const db = new Database(filename, { readwrite: true, create: false });
  try { return snapshot(db); } finally { db.close(true); }
}
function fixture(work: (value: { filename: string; writer: Database; before: ReturnType<typeof snapshot>; settle: () => void }) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), "semantic-startup-")), filename = path.join(directory, "owner.sqlite"), prior = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = filename;
  let writer: Database | null = new Database(filename);
  try {
    writer.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
    writer.exec('CREATE TABLE "__drizzle_migrations" (\n\t\t\t\tid SERIAL PRIMARY KEY,\n\t\t\t\thash text NOT NULL,\n\t\t\t\tcreated_at numeric\n\t\t\t)');
    const db = writer;
    db.transaction(() => {
      for (const [tag, when, hash] of legacy) {
        const sql = readFileSync(path.resolve(import.meta.dir, "../drizzle", tag + ".sql")); expect(digest(sql)).toBe(hash);
        for (const statement of sql.toString("utf8").split("--> statement-breakpoint")) db.exec(statement);
        db.query("INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)").run(hash, when);
      }
    }).immediate();
    db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF");
    db.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('retained',1,2)");
    db.query("INSERT INTO spans(run_id,id,name,output_payload,otlp_evidence) VALUES('retained','span','retained',?,?)").run('{"exact":"α\\n"}', '{"reported":"retained"}');
    db.query("INSERT INTO verification_snapshots VALUES('snapshot','retained',NULL,'retained','https://example.test',1,2,'imported-evidence',?,?,?)").run("a".repeat(64), "b".repeat(64), '{"exact":"β\\r\\n"}');
    db.exec("UPDATE __drizzle_migrations SET rowid=rowid+100; UPDATE __drizzle_migrations SET id=700 WHERE created_at=1778475472563; UPDATE __drizzle_migrations SET id='original-S' WHERE created_at=1791773224836");
    work({ filename, writer: db, before: snapshot(db), settle: () => { writer!.close(true); writer = null; } });
  } finally {
    closeDb(); writer?.close(true);
    if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior;
    rmSync(directory, { recursive: true, force: true });
  }
}

interface Event { kind: "query" | "exec" | "close"; connection: number; sql?: string; guard?: number; }
interface ObservationOptions {
  firstProbeError?: unknown;
  helperError?: Error;
  readback?: "on-zero" | "on-missing" | "off-stuck";
  guardSetError?: boolean;
  denyWritesDuringHelper?: boolean;
  afterFirstClose?: () => void;
}
const nativeError = (code = "SQLITE_CANTOPEN", errno = 14) => Object.assign(new Error("controlled native probe error"), { code, errno });
// These spies observe real SQLite work; injected errors are component routing evidence only.
function observe(filename: string, options: ObservationOptions = {}) {
  const nativeQuery = Object.getOwnPropertyDescriptor(Database.prototype, "query")!.value as Database["query"];
  const nativeExec = Object.getOwnPropertyDescriptor(Database.prototype, "exec")!.value as Database["exec"];
  const nativeClose = Object.getOwnPropertyDescriptor(Database.prototype, "close")!.value as Database["close"];
  const events: Event[] = [], nativeProbeErrors: Array<{ code: unknown; errno: unknown }> = [], ids = new Map<Database, number>(), restoreGet: Array<{ mockRestore: () => void }> = [];
  let probes = 0, closes = 0, guardedConnection: number | undefined, guardedReads = 0, deniedWrites = 0, helperFaultUsed = false, checkedWriteDenials = false;
  const id = (db: Database) => { if (!ids.has(db)) ids.set(db, ids.size + 1); return ids.get(db)!; };
  const guard = (db: Database) => (nativeQuery.call(db, "PRAGMA query_only").get() as { query_only: number }).query_only;
  const query = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
    if (this.filename !== filename) return nativeQuery.call(this, sql);
    const isGuarded = id(this) === guardedConnection;
    events.push({ kind: "query", connection: id(this), sql, ...(isGuarded ? { guard: guard(this) } : {}) });
    if (sql === probe) {
      probes++;
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- The fixture deliberately throws a non-Error to verify fail-closed routing.
      if (probes === 1 && options.firstProbeError) throw options.firstProbeError;
    }
    if (sql.includes("SELECT type,name,tbl_name,")) {
      if (options.helperError && !helperFaultUsed) { helperFaultUsed = true; throw options.helperError; }
      if (isGuarded) {
        guardedReads++;
        if (options.denyWritesDuringHelper && !checkedWriteDenials) {
          checkedWriteDenials = true;
          for (const statement of [
            "CREATE TABLE denied_fixture(value text)", "ALTER TABLE runs ADD denied_fixture text", "DROP TABLE verification_snapshots",
            "INSERT INTO runs(id,started_at,last_updated_at) VALUES('denied',1,2)", "UPDATE runs SET name='denied' WHERE id='retained'", "DELETE FROM spans WHERE run_id='retained'",
          ]) { expect(() => nativeExec.call(this, statement)).toThrow("readonly"); deniedWrites++; }
        }
      }
    }
    let statement: ReturnType<Database["query"]>;
    try { statement = nativeQuery.call(this, sql); }
    catch (error) {
      if (sql === probe) nativeProbeErrors.push({ code: (error as { code?: unknown }).code, errno: (error as { errno?: unknown }).errno });
      throw error;
    }
    if (isGuarded && sql === "PRAGMA query_only" && options.readback) {
      const value = guard(this);
      if (value === 1 && options.readback !== "off-stuck") {
        restoreGet.push(spyOn(statement, "get").mockImplementationOnce(() => (options.readback === "on-zero" ? { query_only: 0 } : {}) as never));
      } else if (value === 0 && options.readback === "off-stuck") {
        restoreGet.push(spyOn(statement, "get").mockImplementationOnce(() => ({ query_only: 1 }) as never));
      }
    }
    return statement;
  });
  const exec = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string) {
    if (this.filename === filename) events.push({ kind: "exec", connection: id(this), sql, ...(id(this) === guardedConnection ? { guard: guard(this) } : {}) });
    if (this.filename === filename && sql === "PRAGMA query_only = ON" && options.guardSetError) throw new Error("controlled query_only setup failure");
    const result = nativeExec.call(this, sql);
    if (this.filename === filename && sql === "PRAGMA query_only = ON") guardedConnection = id(this);
    return result;
  });
  const close = spyOn(Database.prototype, "close").mockImplementation(function (this: Database, ...args: Parameters<Database["close"]>) {
    const target = this.filename === filename;
    if (target) events.push({ kind: "close", connection: id(this) });
    const result = nativeClose.apply(this, args);
    if (target && ++closes === 1) options.afterFirstClose?.();
    return result;
  });
  return {
    events, nativeProbeErrors,
    get probes() { return probes; }, get guardedReads() { return guardedReads; }, get deniedWrites() { return deniedWrites; },
    restore() { for (const item of restoreGet.reverse()) item.mockRestore(); close.mockRestore(); exec.mockRestore(); query.mockRestore(); },
  };
}
type Observation = ReturnType<typeof observe>;
const guardEvents = (seen: Observation, value: "ON" | "OFF") => seen.events.filter(event => event.kind === "exec" && event.sql === "PRAGMA query_only = " + value);
const applicationWrites = (seen: Observation) => seen.events.filter(event => event.sql && /^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/.test(event.sql));
function preserved(db: Database, before: ReturnType<typeof snapshot>) {
  const after = snapshot(db); expect(after.data).toEqual(before.data);
  for (const receipt of before.history) expect(after.history).toContainEqual(receipt);
  expect(after.history).toHaveLength(15); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}

test("real cold WAL startup preserves populated semantic history after writer and sidecars close", () => fixture(({ filename, writer, before, settle }) => {
  writer.exec("PRAGMA journal_mode=WAL"); settle();
  expect(existsSync(filename + "-wal")).toBe(false); expect(existsSync(filename + "-shm")).toBe(false);
  const seen = observe(filename);
  try {
    preserved(getDrizzleDb().$client, before);
    if (seen.nativeProbeErrors.length) {
      expect(seen.nativeProbeErrors).toEqual([{ code: "SQLITE_CANTOPEN", errno: 14 }]); expect(guardEvents(seen, "ON")).toHaveLength(1);
    } else expect(guardEvents(seen, "ON")).toHaveLength(0);
    console.info(JSON.stringify({ fixture: "actual-cold-wal", platform: process.platform, nativeProbeErrors: seen.nativeProbeErrors, fallbackCount: guardEvents(seen, "ON").length }));
  } finally { seen.restore(); }
}));

test("real committed live WAL rows are visible and preserved while the owned writer stays open", () => fixture(({ filename, writer }) => {
  writer.exec("PRAGMA journal_mode=WAL"); writer.exec("PRAGMA wal_autocheckpoint=0");
  const mainBefore = digest(readFileSync(filename));
  writer.transaction(() => {
    writer.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('wal-committed',3,4)");
    writer.query("INSERT INTO verification_snapshots VALUES('wal-snapshot','wal-committed',NULL,'committed','https://example.test',3,4,'imported-evidence',?,?,?)").run("c".repeat(64), "d".repeat(64), '{"committed":"live WAL α"}');
  }).immediate();
  expect(existsSync(filename + "-wal")).toBe(true); expect(statSync(filename + "-wal").size).toBeGreaterThan(32); expect(digest(readFileSync(filename))).toBe(mainBefore);
  const committed = snapshot(writer), seen = observe(filename);
  try {
    const db = getDrizzleDb().$client; preserved(db, committed);
    expect(db.query("SELECT payload FROM verification_snapshots WHERE id='wal-snapshot'").get()).toEqual({ payload: '{"committed":"live WAL α"}' });
    console.info(JSON.stringify({ fixture: "actual-committed-live-wal", nativeProbeErrors: seen.nativeProbeErrors, fallbackCount: guardEvents(seen, "ON").length }));
  } finally { seen.restore(); }
}));

test("healthy genuine read-only preflight validates without selecting guarded fallback", () => fixture(({ filename, before, settle }) => {
  settle(); const seen = observe(filename);
  try {
    preserved(getDrizzleDb().$client, before);
    expect(guardEvents(seen, "ON")).toHaveLength(0); expect(seen.nativeProbeErrors).toEqual([]);
    expect(seen.events.some(event => event.connection === 1 && event.sql?.includes("SELECT type,name,tbl_name,"))).toBe(true);
  } finally { seen.restore(); }
}));

test("real cold WAL strict receipt refusal preserves logical state without publishing migration writes", () => fixture(({ filename, writer, settle }) => {
  writer.exec("UPDATE __drizzle_migrations SET hash='unknown' WHERE created_at=1791773224836");
  const before = snapshot(writer); writer.exec("PRAGMA journal_mode=WAL"); settle();
  expect(existsSync(filename + "-wal")).toBe(false); expect(existsSync(filename + "-shm")).toBe(false);
  const physicalBefore = digest(readFileSync(filename)), seen = observe(filename);
  try {
    expect(() => getDrizzleDb()).toThrow("Unrecognized legacy semantic migration");
    expect(applicationWrites(seen)).toHaveLength(0); expect(guardEvents(seen, "OFF")).toHaveLength(0);
    console.info(JSON.stringify({ fixture: "actual-cold-wal-refusal", nativeProbeErrors: seen.nativeProbeErrors, fallbackCount: guardEvents(seen, "ON").length, mainBytesUnchangedInThisFixture: digest(readFileSync(filename)) === physicalBefore }));
  } finally { seen.restore(); }
  expect(readSnapshot(filename)).toEqual(before);
}));

test("component forced probe CANTOPEN keeps query_only ON through strict validation and blocks six real writes", () => fixture(({ filename, before, settle }) => {
  settle(); const seen = observe(filename, { firstProbeError: nativeError(), denyWritesDuringHelper: true });
  try {
    const db = getDrizzleDb().$client; preserved(db, before);
    expect(guardEvents(seen, "ON")).toHaveLength(1); expect(guardEvents(seen, "OFF")).toHaveLength(1); expect(seen.deniedWrites).toBe(6); expect(seen.guardedReads).toBeGreaterThan(0);
    const on = seen.events.findIndex(event => event.sql === "PRAGMA query_only = ON"), off = seen.events.findIndex(event => event.sql === "PRAGMA query_only = OFF");
    expect(off).toBeGreaterThan(on);
    const reads = seen.events.slice(on + 1, off).filter(event => event.kind === "query");
    expect(reads.length).toBeGreaterThan(3); for (const event of reads) expect(event.guard).toBe(1);
    expect(reads.some(event => event.sql === "PRAGMA integrity_check(1)")).toBe(true); expect(reads.some(event => event.sql === "SELECT 1 FROM pragma_foreign_key_check LIMIT 1")).toBe(true);
    expect(seen.events.findIndex(event => event === applicationWrites(seen)[0])).toBeGreaterThan(off);
    expect(db.query("PRAGMA query_only").get()).toEqual({ query_only: 0 });
  } finally { seen.restore(); }
}));

for (const readback of ["on-zero", "on-missing", "off-stuck"] as const) test(`component query_only ${readback} readback refuses before migrations`, () => fixture(({ filename, before, settle }) => {
  settle(); const seen = observe(filename, { firstProbeError: nativeError(), readback });
  try {
    expect(() => getDrizzleDb()).toThrow(readback === "off-stuck" ? "Unable to leave" : "Unable to establish");
    expect(applicationWrites(seen)).toHaveLength(0); expect(guardEvents(seen, "ON")).toHaveLength(1);
    expect(guardEvents(seen, "OFF")).toHaveLength(readback === "off-stuck" ? 1 : 0);
    if (readback !== "off-stuck") expect(seen.guardedReads).toBe(0);
  } finally { seen.restore(); }
  expect(readSnapshot(filename)).toEqual(before);
}));

test("component query_only setup exception closes the guarded handle before helper or migration work", () => fixture(({ filename, before, settle }) => {
  settle(); const seen = observe(filename, { firstProbeError: nativeError(), guardSetError: true });
  try { expect(() => getDrizzleDb()).toThrow("controlled query_only setup failure"); expect(seen.guardedReads).toBe(0); expect(applicationWrites(seen)).toHaveLength(0); expect(guardEvents(seen, "OFF")).toHaveLength(0); expect(seen.events.filter(event => event.kind === "close")).toHaveLength(2); }
  finally { seen.restore(); }
  expect(readSnapshot(filename)).toEqual(before);
}));

for (const corrupt of ["receipt", "extra-table", "immutable-trigger"] as const) test(`component forced fallback retains strict ${corrupt} refusal and logical state`, () => fixture(({ filename, writer, settle }) => {
  if (corrupt === "receipt") writer.exec("UPDATE __drizzle_migrations SET hash='unknown' WHERE created_at=1791773224836");
  if (corrupt === "extra-table") writer.exec("CREATE TABLE unknown_business(value text)");
  if (corrupt === "immutable-trigger") writer.exec("DROP TRIGGER verification_snapshots_no_update");
  const before = snapshot(writer); settle(); const seen = observe(filename, { firstProbeError: nativeError() });
  try {
    expect(() => getDrizzleDb()).toThrow("Unrecognized legacy semantic migration");
    expect(guardEvents(seen, "ON")).toHaveLength(1); expect(guardEvents(seen, "OFF")).toHaveLength(0); expect(applicationWrites(seen)).toHaveLength(0); expect(seen.guardedReads).toBeGreaterThan(0);
  } finally { seen.restore(); }
  expect(readSnapshot(filename)).toEqual(before);
}));

test("genuine read-only helper refusal never retries on a writable fallback", () => fixture(({ filename, writer, settle }) => {
  writer.exec("UPDATE __drizzle_migrations SET hash='unknown' WHERE created_at=1791773224836"); const before = snapshot(writer); settle(); const seen = observe(filename);
  try { expect(() => getDrizzleDb()).toThrow("Unrecognized legacy semantic migration"); expect(guardEvents(seen, "ON")).toHaveLength(0); expect(seen.probes).toBe(1); expect(applicationWrites(seen)).toHaveLength(0); }
  finally { seen.restore(); }
  expect(readSnapshot(filename)).toEqual(before);
}));

for (const forcedFallback of [false, true]) test(`component native-looking helper CANTOPEN is terminal (${forcedFallback ? "guarded helper" : "genuine RO helper"})`, () => fixture(({ filename, before, settle }) => {
  settle(); const seen = observe(filename, { helperError: nativeError(), ...(forcedFallback ? { firstProbeError: nativeError() } : {}) });
  try { expect(() => getDrizzleDb()).toThrow("Unrecognized legacy semantic migration"); expect(guardEvents(seen, "ON")).toHaveLength(forcedFallback ? 1 : 0); expect(guardEvents(seen, "OFF")).toHaveLength(0); expect(seen.probes).toBe(forcedFallback ? 2 : 1); expect(applicationWrites(seen)).toHaveLength(0); }
  finally { seen.restore(); }
  expect(readSnapshot(filename)).toEqual(before);
}));

for (const [code, errno] of [["SQLITE_BUSY", 5], ["SQLITE_CANTOPEN", 5], ["SQLITE_IOERR", 14]] as const) test(`component probe ${code}/${errno} cannot select the CANTOPEN14 fallback`, () => fixture(({ filename, before, settle }) => {
  settle(); const seen = observe(filename, { firstProbeError: nativeError(code, errno) });
  try { expect(() => getDrizzleDb()).toThrow("controlled native probe error"); expect(guardEvents(seen, "ON")).toHaveLength(0); expect(seen.probes).toBe(1); expect(applicationWrites(seen)).toHaveLength(0); }
  finally { seen.restore(); }
  expect(readSnapshot(filename)).toEqual(before);
}));

for (const forcedFallback of [false, true]) test(`existing target disappearing after preflight close is never recreated (${forcedFallback ? "component fallback" : "healthy RO"})`, () => fixture(({ filename, before, settle }) => {
  settle(); const retainedPath = filename + ".retained", seen = observe(filename, {
    ...(forcedFallback ? { firstProbeError: nativeError() } : {}), afterFirstClose: () => renameSync(filename, retainedPath),
  });
  try { expect(() => getDrizzleDb()).toThrow(); expect(existsSync(filename)).toBe(false); expect(applicationWrites(seen)).toHaveLength(0); }
  finally { seen.restore(); }
  expect(readSnapshot(retainedPath)).toEqual(before); expect(existsSync(filename)).toBe(false);
}));

test("component forced own RO probe READONLY_ROLLBACK776 keeps query_only ON through strict validation and blocks six real writes", () => fixture(({ filename, before, settle }) => {
  settle(); const seen = observe(filename, { firstProbeError: nativeError("SQLITE_READONLY_ROLLBACK", 776), denyWritesDuringHelper: true });
  try {
    const db = getDrizzleDb().$client; preserved(db, before);
    expect(guardEvents(seen, "ON")).toHaveLength(1); expect(guardEvents(seen, "OFF")).toHaveLength(1); expect(seen.deniedWrites).toBe(6); expect(seen.guardedReads).toBeGreaterThan(0);
    expect(seen.probes).toBe(2); expect(seen.nativeProbeErrors).toEqual([]);
    const on = seen.events.findIndex(event => event.sql === "PRAGMA query_only = ON"), off = seen.events.findIndex(event => event.sql === "PRAGMA query_only = OFF");
    expect(off).toBeGreaterThan(on);
    const reads = seen.events.slice(on + 1, off).filter(event => event.kind === "query");
    expect(reads.length).toBeGreaterThan(3); for (const event of reads) expect(event.guard).toBe(1);
    expect(reads.some(event => event.sql === "PRAGMA integrity_check(1)")).toBe(true); expect(reads.some(event => event.sql === "SELECT 1 FROM pragma_foreign_key_check LIMIT 1")).toBe(true);
    expect(seen.events.findIndex(event => event === applicationWrites(seen)[0])).toBeGreaterThan(off);
    expect(db.query("PRAGMA query_only").get()).toEqual({ query_only: 0 });
  } finally { seen.restore(); }
}));

for (const [code, errno] of [
  ["SQLITE_READONLY", 8], ["SQLITE_READONLY", 776], ["SQLITE_READONLY_ROLLBACK", 14], ["SQLITE_CANTOPEN", 776], ["SQLITE_IOERR", 776],
] as const) test(`component own RO probe ${code}/${errno} cannot select native coordination`, () => fixture(({ filename, before, settle }) => {
  settle(); const seen = observe(filename, { firstProbeError: nativeError(code, errno) });
  try {
    expect(() => getDrizzleDb()).toThrow("controlled native probe error");
    expect(guardEvents(seen, "ON")).toHaveLength(0); expect(guardEvents(seen, "OFF")).toHaveLength(0);
    expect(seen.probes).toBe(1); expect(seen.guardedReads).toBe(0); expect(applicationWrites(seen)).toHaveLength(0);
  } finally { seen.restore(); }
  expect(readSnapshot(filename)).toEqual(before);
}));

for (const forcedFallback of [false, true]) test(`component native-looking helper READONLY_ROLLBACK776 is terminal (${forcedFallback ? "guarded helper" : "genuine RO helper"})`, () => fixture(({ filename, before, settle }) => {
  settle(); const seen = observe(filename, {
    helperError: nativeError("SQLITE_READONLY_ROLLBACK", 776), ...(forcedFallback ? { firstProbeError: nativeError("SQLITE_READONLY_ROLLBACK", 776) } : {}),
  });
  try {
    expect(() => getDrizzleDb()).toThrow("Unrecognized legacy semantic migration");
    expect(guardEvents(seen, "ON")).toHaveLength(forcedFallback ? 1 : 0); expect(guardEvents(seen, "OFF")).toHaveLength(0);
    expect(seen.probes).toBe(forcedFallback ? 2 : 1); expect(applicationWrites(seen)).toHaveLength(0);
  } finally { seen.restore(); }
  expect(readSnapshot(filename)).toEqual(before);
}));

for (const variant of ["READONLY_RECOVERY264", "non-Error exact776"] as const) test(`component own RO probe ${variant} cannot select native coordination`, () => fixture(({ filename, before, settle }) => {
  const error = variant === "READONLY_RECOVERY264" ? nativeError("SQLITE_READONLY_RECOVERY", 264) : { code: "SQLITE_READONLY_ROLLBACK", errno: 776 };
  expect(error instanceof Error).toBe(variant === "READONLY_RECOVERY264");
  settle(); const seen = observe(filename, { firstProbeError: error });
  try {
    expect(() => getDrizzleDb()).toThrow();
    expect(guardEvents(seen, "ON")).toHaveLength(0); expect(guardEvents(seen, "OFF")).toHaveLength(0);
    expect(seen.probes).toBe(1); expect(seen.guardedReads).toBe(0); expect(applicationWrites(seen)).toHaveLength(0);
  } finally { seen.restore(); }
  expect(readSnapshot(filename)).toEqual(before);
}));
