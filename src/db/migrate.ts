import type { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";

/** Read the journal position under the same SQLite lock that applies its suffix. */
export function migrateDatabase(db: Database, migrationsFolder: string): void {
  const migrations = readMigrationFiles({ migrationsFolder });
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )`);
    const last = db.query("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get() as { created_at: number } | null;
    const insert = db.query("INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)");
    for (const migration of migrations) {
      if (last && Number(last.created_at) >= migration.folderMillis) continue;
      for (const statement of migration.sql) db.exec(statement);
      insert.run(migration.hash, migration.folderMillis);
    }
  }).immediate();
}
