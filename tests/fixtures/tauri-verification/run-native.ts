/** Real packaged-fixture entry point. Never downloads, builds, or substitutes a browser. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CooperatingTauriAdapter, TauriArtifactStore, TauriProcessTransport } from "../../../src/verification/adapters/tauri";

const fixture = path.join(import.meta.dir, "src-tauri");
const executable = path.join(fixture, "target/release/bundle/macos/Run Phantom Tauri Fixture.app/Contents/MacOS/runphantom-tauri-fixture");
const emit = (status: "BLOCKED" | "PASS" | "FAIL", reason: string, extra: object = {}): void => console.log(JSON.stringify({ feature: "F40", profile: "real-packaged-tauri", status, reason, ...extra }));
if (process.platform !== "darwin") { emit("BLOCKED", "platform-unqualified"); process.exit(78); }
if (!existsSync(path.join(fixture, "Cargo.toml"))) { emit("BLOCKED", "native-framework-dependencies-not-approved-or-installed"); process.exit(78); }
if (!existsSync(executable) || lstatSync(executable).isSymbolicLink() || realpathSync(executable) !== executable) { emit("BLOCKED", "real-packaged-fixture-unavailable"); process.exit(78); }
// A host-owned absent directory and allowlisted environment never inherit user auth/providers.
const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-tauri-native-")));
const privateHome = path.join(parent, "home");
const { mkdirSync } = await import("node:fs"); mkdirSync(privateHome, { mode: 0o700 });
const nonce = randomBytes(32).toString("hex");
const child = spawn(executable, [], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: privateHome, USERPROFILE: privateHome, TMPDIR: parent, RP_TAURI_FIXTURE_NONCE: nonce }, stdio: "pipe" });
const transport = new TauriProcessTransport(child);
const adapter = new CooperatingTauriAdapter({ application: "dev.runphantom.tauri-fixture", window: "verification-fixture", nonce, actions: ["increment", "reset"] }, transport, new TauriArtifactStore(path.join(parent, "captures")));
let primary: unknown;
let evidence: object | undefined;
try {
  const initial = await adapter.compare(0); if (initial.status !== "pass") throw new Error("initial-state");
  await adapter.action("increment"); const changed = await adapter.compare(1); if (changed.status !== "pass") throw new Error("changed-state");
  const capture = await adapter.capture({ mode: "private-raw", consent: true });
  evidence = { capture, inputMode: "cooperating-ipc", platform: process.platform, arch: process.arch };
} catch (error) { primary = error; emit("FAIL", "packaged-fixture-journey-failed"); }
try { await adapter.close(); rmSync(parent, { recursive: true }); if (!primary && evidence) emit("PASS", "cooperating-counter-and-owned-window-capture", evidence); }
catch { emit("FAIL", "owned-cleanup-unconfirmed-profile-retained"); process.exitCode = 1; }
if (primary) process.exitCode = 1;
