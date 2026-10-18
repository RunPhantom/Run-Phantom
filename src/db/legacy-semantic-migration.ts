import { Database } from "bun:sqlite";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

// Canonical C0..C13 and the byte-identical original semantic9 receipt, now source position14.
const identities = [
  ["0000_massive_winter_soldier", 1778475472563, "52899c23e0fdf365b2d0e283f11207d8406fd8e3f01acc9f83567d81e279730d"],
  ["0001_cynical_betty_brant", 1778475541625, "c48b564e9ed782d25276077b04a2e207f3f15886245b24a40efff4c274ae4702"],
  ["0002_flowery_shinobi_shaw", 1787429370282, "c761f4aab08c1e08add602bb96a4a70417d1fb4e319544b9dd00a7d0f4bb7010"],
  ["0003_span_identity_per_run", 1787429370283, "7b1e1d7c2d46d593bace5b085b5ece7d91437fc2c49083ad32b8c48017323c11"],
  ["0004_spotty_thunderbolt", 1788822552935, "7299fbdf12b94a15842eb869631ba9d16fedb4efd01785590773d5919c31c1d8"],
  ["0005_sweet_smasher", 1788823828928, "22639daefc1ccbad932e1cb6beabe2a1f8f9fea44de58083f8b31c3189948707"],
  ["0006_lying_proemial_gods", 1788826316549, "a5e09300f1b4500900c3833a8ed7dfb844adf078fb133ca802544dc2ddd7dcdc"],
  ["0007_evidence_storage", 1791756634149, "aef0ee70d71c0ba6bd84061cdd07032455e18f688f0aef2938050be29e00b586"],
  ["0008_otlp_evidence", 1791757794360, "bca976855ea092b54886964466fb7447612cbbfb8c84133565972409a6174069"],
  ["0009_finding_comparisons", 1791766000000, "a963b994517b0725e0794247b4e4207f4f1151457c2f982eabd273c151b1358c"],
  ["0010_coding_hooks", 1791766000001, "0d2d11b4340b76914d46b9113c36bff1c11707f1371a316e08a760c4c7fcffe4"],
  ["0011_review_queues", 1791766000002, "c205637f27e822805e02a117e1c7d5ab806fd5fe5e97983749b726cff65e7c36"],
  ["0012_prompt_registry", 1791766000003, "08959444aed5fb9d1e7e319d7218b2953e678f925c92239299da12b57421dfbc"],
  ["0013_completion_reports", 1791766000004, "8d79d49ff9ac54cad9fbba38a0573fdbac1c59d5325d98d905924ae4c598353e"],
  ["0014_semantic_snapshots", 1791773224836, "69fc773324ff10dda96832470c1e1c5aeb8205f590165ce7f0e116af891f245e"],
] as const;
const historyDefinitions = [
  'CREATE TABLE "__drizzle_migrations" (\n\t\t\t\tid SERIAL PRIMARY KEY,\n\t\t\t\thash text NOT NULL,\n\t\t\t\tcreated_at numeric\n\t\t\t)',
  'CREATE TABLE "__drizzle_migrations" (\n      id SERIAL PRIMARY KEY,\n      hash text NOT NULL,\n      created_at numeric\n    )',
];
const legacyIndices = [...Array.from({ length: 9 }, (_, index) => index), 14];
const unifiedIndices = identities.map((_, index) => index);
const semanticIdentity = identities[14];
type Reason = "assets" | "history" | "schema" | "integrity" | "foreign_keys" | "transaction";
export class SemanticMigrationError extends Error {
  constructor(readonly reason: Reason) {
    super(`Unrecognized legacy semantic migration (${reason}); refusing to change its schema or history`);
    this.name = "SemanticMigrationError";
  }
}
function reject(reason: Reason): never { throw new SemanticMigrationError(reason); }
function checked<T>(reason: Reason, read: () => T): T {
  try { return read(); } catch (error) { if (error instanceof SemanticMigrationError) throw error; return reject(reason); }
}
interface SchemaObject { type: string; name: string; tbl_name: string; sql: string | null; }
interface Receipt { receipt_rowid: number; id: unknown; hash: string; created_at: number; hash_type: string; time_type: string; }
type Lineage = "legacy" | "unified";
const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"';

