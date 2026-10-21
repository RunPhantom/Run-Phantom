import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
const root = path.resolve(import.meta.dirname, "../.."), artifactRoot = path.resolve(process.env.F34_UI_ARTIFACT_ROOT ?? path.join(root, `.omx/evidence/F34/activation-ui-${Date.now()}-${process.pid}`));
export async function startComparisonFixture(mode: "local" | "team") {
  const profile = realpathSync(mkdtempSync(path.join(tmpdir(), `rp-comparison-ui-${mode}-`))), socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`, setupCode = randomBytes(32).toString("base64url");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(key)));
  const child = spawn("bun", [path.join(root, "tests/fixtures/prompt-comparison-ui-daemon.ts"), mode], { cwd: profile,
    env: { ...env, HOME: profile, USERPROFILE: profile, RUNPHANTOM_DB_PATH: path.join(profile, "owner.sqlite"), RUNPHANTOM_PORT: String(port), RUNPHANTOM_TEAM_PORT: String(port), RUNPHANTOM_TEAM_BIND_HOST: "127.0.0.1", RUNPHANTOM_TEAM_PUBLIC_ORIGIN: url, RUNPHANTOM_TEAM_DATA_DIR: path.join(profile, "team"), RUNPHANTOM_TEAM_BOOTSTRAP_CODE: setupCode, RUNPHANTOM_CLAUDE_CLI_CHAT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "", birth = "", launchError: Error | undefined;
  child.stdout.on("data", data => { logs = (logs + data.toString()).slice(-32768); }); child.stderr.on("data", data => { logs = (logs + data.toString()).slice(-32768); }); child.on("error", error => { launchError = error; });
  const close = async () => {
    if (!launchError && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 8000); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
    });
    mkdirSync(artifactRoot, { recursive: true }); writeFileSync(path.join(artifactRoot, `${mode}-native-${child.pid}-receipt.json`), JSON.stringify({ mode, pid: child.pid, birth, url, exitCode: child.exitCode, signalCode: child.signalCode, waitedReaped: child.exitCode !== null || child.signalCode !== null, providerCalls: 0, provenance: "controlled-http-fixture", logs }, null, 2));
    rmSync(profile, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; attempt < 240; attempt++) {
      if (launchError || child.exitCode !== null) throw new Error(`Native comparison fixture could not start: ${logs}`);
      if (logs.includes('"ready":true')) { birth = execFileSync("ps", ["-p", String(child.pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8" }).trim(); return { url, setupCode, profile, mode, artifactRoot, close }; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Native comparison fixture startup deadline");
  } catch (error) { await close(); throw error; }
}
