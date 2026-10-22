import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer, request as httpRequest } from "node:http";
import { EvidenceStore, EVIDENCE_STORAGE_SQL } from "../src/evaluations/evidence-store";
import { EvidenceImportService, EVIDENCE_READER_IDENTITY, EVIDENCE_IMPORT_CONTENT_TYPE } from "../src/evaluations/evidence-import";
import { EvidenceSupervisor } from "../src/evaluations/evidence-supervisor";
import { EvidenceError } from "../src/evaluations/evidence-protocol";
import { evidenceDigest } from "../src/evaluations/evidence-validation";
import type { EvidenceOwner } from "../src/evaluations/evidence-inventory";

test("authorized clear reaps a held upload after the original importer is revoked in SQLite", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON"); db.exec(EVIDENCE_STORAGE_SQL);
  db.exec("INSERT INTO evaluation_evidence_scopes VALUES('project:project-1',1,1); CREATE TABLE current_members(actor TEXT PRIMARY KEY, role TEXT); INSERT INTO current_members VALUES('importer','editor'),('administrator','admin')");
  const scope = { kind: "project", id: "project-1" } as const;
  function owner(actorId: string): EvidenceOwner {
    const authorize: EvidenceOwner["authorize"] = capability => {
      const row = db.query("SELECT role FROM current_members WHERE actor=?").get(actorId) as { role: string } | null;
      if (!row || capability !== "normalized_read" && row.role !== "admin" && (capability !== "import" || row.role !== "editor")) throw new EvidenceError("Current importer authority is unavailable", 403);
      return { actorId };
    };
    return { database: db, scope, authorize, resolveAnchor: anchor => ({ anchor, createdAt: 1 }), store: new EvidenceStore(db, scope, { authorize: (capability, _scope, attachment) => authorize(capability, attachment) }) };
  }
  const service = new EvidenceImportService(new EvidenceSupervisor());
  const original = owner("importer"), admin = owner("administrator");
  const server = createServer((req, res) => { void service.receive(original, req).then(value => { res.writeHead(202).end(JSON.stringify(value)); }, () => { res.writeHead(409).end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing listener");
  const raw = Buffer.from('<testsuite tests="1"><testcase name="Held source"/></testsuite>');
  const header = Buffer.from(JSON.stringify({ version: 1, request: { ...EVIDENCE_READER_IDENTITY, operationKey: "revoked-held", attachment: { kind: "run", id: "run-1" }, target: null, inventory: null, retention: "normalized_only", sources: [{ sourceId: "source-1", shardId: "unit", kind: "junit", dialect: "junit-xml/v1", byteLength: raw.byteLength, artifactSha256: evidenceDigest(raw) }] } }));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.byteLength);
  const request = httpRequest({ hostname: "127.0.0.1", port: address.port, method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE, "Content-Length": 4 + header.byteLength + raw.byteLength } });
  request.on("error", () => {}); request.on("response", response => response.resume()); request.write(Buffer.concat([length, header]));
  try {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !(db.query("SELECT id FROM evaluation_evidence_jobs WHERE operation_key='revoked-held'").get())) await Bun.sleep(5);
    expect(db.query("SELECT status FROM evaluation_evidence_jobs WHERE operation_key='revoked-held'").get()).toEqual({ status: "running" });
    db.exec("DELETE FROM current_members WHERE actor='importer'");
    expect(await service.clear(admin)).toBeUndefined();
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_jobs").get()).toEqual({ n: 0 });
    expect(db.query("SELECT generation FROM evaluation_evidence_scopes").get()).toEqual({ generation: 2 });
    expect(service.state).toMatchObject({ active: 0, queued: 0, acquiringMetadata: 0 });
  } finally {
    request.destroy(); await service.shutdown();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); db.close();
  }
});
