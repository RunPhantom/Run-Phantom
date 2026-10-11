import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDrizzleDb } from "../src/db";
import { EvidenceStore, EVIDENCE_STORAGE_SQL } from "../src/evaluations/evidence-store";
import { deriveEvidenceCounts, evidenceDigest } from "../src/evaluations/evidence-validation";
import type { EvidenceImportRequest, NormalizedEvidenceSource } from "../src/evaluations/evidence-protocol";

const tables = ["artifacts", "blobs", "interpretations", "inventories", "inventory_heads", "jobs", "payloads", "retention_events", "scopes", "sets"];
const scope = { kind: "local", id: "local" } as const;
const authority = { authorize: () => ({ actorId: "migration-fixture" }) };
const raw = new TextEncoder().encode("Frozen synthetic report bytes");
const leaves = [{ id: "leaf-1", name: "Stored synthetic observation", status: "passed" as const, file: null, durationMs: 0, detail: null }];
const normalized: NormalizedEvidenceSource = {
  version: 1, sourceId: "unit-1", parseState: "parsed", interpretationComplete: true, reportOutcome: "reports_pass",
  leafCounts: deriveEvidenceCounts(leaves), observedExecutedLowerBound: "1", producerCounts: { tests: "1" }, producerSummaries: [],
  countsConsistent: true, assertedIdentity: { runnerId: null, commit: null, sourceSha256: null }, attestation: null, reasonCodes: [], leaves,
};

