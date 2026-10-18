import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FaultEvent, FaultNode, FaultReceipt, SelectedErrorVariant } from "./fixtures/semantic-preflight-fault-runner";

// Original semantic lineage, including its real receipt timestamp and unchanged SQL hash.
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
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"';
function snapshot(filename: string) {
  const db = new Database(filename, { readwrite: true, create: false });
  try {
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
    const tables = schema.filter(row => row.type === "table");
    return {
      schema,
      details: tables.map(row => ({ name: row.name, columns: db.query(`PRAGMA table_xinfo(${quote(row.name)})`).all(), foreignKeys: db.query(`PRAGMA foreign_key_list(${quote(row.name)})`).all(),
        indices: (db.query(`PRAGMA index_list(${quote(row.name)})`).all() as Array<{ name: string }>).sort((a, b) => a.name.localeCompare(b.name)).map(index => ({ ...index, columns: db.query(`PRAGMA index_xinfo(${quote(index.name)})`).all() })),
      })),
      history: db.query("SELECT rowid AS receipt_rowid,id,hash,created_at FROM __drizzle_migrations ORDER BY rowid").all(),
      data: Object.fromEntries(tables.filter(row => row.name !== "__drizzle_migrations").map(row => [row.name, db.query(`SELECT rowid AS source_rowid,* FROM ${quote(row.name)} ORDER BY rowid`).all()])),
      integrity: db.query("PRAGMA integrity_check").all(), foreignKeys: db.query("PRAGMA foreign_key_check").all(),
    };
  } finally { db.close(true); }
}
function seed(filename: string, invalid: boolean) {
  const db = new Database(filename);
  try {
    db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
    db.exec('CREATE TABLE "__drizzle_migrations" (\n\t\t\t\tid SERIAL PRIMARY KEY,\n\t\t\t\thash text NOT NULL,\n\t\t\t\tcreated_at numeric\n\t\t\t)');
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
    if (invalid) db.exec("UPDATE __drizzle_migrations SET hash='actual-invalid-receipt' WHERE created_at=1791773224836");
  } finally { db.close(true); }
}
const physical = (filename: string) => Object.fromEntries(["", "-wal", "-shm", "-journal"].map(suffix => [suffix || "main", existsSync(filename + suffix) ? digest(readFileSync(filename + suffix)) : null]));
const probe = "SELECT name FROM sqlite_master LIMIT 1";
interface Boundary { node: FaultNode; title: string; constructors: number; probes: number; eligibility: number; phase: FaultEvent["phase"]; kind: FaultEvent["kind"]; sql?: string; controls: string[]; }
// Each row is a distinct approved boundary; variants share their family rather than adding cross-products.
const boundaries: Boundary[] = [
  { node: "K1", title: "RO constructor CANTOPEN cannot select probe fallback", constructors: 1, probes: 0, eligibility: 0, phase: "ro", kind: "constructor", controls: [] },
  { node: "K2", title: "guarded constructor failure follows actual RO close", constructors: 2, probes: 1, eligibility: 1, phase: "guarded", kind: "constructor", controls: ["1:BEGIN", "1:COMMIT"] },
  { node: "K3", title: "normal existing RW reopen failure cannot retry", constructors: 2, probes: 1, eligibility: 0, phase: "startup", kind: "constructor", controls: ["1:BEGIN", "1:COMMIT"] },
  { node: "K4", title: "absent-target constructor failure cannot create a database", constructors: 1, probes: 0, eligibility: 0, phase: "startup", kind: "constructor", controls: [] },
  { node: "T1", title: "actual controller BEGIN.run failure precedes callback", constructors: 1, probes: 0, eligibility: 0, phase: "ro", kind: "control", sql: "BEGIN", controls: ["1:BEGIN"] },
  { node: "T2", title: "guarded controller BEGIN.run failure retains guard", constructors: 2, probes: 1, eligibility: 1, phase: "guarded", kind: "control", sql: "BEGIN", controls: ["1:BEGIN", "1:COMMIT", "2:BEGIN"] },
  { node: "T3-before", title: "eligible RO commit refusal cannot activate fallback", constructors: 1, probes: 1, eligibility: 1, phase: "ro", kind: "control", sql: "COMMIT", controls: ["1:BEGIN", "1:COMMIT", "1:ROLLBACK"] },
  { node: "T3-after", title: "eligible RO completion error after native commit cannot fallback", constructors: 1, probes: 1, eligibility: 1, phase: "ro", kind: "control", sql: "COMMIT", controls: ["1:BEGIN", "1:COMMIT"] },
  { node: "T4", title: "classified RO commit refusal rolls back and closes", constructors: 1, probes: 1, eligibility: 0, phase: "ro", kind: "control", sql: "COMMIT", controls: ["1:BEGIN", "1:COMMIT", "1:ROLLBACK"] },
  { node: "T5", title: "guarded commit refusal rolls back without releasing guard", constructors: 2, probes: 2, eligibility: 1, phase: "guarded", kind: "control", sql: "COMMIT", controls: ["1:BEGIN", "1:COMMIT", "2:BEGIN", "2:COMMIT", "2:ROLLBACK"] },
  { node: "T6", title: "genuine strict receipt refusal remains terminal when RO rollback fails", constructors: 1, probes: 1, eligibility: 0, phase: "ro", kind: "control", sql: "ROLLBACK", controls: ["1:BEGIN", "1:ROLLBACK"] },
  { node: "T7", title: "guarded probe refusal plus rollback failure cannot retry", constructors: 2, probes: 2, eligibility: 1, phase: "guarded", kind: "control", sql: "ROLLBACK", controls: ["1:BEGIN", "1:COMMIT", "2:BEGIN", "2:ROLLBACK"] },
  { node: "L1-before", title: "eligible RO pre-native close exception records outstanding handle", constructors: 1, probes: 1, eligibility: 1, phase: "ro", kind: "close", controls: ["1:BEGIN", "1:COMMIT"] },
  { node: "L1-after", title: "eligible RO after-native close exception records actual release", constructors: 1, probes: 1, eligibility: 1, phase: "ro", kind: "close", controls: ["1:BEGIN", "1:COMMIT"] },
  { node: "L2-before", title: "genuine guarded receipt refusal plus pre-native close exception", constructors: 2, probes: 2, eligibility: 1, phase: "guarded", kind: "close", controls: ["1:BEGIN", "1:COMMIT", "2:BEGIN", "2:ROLLBACK"] },
  { node: "L2-after", title: "genuine guarded receipt refusal plus after-native close exception", constructors: 2, probes: 2, eligibility: 1, phase: "guarded", kind: "close", controls: ["1:BEGIN", "1:COMMIT", "2:BEGIN", "2:ROLLBACK"] },
  { node: "Q1", title: "guarded own probe CANTOPEN cannot select another fallback", constructors: 2, probes: 2, eligibility: 1, phase: "guarded", kind: "query", sql: probe, controls: ["1:BEGIN", "1:COMMIT", "2:BEGIN", "2:ROLLBACK"] },
  { node: "Q2", title: "guard OFF execution exception retains ON until close", constructors: 2, probes: 2, eligibility: 1, phase: "guarded", kind: "exec", sql: "PRAGMA query_only = OFF", controls: ["1:BEGIN", "1:COMMIT", "2:BEGIN", "2:COMMIT"] },
  { node: "Q3", title: "native guard OFF followed by readback get exception closes handle", constructors: 2, probes: 2, eligibility: 1, phase: "guarded", kind: "readback", sql: "PRAGMA query_only", controls: ["1:BEGIN", "1:COMMIT", "2:BEGIN", "2:COMMIT"] },
  { node: "O1", title: "transferred handle closes on startup setting failure and separate recovery resets facade", constructors: 2, probes: 2, eligibility: 1, phase: "startup", kind: "exec", sql: "PRAGMA busy_timeout = 1000", controls: ["1:BEGIN", "1:COMMIT", "2:BEGIN", "2:COMMIT"] },
];