function objects(db: Database): SchemaObject[] {
  return checked("schema", () => {
    const rows = db.query(`SELECT type,name,tbl_name,
      CASE WHEN length(CAST(sql AS BLOB))<=262144 THEN sql END sql
      FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT 257`).all() as SchemaObject[];
    if (rows.length > 256 || rows.some(row => typeof row.sql !== "string")) reject("schema");
    return rows;
  });
}
function receipts(db: Database): Receipt[] {
  return checked("history", () => {
    const rows = db.query(`SELECT rowid AS receipt_rowid,id,hash,created_at,typeof(hash) AS hash_type,typeof(created_at) AS time_type
      FROM __drizzle_migrations ORDER BY created_at,hash LIMIT 17`).all() as Receipt[];
    if (rows.length > 16 || rows.some(row => !Number.isSafeInteger(row.receipt_rowid))) reject("history");
    return rows;
  });
}
function matches(rows: Receipt[], indices: number[]): boolean {
  return rows.length === indices.length && rows.every((row, index) => {
    const [, when, hash] = identities[indices[index]];
    return row.hash_type === "text" && typeof row.hash === "string" && row.hash === hash
      && row.time_type === "integer" && typeof row.created_at === "number" && Number.isSafeInteger(row.created_at) && row.created_at === when;
  });
}
function tableDetails(db: Database, name: string) {
  const identifier = quote(name);
  const columns = db.query(`PRAGMA table_xinfo(${identifier})`).all();
  const foreignKeys = db.query(`PRAGMA foreign_key_list(${identifier})`).all();
  const indices = db.query(`PRAGMA index_list(${identifier})`).all() as Array<{ name: string }>;
  if (columns.length > 256 || foreignKeys.length > 128 || indices.length > 128) reject("schema");
  return { columns, foreignKeys, indices: indices.sort((a, b) => a.name.localeCompare(b.name)).map(index => {
    const columns = db.query(`PRAGMA index_xinfo(${quote(index.name)})`).all();
    if (columns.length > 128) reject("schema");
    return { index, columns };
  }) };
}
function businessSchema(db: Database, roster = objects(db)): string {
  return checked("schema", () => JSON.stringify(roster.filter(row => row.name !== "__drizzle_migrations").map(row => ({
    ...row, ...(row.type === "table" ? { details: tableDetails(db, row.name) } : {}),
  }))));
}
function historyShape(db: Database, roster = objects(db)): string {
  return checked("history", () => {
    const table = roster.find(row => row.name === "__drizzle_migrations");
    if (!table || table.type !== "table" || !historyDefinitions.includes(table.sql!)) reject("history");
    return JSON.stringify(tableDetails(db, "__drizzle_migrations"));
  });
}
function health(db: Database): void {
  checked("integrity", () => {
    if (!isDeepStrictEqual(db.query("PRAGMA integrity_check(1)").all(), [{ integrity_check: "ok" }])) reject("integrity");
  });
  checked("foreign_keys", () => {
    if (db.query("SELECT 1 FROM pragma_foreign_key_check LIMIT 1").get()) reject("foreign_keys");
  });
}
function trustedMigrations(migrationsFolder: string): MigrationMeta[] {
  return checked("assets", () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      version: string; dialect: string; entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    if (journal.version !== "7" || journal.dialect !== "sqlite" || !Array.isArray(journal.entries) || journal.entries.length !== identities.length
      || journal.entries.some((entry, index) => entry.idx !== index || entry.version !== "6" || entry.tag !== identities[index][0] || entry.when !== identities[index][1] || entry.breakpoints !== true)) reject("assets");
    const migrations = readMigrationFiles({ migrationsFolder });
    if (migrations.length !== identities.length || migrations.some((migration, index) => migration.hash !== identities[index][2]
      || migration.folderMillis !== identities[index][1] || migration.bps !== true)) reject("assets");
    return migrations;
  });
}
function reference(migrations: MigrationMeta[], indices: number[]) {
  return checked("assets", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
      db.exec(historyDefinitions[0]);
      // Only the disposable reference has its own transaction; target ownership stays with the coordinator.
      db.transaction(() => { for (const index of indices) for (const statement of migrations[index].sql) db.exec(statement); }).immediate();
      return { business: businessSchema(db), history: historyShape(db) };
    } finally { db.close(true); }
  });
}
function inspect(db: Database, migrationsFolder: string) {
  const roster = objects(db), hasHistory = roster.some(row => row.name === "__drizzle_migrations" && row.type === "table");
  const semanticSchema = roster.some(row => row.name === "verification_snapshots" || row.tbl_name === "verification_snapshots");
  if (!hasHistory) {
    if (semanticSchema || roster.some(row => row.name === "__drizzle_migrations")) reject("history");
    return;
  }
  const rows = receipts(db);
  const semanticReceipt = rows.some(row => row.hash === semanticIdentity[2] || row.created_at === semanticIdentity[1]
    || typeof row.created_at === "number" && row.created_at >= semanticIdentity[1]);
  if (!semanticSchema && !semanticReceipt) return;
  const lineage: Lineage = matches(rows, legacyIndices) ? "legacy" : matches(rows, unifiedIndices) ? "unified" : reject("history");
  const migrations = trustedMigrations(migrationsFolder), legacy = reference(migrations, legacyIndices), unified = reference(migrations, unifiedIndices);
  if (historyShape(db, roster) !== unified.history) reject("history");
  if (businessSchema(db, roster) !== (lineage === "legacy" ? legacy.business : unified.business)) reject("schema");
  health(db);
  return { lineage, rows, migrations, unified };
}

/** Read-only on the target; undefined delegates nonsemantic databases to their separate migration policy. */
export function assertRecognizedSemanticMigration(db: Database, migrationsFolder: string): Lineage | undefined {
  return inspect(db, migrationsFolder)?.lineage;
}

/** The caller must hold its outer immediate migration transaction through the returned final validation. */
export function bridgeLegacySemanticMigration(db: Database, migrationsFolder: string): (() => void) | undefined {
  if (!db.inTransaction) reject("transaction");
  const state = inspect(db, migrationsFolder);
  if (!state) return;
  const validate = () => {
    if (!db.inTransaction) reject("transaction");
    const roster = objects(db), rows = receipts(db);
    if (!matches(rows, unifiedIndices) || historyShape(db, roster) !== state.unified.history) reject("history");
    if (state.rows.some(original => !rows.some(row => isDeepStrictEqual(row, original)))) reject("history");
    if (businessSchema(db, roster) !== state.unified.business) reject("schema");
    health(db);
  };
  if (state.lineage === "legacy") {
    const insert = db.query("INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)");
    for (const migration of state.migrations.slice(9, 14)) {
      for (const statement of migration.sql) db.exec(statement);
      insert.run(migration.hash, migration.folderMillis);
    }
  }
  validate();
  return validate;
}
