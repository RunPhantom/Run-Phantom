import { Database } from "bun:sqlite";
import { acquireComparisonOwner } from "../../src/prompts/comparison-owner";

const db = new Database(process.argv[2]!);
let recoveryWrites = 0; const providerCalls = 0;
try {
  const owner = await acquireComparisonOwner(db.filename);
  owner.assertCurrent(owner.capture());
  db.query("UPDATE lease_probe SET recovery_writes=recovery_writes+1").run(); recoveryWrites++;
  process.stdout.write(JSON.stringify({ status: "owned", birth: owner.capture().birth, recoveryWrites, providerCalls }) + "\n");
  process.on("SIGTERM", async () => { await owner.close(); db.close(); process.exit(0); });
} catch (error) {
  db.close(); process.stdout.write(JSON.stringify({ status: "refused", reason: error instanceof Error && "reason" in error ? error.reason : "unavailable", recoveryWrites, providerCalls }) + "\n"); process.exit(0);
}
