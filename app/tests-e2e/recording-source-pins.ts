import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function recordingSourcePins() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const files = ["src/verification/recording-types.ts", "src/verification/recording.ts", "src/verification/browser/recorder.ts", "app/src/components/BrowserRecording.tsx",
    "tests/verification-recording-contract.test.ts", "tests/verification-recording-store.test.ts", "tests/helpers/recording-store-fixture.ts", "tests/fixtures/recording-player-daemon.ts",
    "app/tests-e2e/recording-native.spec.ts", "app/tests-e2e/recording-player-host.ts", "app/tests-e2e/recording-player-fixture.tsx", "app/tests-e2e/recording-source-pins.ts",
    "src/verification/browser-worker.ts", "src/verification/automation.ts", "src/verification/browser-contract.ts", "src/verification/browser-types.ts", "src/verification/browser-provider.ts", "src/verification/browser-router.ts",
    "src/db/schema.ts", "src/db.ts", "src/db/migration-assets.ts", "drizzle/meta/_journal.json", "src/team/store-schema.ts", "src/team/store.ts", "package.json", "bun.lock", "app/package.json", "app/src/index.css", "app/src/components/ui/button.tsx"];
  return { head: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim(),
    files: files.map(path => { const bytes = readFileSync(resolve(repo, path)); return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; }) };
}
