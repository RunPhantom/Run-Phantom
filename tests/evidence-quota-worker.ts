import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { EvidenceStore } from "../src/evaluations/evidence-store";
import { EvidenceError } from "../src/evaluations/evidence-protocol";
import { evidenceDigest } from "../src/evaluations/evidence-validation";

const [filename, barrier, ready, key] = Bun.argv.slice(2);
if (!filename || !barrier || !ready || !key) throw new Error("Quota fixture arguments required");
const db = new Database(filename);
try {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
  const raw = new TextEncoder().encode("synthetic report bytes");
  const store = new EvidenceStore(db, { kind: "local", id: "local" }, { authorize: () => ({ actorId: "fixture-operator" }), maxRawBytes: raw.byteLength });
  writeFileSync(ready, "ready"); const deadline = Date.now() + 5_000;
  while (!existsSync(barrier)) {
    if (Date.now() >= deadline) throw new Error("Quota fixture barrier timed out");
    await Bun.sleep(5);
  }
  try {
    const result = store.admit({ operationKey: key, target: null, attachment: { kind: "inspection", id: "review-1" },
      sources: [{ sourceId: "source-1", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(raw), byteLength: raw.byteLength }],
      inventory: null, parserVersion: "strict-1", policyVersion: "redaction-1", configurationSha256: evidenceDigest("configuration-1"), retention: "raw_and_normalized" });
    process.stdout.write(JSON.stringify({ admitted: true, id: result.job.id }));
  } catch (error) {
    if (!(error instanceof EvidenceError) || error.status !== 409 || !error.message.includes("quota")) throw error;
    process.stdout.write(JSON.stringify({ admitted: false, status: error.status }));
  }
} finally { db.close(); }
