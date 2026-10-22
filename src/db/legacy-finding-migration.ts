import { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";

const legacyHistory = [
  { hash: "52899c23e0fdf365b2d0e283f11207d8406fd8e3f01acc9f83567d81e279730d", created_at: 1778475472563 },
  { hash: "c48b564e9ed782d25276077b04a2e207f3f15886245b24a40efff4c274ae4702", created_at: 1778475541625 },
  { hash: "c761f4aab08c1e08add602bb96a4a70417d1fb4e319544b9dd00a7d0f4bb7010", created_at: 1787429370282 },
  { hash: "7b1e1d7c2d46d593bace5b085b5ece7d91437fc2c49083ad32b8c48017323c11", created_at: 1787429370283 },
  { hash: "7299fbdf12b94a15842eb869631ba9d16fedb4efd01785590773d5919c31c1d8", created_at: 1788822552935 },
  { hash: "22639daefc1ccbad932e1cb6beabe2a1f8f9fea44de58083f8b31c3189948707", created_at: 1788823828928 },
  { hash: "a5e09300f1b4500900c3833a8ed7dfb844adf078fb133ca802544dc2ddd7dcdc", created_at: 1788826316549 },
  { hash: "aef0ee70d71c0ba6bd84061cdd07032455e18f688f0aef2938050be29e00b586", created_at: 1791756634149 },
  { hash: "a963b994517b0725e0794247b4e4207f4f1151457c2f982eabd273c151b1358c", created_at: 1791766000000 },
] as const;
const otlpHistory = { hash: "bca976855ea092b54886964466fb7447612cbbfb8c84133565972409a6174069", created_at: 1791757794360 };

function schema(db: Database) {
  return JSON.stringify(db.query(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND name<>'__drizzle_migrations' ORDER BY type,name`).all());
}
function historyShape(db: Database) {
  const definition = db.query("SELECT sql FROM sqlite_master WHERE name='__drizzle_migrations'").get() as { sql: string };
  return JSON.stringify({ definition: definition.sql.replace(/[\s"`]/g, "").toLowerCase(),
    columns: db.query("PRAGMA table_info(__drizzle_migrations)").all(), indices: db.query("PRAGMA index_list(__drizzle_migrations)").all() });
}
function reject(): never { throw new Error("Unrecognized legacy finding migration; refusing to change its schema or history"); }

/** Only the frozen pre-OTLP F07 lineage may receive this missing lower-timestamp migration. */
export function bridgeLegacyFindingMigration(db: Database, migrationsFolder: string): (() => void) | undefined {
  return db.transaction(() => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('__drizzle_migrations','evaluation_finding_mappings','evaluation_finding_comparisons')").all() as { name: string }[];
    if (!tables.some(table => table.name === "__drizzle_migrations")) {
      if (tables.length) reject();
      return;
    }
    const history = db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at,hash").all() as { hash: string; created_at: number }[];
    const hasOtlp = history.some(row => row.hash === otlpHistory.hash && row.created_at === otlpHistory.created_at);
    const columns = db.query("PRAGMA table_info(spans)").all() as { name: string }[];
    if (hasOtlp) {
      if (!columns.some(column => column.name === "otlp_evidence")) reject();
      return;
    }
    if (tables.length === 1 && !history.some(row => row.created_at >= otlpHistory.created_at)) return;
    if (JSON.stringify(history) !== JSON.stringify(legacyHistory)) reject();

    const migrations = readMigrationFiles({ migrationsFolder });
    const legacy = [...migrations.slice(0, 8), migrations[9]];
    if (legacy.some((migration, i) => !migration || migration.hash !== legacyHistory[i].hash || migration.folderMillis !== legacyHistory[i].created_at)
      || migrations[8]?.hash !== otlpHistory.hash || migrations[8].folderMillis !== otlpHistory.created_at) reject();

    const reference = new Database(":memory:");
    let canonicalSchema: string;
    let migratedSchema: string;
    try {
      reference.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
      reference.exec("CREATE TABLE __drizzle_migrations(id SERIAL PRIMARY KEY,hash text NOT NULL,created_at numeric)");
      for (const migration of legacy) for (const statement of migration.sql) reference.exec(statement);
      if (schema(db) !== schema(reference)
        || historyShape(db) !== historyShape(reference)
        || db.query("PRAGMA foreign_key_check").all().length) reject();
      for (const statement of migrations[8].sql) reference.exec(statement);
      canonicalSchema = schema(reference);
      for (const migration of migrations.slice(10)) for (const statement of migration.sql) reference.exec(statement);
      migratedSchema = schema(reference);
    } finally { reference.close(true); }

    for (const statement of migrations[8].sql) db.exec(statement);
    db.query("INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)").run(otlpHistory.hash, otlpHistory.created_at);
    if (schema(db) !== canonicalSchema || db.query("PRAGMA foreign_key_check").all().length) reject();
    return () => {
      if (schema(db) !== migratedSchema || db.query("PRAGMA foreign_key_check").all().length) reject();
    };
  }).immediate();
}
