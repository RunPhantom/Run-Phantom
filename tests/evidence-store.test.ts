import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvidenceStore, EVIDENCE_STORAGE_SQL, type EvidenceStoreOptions } from "../src/evaluations/evidence-store";
import { EvidenceError, type EvidenceCapability, type EvidenceExpectedSource, type EvidenceImportRequest, type NormalizedEvidenceSource } from "../src/evaluations/evidence-protocol";
import { canonicalEvidenceJson, deriveEvidenceCounts, evidenceDigest } from "../src/evaluations/evidence-validation";

let db: Database, store: EvidenceStore;
let capabilities: Set<EvidenceCapability>;
const raw = new TextEncoder().encode("synthetic report bytes");
const scope = { kind: "local", id: "local" } as const;
const expected: EvidenceExpectedSource = { shardId: "unit", kind: "junit", constraints: { runnerId: null, commit: null, sourceSha256: null } };
function request(key = "operation-1"): EvidenceImportRequest {
  return { operationKey: key, target: null, attachment: { kind: "inspection", id: "review-1" },
    sources: [{ sourceId: "source-1", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(raw), byteLength: raw.byteLength }],
    inventory: null, parserVersion: "strict-1", policyVersion: "redaction-1", configurationSha256: evidenceDigest("configuration-1"), retention: "raw_and_normalized" };
}
function normalized(sourceId = "source-1"): NormalizedEvidenceSource {
  const leaves = [{ id: "leaf-1", name: "Synthetic assertion", status: "passed" as const, file: null, durationMs: 0, detail: null }];
  return { version: 1, sourceId, parseState: "parsed", reportOutcome: "reports_pass", leafCounts: deriveEvidenceCounts(leaves), producerCounts: { tests: "1" },
    countsConsistent: true, assertedIdentity: { runnerId: null, commit: null, sourceSha256: null }, reasonCodes: [], leaves };
}
function options(extra: Partial<EvidenceStoreOptions> = {}): EvidenceStoreOptions {
  return { authorize: capability => {
    if (!capabilities.has(capability)) throw new EvidenceError("Current capability denied", 403);
    return { actorId: "synthetic-operator" };
  }, ...extra };
}
function initialize(database: Database) {
  database.exec("PRAGMA foreign_keys=ON"); database.exec(EVIDENCE_STORAGE_SQL);
  database.query("INSERT INTO evaluation_evidence_scopes(scope_key,generation,active) VALUES('local:local',1,1)").run();
}
function complete(draft = request(), instance = store) {
  const admission = instance.admit(draft);
  expect(instance.start(admission.job.id, admission.publicationToken)).toBe(true);
  const set = instance.publish(admission.job.id, admission.publicationToken, draft.sources.map(source => ({ sourceId: source.sourceId, raw, normalized: normalized(source.sourceId) })));
  expect(set).not.toBeNull(); return { set: set!, admission };
}
const count = (table: string) => (db.query(`SELECT count(*) AS n FROM evaluation_evidence_${table}`).get() as { n: number }).n;
beforeEach(() => {
  capabilities = new Set(["normalized_read", "import", "inventory_edit", "raw_export", "delete"]);
  db = new Database(":memory:"); initialize(db); store = new EvidenceStore(db, scope, options());
});
afterEach(() => db.close());

