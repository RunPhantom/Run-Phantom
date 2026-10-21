import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECORDING_STORAGE_SQL, RecordingStore, type RecordingAuthority } from "../../src/verification/recording";
import { RecordingInputError } from "../../src/verification/recording-types";

export function recordingStoreFixture() {
  const profile = mkdtempSync(join(tmpdir(), "rp-recording-store-"));
  const path = join(profile, "recordings.sqlite");
  let database = new Database(path, { strict: true });
  database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;"); database.exec(RECORDING_STORAGE_SQL);
  database.query("INSERT INTO browser_recording_scopes(scope_key,generation) VALUES(?,1)").run("local:fixture");
  let permitted = true, generation = 1;
  function store(scopeKey = "local:fixture"): RecordingStore {
    const ownerGeneration = generation;
    const authority: RecordingAuthority = { scopeKey, generation,
      assertCurrent() { if (!permitted) throw new RecordingInputError("Fixture authority revoked", 403); if (ownerGeneration !== generation) throw new RecordingInputError("Recording authority is no longer current", 409); },
      assertRun(runId) { if (!runId.startsWith("fixture-run-")) throw new RecordingInputError("Fixture run missing", 404); } };
    return new RecordingStore(database, authority);
  }
  return { get db() { return database; }, path, profile, store,
    revoke() { permitted = false; }, restore() { permitted = true; },
    restart() { database.close(); database = new Database(path, { strict: true }); database.exec("PRAGMA foreign_keys=ON;"); generation++; database.query("UPDATE browser_recording_scopes SET generation=? WHERE scope_key=?").run(generation, "local:fixture"); },
    close() { database.close(); rmSync(profile, { recursive: true, force: true }); },
  };
}
