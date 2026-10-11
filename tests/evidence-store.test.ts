import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvidenceStore, EVIDENCE_STORAGE_SQL, type EvidenceStoreOptions } from "../src/evaluations/evidence-store";
import { EVIDENCE_PREDICATE_TYPE, EVIDENCE_STATEMENT_TYPE, EvidenceError, type EvidenceCapability, type EvidenceExpectedSource, type EvidenceImportRequest, type NormalizedEvidenceSource } from "../src/evaluations/evidence-protocol";
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
  return { version: 1, sourceId, parseState: "parsed", interpretationComplete: true, reportOutcome: "reports_pass", leafCounts: deriveEvidenceCounts(leaves), observedExecutedLowerBound: "1", producerCounts: { tests: "1" },
    countsConsistent: true, assertedIdentity: { runnerId: null, commit: null, sourceSha256: null }, attestation: null, reasonCodes: [], leaves };
}
function attestation(sourceId: string, claimedReport = evidenceDigest(raw)): NormalizedEvidenceSource {
  const source = normalized(sourceId);
  return { ...source, leaves: [], leafCounts: { executed: null, passed: null, failed: null, errored: null, skipped: null, disabled: null, unknown: null },
    observedExecutedLowerBound: null, countsConsistent: null, producerCounts: null, reportOutcome: "unknown", attestation: {
      statementType: EVIDENCE_STATEMENT_TYPE, predicateType: EVIDENCE_PREDICATE_TYPE, payloadType: "application/vnd.in-toto+json", signatureCount: "2", signaturesChecked: false,
      producerResult: "PASSED", producerTests: { passed: ["producer test assertion"], warned: null, failed: null },
      subjects: [{ name: "unit-report.xml", digests: [{ algorithm: "sha256", value: claimedReport }] }],
      assertedCommits: ["a".repeat(40)], reportReferences: [{ subjectName: "unit-report.xml", sha256: claimedReport }],
    } };
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
  test("scope capability is checked before identifier lookup can reveal existence", () => {
    capabilities.clear();
    expect(() => store.getSet("absent", 1)).toThrow("Current capability");
    expect(() => store.getJob("absent")).toThrow("Current capability");
    expect(() => store.exportRaw("absent", 1, "source-1")).toThrow("Current capability");
    expect(() => store.cancel("absent")).toThrow("Current capability");
    expect(() => store.removePayloads("absent", 1, "raw_removed")).toThrow("Current capability");
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

describe("evidence job ownership and recovery", () => {
  test("wrong publication token and nonterminal status are independent publication predicates", () => {
    const admission = store.admit(request()), sources = [{ sourceId: "source-1", raw, normalized: normalized() }];
    expect(store.publish(admission.job.id, admission.publicationToken, sources)).toBeNull();
    expect(store.start(admission.job.id, "wrong-token")).toBe(false); expect(store.getJob(admission.job.id).status).toBe("queued");
    expect(store.start(admission.job.id, admission.publicationToken)).toBe(true);
    expect(store.publish(admission.job.id, "wrong-token", sources)).toBeNull(); expect(count("sets")).toBe(0);
    const set = store.publish(admission.job.id, admission.publicationToken, sources)!;
    expect(store.publish(admission.job.id, admission.publicationToken, sources)).toBeNull();
    expect(store.getJob(admission.job.id)).toMatchObject({ status: "completed", setId: set.id }); expect(count("sets")).toBe(1);
  });
  test("explicit cancellation prevents late callbacks and identical retry does not silently rerun it", () => {
    const admission = store.admit(request()); store.start(admission.job.id, admission.publicationToken);
    expect(store.cancel(admission.job.id)).toBe(true); expect(store.cancel(admission.job.id)).toBe(false);
    expect(store.publish(admission.job.id, admission.publicationToken, [{ sourceId: "source-1", raw, normalized: normalized() }])).toBeNull();
    const retry = store.admit(request()); expect(retry).toMatchObject({ reused: true, job: { id: admission.job.id, status: "cancelled" } });
    expect(store.start(retry.job.id, retry.publicationToken)).toBe(false); expect(count("sets")).toBe(0);
  });
  test("scope generation invalidation rejects a formerly valid running token", () => {
    const admission = store.admit(request()); store.start(admission.job.id, admission.publicationToken);
    db.exec("UPDATE evaluation_evidence_scopes SET generation=generation+1 WHERE scope_key='local:local'");
    expect(store.publish(admission.job.id, admission.publicationToken, [{ sourceId: "source-1", raw, normalized: normalized() }])).toBeNull();
    expect(count("blobs")).toBe(0); expect(count("sets")).toBe(0);
  });
  test("queue time and running time share the immutable admission deadline", () => {
    let now = 1_000; const timed = new EvidenceStore(db, scope, options({ now: () => now }));
    const waiting = timed.admit(request()); expect(waiting.job.deadlineAt).toBe(16_000); now = 16_000;
    expect(timed.start(waiting.job.id, waiting.publicationToken)).toBe(false);
    expect(timed.getJob(waiting.job.id)).toMatchObject({ status: "failed", failureCode: "deadline_exceeded" });
    const running = timed.admit(request("running")); expect(timed.start(running.job.id, running.publicationToken)).toBe(true); now = running.job.deadlineAt;
    expect(timed.publish(running.job.id, running.publicationToken, [{ sourceId: "source-1", raw, normalized: normalized() }])).toBeNull();
    expect(timed.getJob(running.job.id)).toMatchObject({ status: "failed", failureCode: "deadline_exceeded" });
    expect(count("sets")).toBe(0);
  });
  test("restart recovery terminalizes all unfinished attempts and releases reserved capacity", () => {
    const active = store.admit(request()), queued = store.admit(request("queued")); store.start(active.job.id, active.publicationToken);
    const reopened = new EvidenceStore(db, scope, options()); expect(reopened.recoverUnfinished()).toBe(2); expect(reopened.recoverUnfinished()).toBe(0);
    for (const admission of [active, queued]) {
      expect(reopened.getJob(admission.job.id)).toMatchObject({ status: "failed", failureCode: "restart_interrupted" });
      expect(reopened.publish(admission.job.id, admission.publicationToken, [{ sourceId: "source-1", raw, normalized: normalized() }])).toBeNull();
    }
    expect(db.query("SELECT sum(reserved_raw_bytes) AS raw,sum(reserved_normalized_bytes) AS normalized FROM evaluation_evidence_jobs").get()).toEqual({ raw: 0, normalized: 0 });
    expect(reopened.admit(request()).job.id).toBe(active.job.id); expect(count("sets")).toBe(0);
  });
  test("retention removal fences already running reparses before removed payloads can be recreated", () => {
    for (const kind of ["raw_removed", "normalized_removed"] as const) {
      const { set } = complete(request(`initial-${kind}`));
      const append = store.admit({ ...request(`append-${kind}`), target: { setId: set.id, expectedRevision: 1 }, parserVersion: "strict-2" });
      store.start(append.job.id, append.publicationToken); store.removePayloads(set.id, 1, kind);
      expect(store.getJob(append.job.id)).toMatchObject({ status: "failed", failureCode: "retention_changed" });
      expect(store.publish(append.job.id, append.publicationToken, [{ sourceId: "source-1", raw, normalized: normalized() }])).toBeNull();
      expect(store.getSet(set.id).revision.revision).toBe(1);
    }
  });
  test("privacy clear removes all payload and identity copies, advances generation and cannot resurrect late work", () => {
    store.saveInventory("roster", 0, [expected], "prospective"); const { set } = complete();
    store.removePayloads(set.id, 1, "raw_removed"); const waiting = store.admit(request("pending")); store.start(waiting.job.id, waiting.publicationToken);
    store.purgeScope();
    for (const table of ["inventory_heads", "inventories", "jobs", "artifacts", "blobs", "interpretations", "payloads", "sets", "retention_events"]) expect(count(table)).toBe(0);
    expect(db.query("SELECT generation FROM evaluation_evidence_scopes WHERE scope_key='local:local'").get()).toEqual({ generation: 2 });
    expect(() => store.publish(waiting.job.id, waiting.publicationToken, [{ sourceId: "source-1", raw, normalized: normalized() }])).toThrow("not found");
    const fresh = store.admit(request()); expect(fresh.job).toMatchObject({ scopeGeneration: 2, status: "queued" }); expect(fresh.job.id).not.toBe(waiting.job.id);
  });
});

describe("immutable attestation assertions", () => {
  function draft() {
    const requestValue = request(); requestValue.retention = "normalized_only";
    const assertionRaw = new TextEncoder().encode("synthetic normalized attestation fixture, not parser proof");
    requestValue.sources.push({ sourceId: "assertion", kind: "attestation", dialect: "dsse-envelope/v1", shardId: "assertion",
      artifactSha256: evidenceDigest(assertionRaw), byteLength: assertionRaw.byteLength });
    return { requestValue, assertionRaw };
  }
  test("fake signatures and matching commits remain assertions limited to the one referenced report", () => {
    const { requestValue, assertionRaw } = draft(); const otherRaw = new TextEncoder().encode("other synthetic report");
    requestValue.sources.push({ ...requestValue.sources[0], sourceId: "other-report", shardId: "other", artifactSha256: evidenceDigest(otherRaw), byteLength: otherRaw.byteLength });
    const inventory = store.saveInventory("roster", 0, [{ ...expected, constraints: { ...expected.constraints, commit: "a".repeat(40) } }], "prospective");
    requestValue.inventory = { id: inventory.id, revision: 1 };
    const admitted = store.admit(requestValue); store.start(admitted.job.id, admitted.publicationToken);
    const set = store.publish(admitted.job.id, admitted.publicationToken, [{ sourceId: "source-1", raw, normalized: normalized() },
      { sourceId: "assertion", raw: assertionRaw, normalized: attestation("assertion") }, { sourceId: "other-report", raw: otherRaw, normalized: normalized("other-report") }])!;
    expect(set.sources[0]).toMatchObject({ reportIdentityAsserted: true, commitAssertionMatches: true, authentication: "not_checked" });
    expect(set.sources[1]).toMatchObject({ reportOutcome: "unknown", leafCounts: { executed: null }, reportReferences: [{ linkedSourceId: "source-1", resolution: "matched" }], authentication: "not_checked" });
    expect(set.sources[2]).toMatchObject({ reportIdentityAsserted: false, commitAssertionMatches: null, authentication: "not_checked" });
    const retained = store.getSet(set.id).sources[1]; expect(retained.rawAvailable).toBe(false);
    expect(retained.normalized!.attestation).toEqual(attestation("assertion").attestation);
  });
  test("missing report digests and identical-byte membership stay unresolved or ambiguous instead of covering siblings", () => {
    for (const duplicate of [false, true]) {
      const { requestValue, assertionRaw } = draft(); requestValue.operationKey = `reference-${duplicate}`;
      if (duplicate) requestValue.sources.push({ ...requestValue.sources[0], sourceId: "duplicate" });
      const admitted = store.admit(requestValue); store.start(admitted.job.id, admitted.publicationToken);
      const sources = [{ sourceId: "source-1", raw, normalized: normalized() }, { sourceId: "assertion", raw: assertionRaw,
        normalized: attestation("assertion", duplicate ? evidenceDigest(raw) : evidenceDigest("absent report")) }];
      if (duplicate) sources.push({ sourceId: "duplicate", raw, normalized: normalized("duplicate") });
      const set = store.publish(admitted.job.id, admitted.publicationToken, sources)!;
      expect(set.sources[1].reportReferences[0]).toMatchObject({ linkedSourceId: null, resolution: duplicate ? "ambiguous" : "unresolved" });
      expect(set.sources.every(source => source.reportIdentityAsserted === false)).toBe(true);
    }
  });
  test("producer failure assertions do not become executed report failures, and unsupported schema stays unparsed", () => {
    const summary = attestation("assertion"); summary.attestation!.producerResult = "FAILED";
    summary.attestation!.producerTests.failed = ["producer failure assertion"];
    const { requestValue, assertionRaw } = draft(); const admitted = store.admit(requestValue); store.start(admitted.job.id, admitted.publicationToken);
    const sources = [{ sourceId: "source-1", raw, normalized: normalized() }, { sourceId: "assertion", raw: assertionRaw, normalized: summary }];
    summary.attestation!.predicateType = "unsupported/v9";
    expect(() => store.publish(admitted.job.id, admitted.publicationToken, sources)).toThrow("exactly supported schema");
    summary.parseState = "unparsed"; summary.interpretationComplete = false; summary.reasonCodes = ["unsupported_schema"];
    const set = store.publish(admitted.job.id, admitted.publicationToken, sources)!;
    expect(set.sources[1]).toMatchObject({ parseState: "unparsed", reportOutcome: "unknown", leafCounts: { executed: null }, authentication: "not_checked" });
  });
});

describe("transactional evidence resource reservations", () => {
  test("identical retries reuse admission even at quota, while changed bytes or configuration conflict", () => {
    const limited = new EvidenceStore(db, scope, options({ maxRawBytes: raw.byteLength }));
    const admitted = limited.admit(request()); expect(limited.admit(request())).toMatchObject({ reused: true, job: admitted.job });
    expect(() => limited.admit(request("another"))).toThrow("quota");
    for (const change of [{ policyVersion: "different" }, { parserVersion: "different" }, { configurationSha256: evidenceDigest("different") },
      { retention: "normalized_only" }, { sources: [{ ...request().sources[0], artifactSha256: evidenceDigest("other bytes") }] }]) {
      expect(() => limited.admit({ ...request(), ...change })).toThrow("different bytes or configuration");
    }
    expect(limited.cancel(admitted.job.id)).toBe(true); expect(limited.admit(request("after-cancel")).job.status).toBe("queued");
  });
  test("retained normalized revision bytes count toward quota after payload deletion", () => {
    const { set } = complete(); store.removePayloads(set.id, 1, "normalized_removed");
    const limited = new EvidenceStore(db, scope, options({ maxNormalizedBytes: 4 * 1024 * 1024 }));
    expect(() => limited.admit(request("more"))).toThrow("quota");
    limited.purgeScope(); expect(limited.admit(request("more")).job.status).toBe("queued");
  });
  test("terminal failures cannot create unlimited durable job records", () => {
    const limited = new EvidenceStore(db, scope, options({ maxRevisions: 1 }));
    const admission = limited.admit(request()); limited.cancel(admission.job.id);
    expect(limited.admit(request()).reused).toBe(true); expect(() => limited.admit(request("another"))).toThrow("job or revision retention");
  });
  test("active and queued limits span every scope within the injected database", () => {
    db.exec("INSERT INTO evaluation_evidence_scopes(scope_key,generation,active) VALUES('project:other',1,1)");
    const other = new EvidenceStore(db, { kind: "project", id: "other" }, options());
    const a = store.admit(request("active-a")), b = other.admit(request("active-b"));
    expect(store.start(a.job.id, a.publicationToken)).toBe(true); expect(other.start(b.job.id, b.publicationToken)).toBe(true);
    const pending = Array.from({ length: 8 }, (_, i) => i % 2 ? other.admit(request(`pending-${i}`)) : store.admit(request(`pending-${i}`)));
    expect(store.start(pending[0].job.id, pending[0].publicationToken)).toBe(false);
    expect(() => other.admit(request("overflow"))).toThrow("queue is full");
    store.cancel(a.job.id); expect(store.start(pending[0].job.id, pending[0].publicationToken)).toBe(true);
  });
  test("normalized byte bounds reject oversized text before forming one giant retained string", () => {
    const source = normalized(); source.leaves = Array.from({ length: 2_000 }, (_, i) => ({ ...source.leaves[0], id: `leaf-${i}`, detail: "x".repeat(4096) }));
    source.leafCounts = deriveEvidenceCounts(source.leaves); source.observedExecutedLowerBound = "2000"; source.producerCounts = null;
    const admitted = store.admit(request()); store.start(admitted.job.id, admitted.publicationToken);
    expect(() => store.publish(admitted.job.id, admitted.publicationToken, [{ sourceId: "source-1", raw, normalized: source }])).toThrow("4 MiB");
    expect(count("payloads")).toBe(0); expect(count("blobs")).toBe(0);
  });
  test("two actual processes racing one SQLite quota cannot both reserve the last capacity", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "rp-evidence-quota-")), filename = path.join(directory, "race.db"), barrier = path.join(directory, "go");
    const fileDb = new Database(filename); const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      initialize(fileDb); fileDb.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000");
      const env = { ...process.env }; for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) delete env[key];
      const ready = [path.join(directory, "ready-a"), path.join(directory, "ready-b")];
      const worker = fileURLToPath(new URL("./evidence-quota-worker.ts", import.meta.url));
      ready.forEach((marker, i) => children.push(Bun.spawn([process.execPath, "run", worker, filename, barrier, marker, `race-${i}`], { env, stdout: "pipe", stderr: "pipe" })));
      const deadline = Date.now() + 5_000;
      while (!ready.every(marker => existsSync(marker))) { if (Date.now() >= deadline) throw new Error("Quota fixture readiness timed out"); await Bun.sleep(5); }
      writeFileSync(barrier, "go");
      const output = await Promise.all(children.map(async child => {
        const stdout = new Response(child.stdout as ReadableStream).text(), stderr = new Response(child.stderr as ReadableStream).text();
        const result = await Promise.race([child.exited, Bun.sleep(5_000).then(() => { throw new Error("Quota fixture process timed out"); })]);
        expect(result).toBe(0); expect(await stderr).toBe(""); return JSON.parse(await stdout) as { admitted: boolean };
      }));
      expect(output.filter(result => result.admitted)).toHaveLength(1); expect(output.filter(result => !result.admitted)).toHaveLength(1);
      expect(fileDb.query("SELECT count(*) AS n,sum(reserved_raw_bytes) AS bytes FROM evaluation_evidence_jobs").get()).toEqual({ n: 1, bytes: raw.byteLength });
    } finally {
      for (const child of children) { if (child.exitCode === null) child.kill(); await child.exited; }
      fileDb.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