function tableShape(database: Database) {
  return tables.map(suffix => {
    const name = `evaluation_evidence_${suffix}`;
    const columns = database.query(`PRAGMA table_info(${name})`).all() as { name: string; type: string; notnull: number; pk: number }[];
    const foreignKeys = database.query(`PRAGMA foreign_key_list(${name})`).all() as { table: string; from: string; to: string; on_delete: string }[];
    const indices = database.query(`PRAGMA index_list(${name})`).all() as { name: string; unique: number }[];
    return { name, columns: columns.map(column => ({ name: column.name, type: column.type, pk: column.pk,
      // Drizzle explicitly makes scalar primary keys NOT NULL; the reference DDL relies on the validated store identity.
      required: column.notnull === 1 || column.pk > 0 })),
    foreignKeys: foreignKeys.map(key => ({ table: key.table, from: key.from, to: key.to, on_delete: key.on_delete })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    indices: indices.map(index => ({ unique: index.unique, columns: (database.query(`PRAGMA index_info(${index.name})`).all() as { name: string }[]).map(column => column.name) }))
      .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  });
}

for (const prior of [false, true]) test(`evidence migration: ${prior ? "upgrade from evaluation schema 0006" : "fresh application database"} retains immutable byte identity after reopen`, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "runphantom-evidence-migration-"));
  const dbPath = path.join(directory, "workspace.db"), migrations = path.resolve(import.meta.dir, "../drizzle");
  const journal = JSON.parse(readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"));
  const previous = process.env.RUNPHANTOM_DB_PATH;
  let baseline: Database | undefined;
  const reference = new Database(":memory:");
  closeDb();
  try {
    reference.exec(EVIDENCE_STORAGE_SQL);
    let originals: { runs: unknown[]; spans: unknown[]; revisions: unknown[]; history: unknown[] } | undefined;
    if (prior) {
      const priorMigrations = path.join(directory, "prior-migrations"), entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 6);
      expect(entries).toHaveLength(7);
      mkdirSync(path.join(priorMigrations, "meta"), { recursive: true });
      writeFileSync(path.join(priorMigrations, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const entry of entries) copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(priorMigrations, `${entry.tag}.sql`));
      baseline = new Database(dbPath, { create: true });
      baseline.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
      migrate(drizzle(baseline), { migrationsFolder: priorMigrations });
      baseline.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF");
      baseline.exec("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES('prior-run','Prior captured run',1,2)");
      baseline.query("INSERT INTO spans(run_id,id,name,status,output_payload) VALUES(?,?,?,?,?)").run("prior-run", "prior-span", "Prior output", "OK", '{"result":"unchanged"}');
      baseline.exec("INSERT INTO evaluation_datasets(id,name,latest_version,case_count,created_at) VALUES('prior-dataset','Frozen prior revision',1,0,3)");
      baseline.query("INSERT INTO evaluation_revisions(dataset_id,version,hash,cases,created_at) VALUES(?,?,?,?,?)").run("prior-dataset", 1, evidenceDigest("[]"), "[]", 3);
      originals = { runs: baseline.query("SELECT * FROM runs").all(), spans: baseline.query("SELECT * FROM spans").all(),
        revisions: baseline.query("SELECT * FROM evaluation_revisions").all(), history: baseline.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all() };
      baseline.close(true); baseline = undefined;
    }
    process.env.RUNPHANTOM_DB_PATH = dbPath;
    const installed = getDrizzleDb().$client;
    expect(installed.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'evaluation_evidence_%' ORDER BY name").all())
      .toEqual(tables.map(name => ({ name: `evaluation_evidence_${name}` })));
    expect(tableShape(installed)).toEqual(tableShape(reference));
    expect(installed.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(installed.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'evaluation_evidence_%' ORDER BY name").all())
      .toEqual(reference.query("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all());
    const history = installed.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all();
    expect(history).toHaveLength(journal.entries.length);
    if (originals) {
      expect(installed.query("SELECT * FROM runs").all()).toEqual(originals.runs);
      expect(installed.query("SELECT * FROM spans").all()).toEqual(originals.spans);
      expect(installed.query("SELECT * FROM evaluation_revisions").all()).toEqual(originals.revisions);
      expect(history.slice(0, 7)).toEqual(originals.history);
    }
    installed.exec("INSERT INTO evaluation_evidence_scopes(scope_key,generation,active) VALUES('local:local',1,1)");
    const store = new EvidenceStore(installed, scope, authority);
    const inventory = store.saveInventory("trusted-roster", 0, [{ shardId: "unit", kind: "junit", constraints: { runnerId: null, commit: null, sourceSha256: null } }], "prospective");
    const request: EvidenceImportRequest = { operationKey: "migration-import", target: null, attachment: { kind: "inspection", id: "migration-review" },
      inventory: { id: inventory.id, revision: inventory.revision }, parserVersion: "synthetic-migration-1", policyVersion: "redaction-1", configurationSha256: evidenceDigest("migration"),
      retention: "raw_and_normalized", sources: [{ sourceId: "unit-1", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(raw), byteLength: raw.byteLength }] };
    const admitted = store.admit(request);
    expect(store.start(admitted.job.id, admitted.publicationToken)).toBe(true);
    const set = store.publish(admitted.job.id, admitted.publicationToken, [{ sourceId: "unit-1", raw, normalized }])!;
    expect(set).toMatchObject({ coverage: "complete", inventory, parserVersion: "synthetic-migration-1" });
    expect(store.exportRaw(set.id, set.revision, "unit-1")).toEqual(raw);
    for (const [table, field] of [["inventories", "data"], ["artifacts", "sha256"], ["blobs", "bytes"], ["interpretations", "parser_version"], ["payloads", "data"], ["sets", "data"]])
      expect(() => installed.query(`UPDATE evaluation_evidence_${table} SET ${field}=?`).run("mutated")).toThrow("immutable evidence");
    expect(() => installed.exec("UPDATE evaluation_evidence_jobs SET reserved_raw_bytes=-1")).toThrow();
    expect(() => installed.exec("UPDATE evaluation_evidence_jobs SET status='invalid'")).toThrow();
    expect(() => installed.query("INSERT INTO evaluation_evidence_blobs(scope_key,artifact_id,bytes) VALUES(?,?,?)").run("local:local", "missing-parent", raw)).toThrow();
    const before = store.getSet(set.id, set.revision);
    closeDb();
    const reopened = getDrizzleDb().$client, retained = new EvidenceStore(reopened, scope, authority);
    expect(retained.getSet(set.id, set.revision)).toEqual(before);
    expect(retained.getInventory(inventory.id, inventory.revision)).toEqual(inventory);
    expect(retained.exportRaw(set.id, set.revision, "unit-1")).toEqual(raw);
    expect(retained.removePayloads(set.id, set.revision, "raw_removed")).toBe(1);
    expect(() => retained.exportRaw(set.id, set.revision, "unit-1")).toThrow("unavailable");
    expect(() => reopened.exec("UPDATE evaluation_evidence_retention_events SET actor_id='rewritten'")).toThrow("immutable evidence");
    const frozenMetadata = reopened.query("SELECT data,digest FROM evaluation_evidence_sets WHERE id=?").get(set.id);
    closeDb();
    const afterRetention = getDrizzleDb().$client;
    expect(afterRetention.query("SELECT data,digest FROM evaluation_evidence_sets WHERE id=?").get(set.id)).toEqual(frozenMetadata);
    expect(() => new EvidenceStore(afterRetention, scope, authority).exportRaw(set.id, set.revision, "unit-1")).toThrow("unavailable");
    expect(afterRetention.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(afterRetention.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(history);
  } finally {
    baseline?.close(true); reference.close(true); closeDb();
    if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
