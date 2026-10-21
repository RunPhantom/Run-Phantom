import { Database } from "bun:sqlite";
import { startCodingHookOwner } from "../../src/coding-hooks/owner";

const db = new Database(process.argv[2]!);
try {
  const owner = await startCodingHookOwner(db);
  process.stdout.write(JSON.stringify({ status: "owned", birth: owner.lease.birth, ...db.query("SELECT generation,source_epoch FROM coding_hook_owner").get() as object }) + "\n");
  process.on("SIGTERM", async () => { await owner.close(); db.close(); process.exit(0); });
} catch (error) {
  db.close(); process.stdout.write(JSON.stringify({ status: "refused", reason: error instanceof Error && "reason" in error ? error.reason : "unavailable" }) + "\n"); process.exit(0);
}