async function child(node: FaultNode, directory: string, filename: string, selectedErrorVariant?: SelectedErrorVariant) {
  const home = path.join(directory, "home"), temporary = path.join(directory, "tmp"), output = path.join(directory, "receipt.json");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
  const processChild = spawn(process.execPath, ["--no-env-file", path.resolve(import.meta.dir, "fixtures/semantic-preflight-fault-runner.ts"), node, filename, output, ...(selectedErrorVariant ? [selectedErrorVariant] : [])], {
    cwd: path.resolve(import.meta.dir, ".."), detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin", HOME: home, USERPROFILE: home, TMPDIR: temporary, RUNPHANTOM_DB_PATH: filename },
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  processChild.stdout.on("data", (bytes: Buffer) => stdout.push(bytes)); processChild.stderr.on("data", (bytes: Buffer) => stderr.push(bytes));
  let expired = false;
  const timer = setTimeout(() => { expired = true; if (processChild.pid) process.kill(-processChild.pid, "SIGKILL"); }, 10_000);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { processChild.once("error", reject); processChild.once("close", resolve); });
    expect(expired, "owned child deadline").toBe(false);
    expect(existsSync(output), Buffer.concat(stderr).toString()).toBe(true);
    return { receipt: JSON.parse(readFileSync(output, "utf8")) as FaultReceipt, exit, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  } finally {
    clearTimeout(timer);
    if (processChild.pid) {
      try { process.kill(-processChild.pid, 0); process.kill(-processChild.pid, "SIGKILL"); }
      catch (error) { expect((error as NodeJS.ErrnoException).code, "owned child process-group cleanup").toBe("ESRCH"); }
    }
  }
}
function instrumentation(receipt: FaultReceipt, selected: number, eligibility: number, prerequisite = 0) {
  // Hit proof first: a missed injection cannot pass merely because startup rejected for another reason.
  expect(receipt.selectedHits).toBe(selected); expect(receipt.eligibilityHits).toBe(eligibility); expect(receipt.probePrerequisiteHits).toBe(prerequisite);
  expect(receipt.events.filter(event => event.fault === "selected")).toHaveLength(selected);
  expect(receipt.events.filter(event => event.fault === "eligibility")).toHaveLength(eligibility);
  expect(receipt.events.filter(event => event.fault === "probe-prerequisite")).toHaveLength(prerequisite);
  expect(receipt.setupError).toBeUndefined(); expect(receipt.cleanupError).toBeUndefined();
  expect(receipt.nativePrototypeIdentity).toBe(true); expect(receipt.preservedExports).toBe(true); expect(receipt.prepareOwnedMatches).toBe(1);
  expect(receipt.runtime.bun).toBeTruthy(); expect(receipt.runtime.revision).toBeTruthy(); expect(receipt.runtime.sqlite).toBeTruthy();
  expect(receipt.outstandingAfterTeardown).toEqual([]);
}
const mainEvents = (receipt: FaultReceipt) => receipt.events.filter(event => event.operation === "main");
function refusal(receipt: FaultReceipt, boundary: Boundary, selectedCode = "SQLITE_CANTOPEN", selectedErrno = 14) {
  instrumentation(receipt, 1, boundary.eligibility, boundary.node === "T7" ? 1 : 0);
  const events = mainEvents(receipt), selected = events.filter(event => event.fault === "selected")[0];
  expect(receipt.accepted).toBe(false); expect(receipt.operationError).toContain(`component selected ${boundary.node}`);
  expect(selected.kind).toBe(boundary.kind); expect(selected.phase).toBe(boundary.phase); expect(selected.sql).toBe(boundary.sql);
  const completedFault = boundary.node.endsWith("after");
  expect(selected.nativeExecuted).toBe(completedFault); expect(selected.nativeSucceeded).toBe(completedFault);
  const constructors = events.filter(event => event.kind === "constructor"); expect(constructors).toHaveLength(boundary.constructors);
  for (const constructor of constructors) {
    expect(constructor.options.create).toBe(boundary.node === "K4");
    if (constructor.connection === 1 && boundary.node !== "K4") expect(constructor.options).toEqual({ readonly: true, create: false });
    else expect(constructor.options).toEqual({ readwrite: true, create: boundary.node === "K4" });
  }
  expect(events.filter(event => event.kind === "query" && event.sql === probe)).toHaveLength(boundary.probes);
  const controls = events.filter(event => event.kind === "control");
  expect(controls.map(event => `${event.connection}:${event.sql}`)).toEqual(boundary.controls);
  for (const control of controls) {
    expect(events.some(event => event.kind === "prepare-control" && event.connection === control.connection && event.sql === control.sql && event.nativeSucceeded)).toBe(true);
    if (control.fault === "selected") {
      expect(control.inTransactionAfter).toBe(control.sql !== "BEGIN" && !completedFault);
    } else {
      expect(control.nativeExecuted).toBe(true); expect(control.nativeSucceeded).toBe(true);
      expect(control.inTransactionAfter).toBe(control.sql === "BEGIN");
    }
  }
  expect(events.filter(event => event.kind === "exec" && event.sql && /^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(event.sql))).toEqual([]);
  expect(events.filter(event => event.kind === "exec" && event.sql?.includes("journal_mode"))).toEqual([]);
  const off = events.filter(event => event.kind === "exec" && event.sql === "PRAGMA query_only = OFF");
  expect(off).toHaveLength(["Q2", "Q3", "O1"].includes(boundary.node) ? 1 : 0);
  const on = events.filter(event => event.kind === "exec" && event.sql === "PRAGMA query_only = ON");
  expect(on).toHaveLength(boundary.constructors === 2 && boundary.eligibility && boundary.node !== "K2" ? 1 : 0);
  for (const read of events.filter(event => ["query", "readback"].includes(event.kind) && event.phase === "guarded")) {
    const released = off[0]?.nativeSucceeded && events.indexOf(read) > events.indexOf(off[0]);
    expect(read.guard).toBe(released ? 0 : 1);
  }
  const helpers = events.filter(event => event.kind === "query" && event.sql?.includes("SELECT type,name,tbl_name,"));
  const helperNodes = ["K3", "T4", "T5", "T6", "L2-before", "L2-after", "Q2", "Q3", "O1"];
  expect(helpers).toHaveLength(helperNodes.includes(boundary.node) ? 1 : 0);
  if (boundary.node === "T6" || boundary.node.startsWith("L2-")) {
    expect(events.some(event => event.kind === "query" && event.sql?.includes("typeof(hash) AS hash_type") && event.nativeSucceeded)).toBe(true);
    expect(controls.some(event => event.sql === "ROLLBACK")).toBe(true);
  }
  const allocated = constructors.filter(event => event.nativeSucceeded);
  const closeEvents = events.filter(event => event.kind === "close");
  for (const handle of allocated) expect(closeEvents.filter(event => event.connection === handle.connection)).toHaveLength(1);
  const preClose = boundary.node === "L1-before" || boundary.node === "L2-before";
  expect(receipt.outstandingBeforeTeardown).toEqual(preClose ? [selected.connection] : []);
  expect(receipt.teardown).toHaveLength(preClose ? 1 : 0);
  if (preClose) expect(receipt.teardown[0]).toEqual({ connection: selected.connection, nativeExecuted: true, nativeSucceeded: true });
  for (const closed of closeEvents) {
    expect(closed.attempted).toBe(true); expect(closed.nativeExecuted).toBe(!(preClose && closed === selected));
    expect(closed.nativeSucceeded).toBe(!(preClose && closed === selected));
    expect(events.indexOf(closed)).toBeGreaterThan(events.findIndex(event => event === constructors.find(constructor => constructor.connection === closed.connection)));
  }
  if (boundary.node === "T1") { expect(selected.inTransaction).toBe(false); expect(helpers).toHaveLength(0); expect(closeEvents[0].inTransaction).toBe(false); }
  if (["T3-before", "T4", "T5"].includes(boundary.node)) expect(events.findIndex(event => event.kind === "control" && event.sql === "ROLLBACK")).toBeGreaterThan(events.indexOf(selected));
  if (boundary.node === "Q3") expect(selected.guard).toBe(0);
  if (boundary.node === "Q2") expect(selected.guard).toBe(1);
  if (boundary.node === "Q1") { expect(selected.errorCode).toBe(selectedCode); expect(selected.errorErrno).toBe(selectedErrno); }
  if (boundary.node === "O1") {
    expect(events.indexOf(selected)).toBeGreaterThan(events.indexOf(off[0]));
    expect(receipt.recovery?.accepted).toBe(true); expect(receipt.recovery?.error).toBeUndefined();
    const recovery = receipt.recovery!.events;
    expect(recovery.every(event => event.operation === "recovery")).toBe(true);
    expect(recovery.filter(event => event.kind === "constructor")).toHaveLength(2);
    expect(recovery.filter(event => event.kind === "constructor").every(event => event.connection > selected.connection && event.nativeSucceeded)).toBe(true);
    expect(recovery.some(event => event.kind === "exec" && event.sql?.includes("journal_mode") && event.nativeSucceeded)).toBe(true);
    expect(recovery.filter(event => event.kind === "close" && event.nativeSucceeded)).toHaveLength(2);
  }
}

test("phase1 control: isolated native harness genuinely migrates and preserves populated history", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "semantic-fault-control-")), filename = path.join(directory, "owner.sqlite");
  try {
    seed(filename, false); const before = snapshot(filename), physicalBefore = physical(filename);
    const result = await child("control", directory, filename);
    console.info(JSON.stringify({ boundary: "control", receipt: result.receipt, physicalBefore, physicalAfter: physical(filename) }));
    instrumentation(result.receipt, 0, 0); expect(result.exit, result.stderr).toBe(0); expect(result.receipt.accepted).toBe(true); expect(result.receipt.operationError).toBeUndefined();
    const after = snapshot(filename); expect(after.history).toHaveLength(15);
    for (const row of before.history) expect(after.history).toContainEqual(row);
    for (const [table, rows] of Object.entries(before.data)) expect(after.data[table]).toEqual(rows);
    expect(after.integrity).toEqual([{ integrity_check: "ok" }]); expect(after.foreignKeys).toEqual([]);
    expect(mainEvents(result.receipt).filter(event => event.kind === "constructor")).toHaveLength(2);
    expect(mainEvents(result.receipt).some(event => event.kind === "control" && event.sql === "BEGIN IMMEDIATE" && event.nativeSucceeded)).toBe(true);
    expect(mainEvents(result.receipt).some(event => event.kind === "exec" && event.sql?.includes("CREATE TABLE evaluation_finding_mappings") && event.nativeSucceeded)).toBe(true);
    expect(result.receipt.teardown).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

for (const boundary of boundaries) test(`${boundary.node === "T1" ? "phase1 " : ""}${boundary.node}: ${boundary.title}`, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "semantic-fault-")), filename = path.join(directory, "owner.sqlite");
  try {
    const invalid = boundary.node === "T6" || boundary.node.startsWith("L2-");
    if (boundary.node !== "K4") seed(filename, invalid);
    const before = boundary.node === "K4" ? null : snapshot(filename), physicalBefore = physical(filename);
    if (invalid) expect((before!.history as Array<{ hash: string }>).some(row => row.hash === "actual-invalid-receipt")).toBe(true);
    if (boundary.node === "K4") expect(existsSync(filename)).toBe(false);
    const result = await child(boundary.node, directory, filename);
    console.info(JSON.stringify({ boundary: boundary.node, receipt: result.receipt, physicalBefore, physicalAfter: physical(filename) }));
    refusal(result.receipt, boundary); expect(result.exit, result.stderr).toBe(0);
    if (boundary.node === "K4") expect(existsSync(filename)).toBe(false);
    else if (boundary.node === "O1") {
      expect(result.receipt.failedOperationSnapshot).toEqual({ schema: before!.schema, history: before!.history, data: before!.data });
      // Recovery is a distinct successful migration; compare original rows, not its expanded schema.
      const after = snapshot(filename); expect(after.history).toHaveLength(15);
      for (const row of before!.history) expect(after.history).toContainEqual(row);
      for (const [table, rows] of Object.entries(before!.data)) expect(after.data[table]).toEqual(rows);
    } else expect(snapshot(filename)).toEqual(before!);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

for (const node of ["T3-native-before", "L1-native-before"] as const) test(`${node}: selected CANTOPEN14 after eligibility cannot select fallback`, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "semantic-native-shaped-")), filename = path.join(directory, "owner.sqlite");
  try {
    seed(filename, false); const before = snapshot(filename), physicalBefore = physical(filename);
    const result = await child(node, directory, filename);
    console.info(JSON.stringify({ boundary: node, receipt: result.receipt, physicalBefore, physicalAfter: physical(filename) }));
    const receipt = result.receipt; instrumentation(receipt, 1, 1); expect(result.exit, result.stderr).toBe(0);
    const events = mainEvents(receipt), selected = events.find(event => event.fault === "selected")!, eligibility = events.find(event => event.fault === "eligibility")!;
    expect(receipt.accepted).toBe(false); expect(receipt.operationError).toContain(`component selected ${node}`);
    expect(receipt.eligibilityErrorDistinctFromSelected).toBe(true);
    expect(typeof receipt.publicErrorSameAsSelected).toBe("boolean"); // Observed separately; public wrapping need not preserve the object.
    expect(selected.selectedErrorIdentity).toEqual({ label: `selected-native:${node}`, sameSelectedObject: true, isError: true, target: filename });
    expect(selected.errorCode).toBe("SQLITE_CANTOPEN"); expect(selected.errorErrno).toBe(14);
    expect(selected.connection).toBe(1); expect(selected.phase).toBe("ro"); expect(selected.options).toEqual({ readonly: true, create: false });
    expect(selected.attempted).toBe(true); expect(selected.nativeExecuted).toBe(false); expect(selected.nativeSucceeded).toBe(false);
    expect(eligibility.kind).toBe("query"); expect(eligibility.sql).toBe(probe); expect(eligibility.connection).toBe(1); expect(eligibility.phase).toBe("ro");
    expect(eligibility.inTransaction).toBe(true); expect(events.indexOf(selected)).toBeGreaterThan(events.indexOf(eligibility));
    const constructors = events.filter(event => event.kind === "constructor"); expect(constructors).toHaveLength(1);
    expect(constructors[0].options).toEqual({ readonly: true, create: false }); expect(constructors[0].nativeSucceeded).toBe(true);
    expect(events.filter(event => event.kind === "query")).toEqual([eligibility]);
    expect(events.filter(event => event.kind === "exec")).toEqual([]); expect(events.some(event => event.phase === "guarded")).toBe(false);
    const controls = events.filter(event => event.kind === "control"), closes = events.filter(event => event.kind === "close");
    expect(controls.map(event => event.sql)).toEqual(node === "T3-native-before" ? ["BEGIN", "COMMIT", "ROLLBACK"] : ["BEGIN", "COMMIT"]);
    for (const control of controls) {
      expect(events.some(event => event.kind === "prepare-control" && event.connection === control.connection && event.sql === control.sql && event.nativeSucceeded)).toBe(true);
      expect(control.connection).toBe(1); expect(control.phase).toBe("ro");
      if (control !== selected) { expect(control.nativeExecuted).toBe(true); expect(control.nativeSucceeded).toBe(true); }
      expect(control.inTransactionAfter).toBe(control.sql === "BEGIN" || control === selected);
    }
    expect(closes).toHaveLength(1); expect(closes[0].inTransaction).toBe(false);
    if (node === "T3-native-before") {
      expect(selected.kind).toBe("control"); expect(selected.sql).toBe("COMMIT"); expect(selected.inTransaction).toBe(true);
      expect(events.indexOf(controls[2])).toBeGreaterThan(events.indexOf(selected)); expect(events.indexOf(closes[0])).toBeGreaterThan(events.indexOf(controls[2]));
      expect(closes[0].nativeExecuted).toBe(true); expect(closes[0].nativeSucceeded).toBe(true);
      expect(receipt.outstandingBeforeTeardown).toEqual([]); expect(receipt.teardown).toEqual([]);
    } else {
      expect(selected.kind).toBe("close"); expect(selected.sql).toBeUndefined(); expect(selected.inTransaction).toBe(false); expect(selected).toBe(closes[0]);
      expect(events.indexOf(selected)).toBeGreaterThan(events.indexOf(controls[1]));
      expect(receipt.outstandingBeforeTeardown).toEqual([1]); expect(receipt.teardown).toEqual([{ connection: 1, nativeExecuted: true, nativeSucceeded: true }]);
    }
    expect(snapshot(filename)).toEqual(before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);


for (const node of ["K1", "Q1"] as const) test(`${node}: selected READONLY_ROLLBACK776 cannot select another fallback`, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "semantic-native776-")), filename = path.join(directory, "owner.sqlite");
  try {
    seed(filename, false); const before = snapshot(filename), physicalBefore = physical(filename);
    const result = await child(node, directory, filename, "readonly-rollback776");
    console.info(JSON.stringify({ boundary: node, selectedErrorVariant: "readonly-rollback776", receipt: result.receipt, physicalBefore, physicalAfter: physical(filename) }));
    const receipt = result.receipt, boundary = boundaries.find(value => value.node === node)!;
    expect(result.exit, result.stderr).toBe(0); refusal(receipt, boundary, "SQLITE_READONLY_ROLLBACK", 776);
    const events = mainEvents(receipt), selected = events.find(event => event.fault === "selected")!;
    expect(selected.errorCode).toBe("SQLITE_READONLY_ROLLBACK"); expect(selected.errorErrno).toBe(776);
    expect(selected.selectedErrorIdentity).toEqual({ label: `selected-native:${node}`, sameSelectedObject: true, isError: true, target: filename });
    expect(selected.connection).toBe(node === "K1" ? 1 : 2); expect(selected.attempted).toBe(true);
    expect(selected.nativeExecuted).toBe(false); expect(selected.nativeSucceeded).toBe(false);
    expect(events.filter(event => event.kind === "exec" && event.sql === "PRAGMA query_only = OFF")).toEqual([]);
    if (node === "Q1") {
      const eligibility = events.find(event => event.fault === "eligibility")!;
      expect(eligibility.errorCode).toBe("SQLITE_CANTOPEN"); expect(eligibility.errorErrno).toBe(14);
      expect(receipt.eligibilityErrorDistinctFromSelected).toBe(true); expect(selected.guard).toBe(1);
      expect(events.indexOf(selected)).toBeGreaterThan(events.indexOf(eligibility));
    }
    expect(snapshot(filename)).toEqual(before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

for (const node of ["T3-native-before", "L1-native-before"] as const) test(`${node}: selected READONLY_ROLLBACK776 after CANTOPEN14 eligibility cannot select fallback`, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "semantic-native-shaped-")), filename = path.join(directory, "owner.sqlite");
  try {
    seed(filename, false); const before = snapshot(filename), physicalBefore = physical(filename);
    const result = await child(node, directory, filename, "readonly-rollback776");
    console.info(JSON.stringify({ boundary: node, receipt: result.receipt, physicalBefore, physicalAfter: physical(filename) }));
    const receipt = result.receipt; instrumentation(receipt, 1, 1); expect(result.exit, result.stderr).toBe(0);
    const events = mainEvents(receipt), selected = events.find(event => event.fault === "selected")!, eligibility = events.find(event => event.fault === "eligibility")!;
    expect(receipt.accepted).toBe(false); expect(receipt.operationError).toContain(`component selected ${node}`);
    expect(receipt.eligibilityErrorDistinctFromSelected).toBe(true);
    expect(typeof receipt.publicErrorSameAsSelected).toBe("boolean"); // Observed separately; public wrapping need not preserve the object.
    expect(selected.selectedErrorIdentity).toEqual({ label: `selected-native:${node}`, sameSelectedObject: true, isError: true, target: filename });
    expect(selected.errorCode).toBe("SQLITE_READONLY_ROLLBACK"); expect(selected.errorErrno).toBe(776);
    expect(eligibility.errorCode).toBe("SQLITE_CANTOPEN"); expect(eligibility.errorErrno).toBe(14);
    expect(selected.connection).toBe(1); expect(selected.phase).toBe("ro"); expect(selected.options).toEqual({ readonly: true, create: false });
    expect(selected.attempted).toBe(true); expect(selected.nativeExecuted).toBe(false); expect(selected.nativeSucceeded).toBe(false);
    expect(eligibility.kind).toBe("query"); expect(eligibility.sql).toBe(probe); expect(eligibility.connection).toBe(1); expect(eligibility.phase).toBe("ro");
    expect(eligibility.inTransaction).toBe(true); expect(events.indexOf(selected)).toBeGreaterThan(events.indexOf(eligibility));
    const constructors = events.filter(event => event.kind === "constructor"); expect(constructors).toHaveLength(1);
    expect(constructors[0].options).toEqual({ readonly: true, create: false }); expect(constructors[0].nativeSucceeded).toBe(true);
    expect(events.filter(event => event.kind === "query")).toEqual([eligibility]);
    expect(events.filter(event => event.kind === "exec")).toEqual([]); expect(events.some(event => event.phase === "guarded")).toBe(false);
    const controls = events.filter(event => event.kind === "control"), closes = events.filter(event => event.kind === "close");
    expect(controls.map(event => event.sql)).toEqual(node === "T3-native-before" ? ["BEGIN", "COMMIT", "ROLLBACK"] : ["BEGIN", "COMMIT"]);
    for (const control of controls) {
      expect(events.some(event => event.kind === "prepare-control" && event.connection === control.connection && event.sql === control.sql && event.nativeSucceeded)).toBe(true);
      expect(control.connection).toBe(1); expect(control.phase).toBe("ro");
      if (control !== selected) { expect(control.nativeExecuted).toBe(true); expect(control.nativeSucceeded).toBe(true); }
      expect(control.inTransactionAfter).toBe(control.sql === "BEGIN" || control === selected);
    }
    expect(closes).toHaveLength(1); expect(closes[0].inTransaction).toBe(false);
    if (node === "T3-native-before") {
      expect(selected.kind).toBe("control"); expect(selected.sql).toBe("COMMIT"); expect(selected.inTransaction).toBe(true);
      expect(events.indexOf(controls[2])).toBeGreaterThan(events.indexOf(selected)); expect(events.indexOf(closes[0])).toBeGreaterThan(events.indexOf(controls[2]));
      expect(closes[0].nativeExecuted).toBe(true); expect(closes[0].nativeSucceeded).toBe(true);
      expect(receipt.outstandingBeforeTeardown).toEqual([]); expect(receipt.teardown).toEqual([]);
    } else {
      expect(selected.kind).toBe("close"); expect(selected.sql).toBeUndefined(); expect(selected.inTransaction).toBe(false); expect(selected).toBe(closes[0]);
      expect(events.indexOf(selected)).toBeGreaterThan(events.indexOf(controls[1]));
      expect(receipt.outstandingBeforeTeardown).toEqual([1]); expect(receipt.teardown).toEqual([{ connection: 1, nativeExecuted: true, nativeSucceeded: true }]);
    }
    expect(snapshot(filename)).toEqual(before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