describe("immutable evidence SQLite publication", () => {
  test("pins inventory and exact interpretation identities without changing later inventory revisions", () => {
    const first = store.saveInventory("roster", 0, [expected], "prospective");
    const draft = request(); draft.inventory = { id: first.id, revision: first.revision };
    const admitted = store.admit(draft);
    store.saveInventory("roster", 1, [expected, { ...expected, shardId: "integration" }], "prospective");
    store.start(admitted.job.id, admitted.publicationToken);
    const set = store.publish(admitted.job.id, admitted.publicationToken, [{ sourceId: "source-1", raw, normalized: normalized() }])!;
    expect(set).toMatchObject({ coverage: "complete", inventory: first, parserVersion: "strict-1", initialRetention: "raw_and_normalized" });
    expect(set.sources[0]).toMatchObject({ authentication: "not_checked", artifactSha256: evidenceDigest(raw), normalizedSha256: evidenceDigest(canonicalEvidenceJson(normalized())) });
    expect(store.getInventory("roster", 1)).toEqual(first); expect(store.getInventory("roster", 2).expected).toHaveLength(2);
    expect(() => store.saveInventory("roster", 1, [expected], "prospective")).toThrow("changed");
  });
  test("duplicate byte digests remain two source memberships and duplicate shard coverage", () => {
    const inventory = store.saveInventory("roster", 0, [expected], "prospective");
    const draft = request(); draft.inventory = { id: inventory.id, revision: 1 }; draft.sources.push({ ...draft.sources[0], sourceId: "source-2" });
    const { set } = complete(draft);
    expect(set.sources).toHaveLength(2); expect(set.sources[0].artifactId).not.toBe(set.sources[1].artifactId);
    expect(set).toMatchObject({ coverage: "incomplete", duplicates: ["unit"] }); expect(count("blobs")).toBe(2);
  });
  test("absence of a trusted inventory stays not_declared even for an observed passing report", () => {
    const { set } = complete(); expect(set.coverage).toBe("not_declared"); expect(set.sources[0].reportOutcome).toBe("reports_pass");
    expect(set.sources[0].authentication).toBe("not_checked");
  });
  test("SQLite rejects in-place changes to raw bytes, normalized payload, interpretation, inventory and set history", () => {
    store.saveInventory("roster", 0, [expected], "prospective"); complete();
    for (const [table, column, value] of [["inventories", "data", "{}"], ["artifacts", "sha256", "different"], ["blobs", "bytes", raw],
      ["interpretations", "parser_version", "different"], ["payloads", "data", "{}"], ["sets", "data", "{}"]] as const) {
      expect(() => db.query(`UPDATE evaluation_evidence_${table} SET ${column}=?`).run(value)).toThrow("immutable evidence");
    }
  });
  test("bad raw bytes and omitted roster members cannot publish any partial records", () => {
    const admission = store.admit(request()); store.start(admission.job.id, admission.publicationToken);
    expect(() => store.publish(admission.job.id, admission.publicationToken, [{ sourceId: "source-1", raw: new Uint8Array([1]), normalized: normalized() }])).toThrow("exact admitted roster");
    expect(() => store.publish(admission.job.id, admission.publicationToken, [])).toThrow("entry limit");
    expect(count("artifacts")).toBe(0); expect(count("sets")).toBe(0); expect(store.getJob(admission.job.id).status).toBe("running");
  });
  test("mid-transaction storage failure rolls back blobs, metadata and final publication together", () => {
    const admission = store.admit(request()); store.start(admission.job.id, admission.publicationToken);
    db.exec("CREATE TRIGGER fixture_fail_publication BEFORE INSERT ON evaluation_evidence_sets BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END");
    const sources = [{ sourceId: "source-1", raw, normalized: normalized() }];
    expect(() => store.publish(admission.job.id, admission.publicationToken, sources)).toThrow("fixture publication failure");
    for (const table of ["artifacts", "blobs", "interpretations", "payloads", "sets"]) expect(count(table)).toBe(0);
    expect(store.getJob(admission.job.id).status).toBe("running");
    db.exec("DROP TRIGGER fixture_fail_publication"); expect(store.publish(admission.job.id, admission.publicationToken, sources)).not.toBeNull();
  });
  test("raw deletion changes current projection while historical interpretation, score and digest stay identical", () => {
    const { set } = complete(); const before = canonicalEvidenceJson(store.getSet(set.id, 1).revision);
    expect(store.exportRaw(set.id, 1, "source-1")).toEqual(raw);
    expect(store.removePayloads(set.id, 1, "raw_removed")).toBe(1); expect(store.removePayloads(set.id, 1, "raw_removed")).toBe(0);
    expect(store.getSet(set.id, 1).sources[0]).toMatchObject({ rawAvailable: false, normalizedAvailable: true, normalized: normalized() });
    expect(canonicalEvidenceJson(store.getSet(set.id, 1).revision)).toBe(before);
    expect(() => store.exportRaw(set.id, 1, "source-1")).toThrow("unavailable"); expect(count("retention_events")).toBe(1);
    expect(() => db.exec("UPDATE evaluation_evidence_retention_events SET kind='normalized_removed'")).toThrow("immutable evidence");
  });
  test("normalized privacy deletion withholds payload instead of rewriting an earlier machine observation", () => {
    const { set } = complete(); expect(store.removePayloads(set.id, 1, "normalized_removed")).toBe(1);
    const view = store.getSet(set.id, 1); expect(view.sources[0]).toMatchObject({ rawAvailable: true, normalizedAvailable: false, normalized: null });
    expect(view.revision.digest).toBe(set.digest); expect(view.revision.sources[0].reportOutcome).toBe("reports_pass");
  });
  test("disabled raw retention never publishes raw bytes, while normalized evidence remains available", () => {
    const { set } = complete({ ...request(), retention: "normalized_only" });
    expect(count("blobs")).toBe(0); expect(store.getSet(set.id, 1).sources[0]).toMatchObject({ rawAvailable: false, normalizedAvailable: true });
    expect(() => store.exportRaw(set.id, 1, "source-1")).toThrow("unavailable");
  });
  test("new parser creates an append-only revision and concurrent append cannot overwrite the winner", () => {
    const { set } = complete(); const previous = canonicalEvidenceJson(set);
    const draft = { ...request("append-1"), parserVersion: "strict-2", target: { setId: set.id, expectedRevision: 1 } };
    const a = store.admit(draft), b = store.admit({ ...draft, operationKey: "append-2" });
    store.start(a.job.id, a.publicationToken); store.start(b.job.id, b.publicationToken);
    const sources = [{ sourceId: "source-1", raw, normalized: normalized() }];
    const next = store.publish(a.job.id, a.publicationToken, sources)!;
    expect(next).toMatchObject({ id: set.id, revision: 2, parserVersion: "strict-2" });
    expect(store.publish(b.job.id, b.publicationToken, sources)).toBeNull(); expect(store.getJob(b.job.id)).toMatchObject({ status: "failed", failureCode: "revision_conflict" });
    expect(canonicalEvidenceJson(store.getSet(set.id, 1).revision)).toBe(previous); expect(store.getSet(set.id).revision.digest).toBe(next.digest);
  });
  test("authoritative capability is rechecked at publication and raw export, separately from normalized reads", () => {
    const admission = store.admit(request()); store.start(admission.job.id, admission.publicationToken); capabilities.delete("import");
    expect(() => store.publish(admission.job.id, admission.publicationToken, [{ sourceId: "source-1", raw, normalized: normalized() }])).toThrow("Current capability");
    expect(count("sets")).toBe(0); capabilities.add("import");
    const set = store.publish(admission.job.id, admission.publicationToken, [{ sourceId: "source-1", raw, normalized: normalized() }])!;
    capabilities.delete("raw_export"); expect(store.getSet(set.id).sources[0].normalized).toEqual(normalized());
    expect(() => store.exportRaw(set.id, 1, "source-1")).toThrow("Current capability");
  });
  test("scope boundaries hide identical digest artifacts without another scope's local singleton", () => {
    const { set } = complete(); db.query("INSERT INTO evaluation_evidence_scopes(scope_key,generation,active) VALUES('project:other',1,1)").run();
    const other = new EvidenceStore(db, { kind: "project", id: "other" }, options());
    expect(() => other.getSet(set.id, 1)).toThrow("not found"); expect(() => other.exportRaw(set.id, 1, "source-1")).toThrow("not found");
    const second = complete(request("other-operation"), other).set;
    expect(second.sources[0].artifactSha256).toBe(set.sources[0].artifactSha256); expect(second.sources[0].artifactId).not.toBe(set.sources[0].artifactId);
    other.removePayloads(second.id, 1, "raw_removed"); expect(store.exportRaw(set.id, 1, "source-1")).toEqual(raw);
  });
  test("an async or missing authority callback cannot admit work", () => {
    const asynchronous = new EvidenceStore(db, scope, { authorize: (() => Promise.resolve({ actorId: "cached" })) as unknown as EvidenceStoreOptions["authorize"] });
    expect(() => asynchronous.admit(request())).toThrow("plain object"); expect(count("jobs")).toBe(0);
    expect(() => new EvidenceStore(db, scope, {} as EvidenceStoreOptions)).toThrow("authoritative");
  });
  test("file-backed identities and retention projections survive a clean database reopen", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "rp-evidence-store-")), filename = path.join(directory, "evidence.db");
    let fileDb = new Database(filename);
    try {
      initialize(fileDb); fileDb.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
      let persisted = new EvidenceStore(fileDb, scope, options()); const { set } = complete(request(), persisted);
      persisted.removePayloads(set.id, 1, "raw_removed"); fileDb.close(); fileDb = new Database(filename); fileDb.exec("PRAGMA foreign_keys=ON");
      persisted = new EvidenceStore(fileDb, scope, options());
      expect(persisted.getSet(set.id, 1)).toMatchObject({ revision: set, sources: [{ sourceId: "source-1", rawAvailable: false, normalizedAvailable: true }] });
    } finally { fileDb.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
