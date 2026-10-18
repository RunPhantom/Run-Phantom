import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer as createViteServer } from "vite";

async function port() {
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address(); if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  await new Promise<void>(resolve => socket.close(() => resolve())); return address.port;
}
/** Real source Team daemon plus actual Vite app, with explicit private Team data and no host HOME override. */
export async function startTeamReviewFixture() {
  const root = path.resolve(import.meta.dirname, "../.."), profile = mkdtempSync(path.join(realpathSync(tmpdir()), "f30-team-ui-"));
  const apiPort = await port(), uiPort = await port(), url = `http://127.0.0.1:${uiPort}`, apiUrl = `http://127.0.0.1:${apiPort}`;
  const setupCode = randomBytes(32).toString("base64url");
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(key)));
  const child = spawn("bun", [path.join(root, "src/index.ts"), "team", "serve"], { cwd: profile, env: { ...inherited, RUNPHANTOM_TEAM_DATA_DIR: path.join(profile, "team"), RUNPHANTOM_TEAM_PORT: String(apiPort), RUNPHANTOM_TEAM_BIND_HOST: "127.0.0.1", RUNPHANTOM_TEAM_PUBLIC_ORIGIN: url, RUNPHANTOM_TEAM_BOOTSTRAP_CODE: setupCode }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", launchError: Error | null = null; child.on("error", cause => { launchError = cause; });
  child.stdout.on("data", bytes => { output = (output + bytes.toString()).slice(-32768); }); child.stderr.on("data", bytes => { output = (output + bytes.toString()).slice(-32768); });
  const birth = child.pid ? execFileSync("ps", ["-p", String(child.pid), "-o", "lstart="], { encoding: "utf8" }).trim() : "unavailable";
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  const close = async () => {
    await vite?.close();
    if (!launchError && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { const timer = setTimeout(() => child.kill("SIGKILL"), 2000); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM"); });
    let refused = false; try { await fetch(apiUrl + "/api/team/session", { signal: AbortSignal.timeout(300) }); } catch { refused = true; }
    const evidence = process.env.RUNPHANTOM_TEAM_REVIEW_EVIDENCE_DIR;
    if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(path.join(evidence, `fixture-${child.pid}.json`), JSON.stringify({ sourceRoot: root, pid: child.pid, birth, apiPort, uiPort, profile, exitCode: child.exitCode, signalCode: child.signalCode, listenerRefused: refused, hostHomeOverridden: false }, null, 2) + "\n"); }
    rmSync(profile, { recursive: true, force: true }); if (!refused) throw new Error("Owned Team fixture listener did not close");
  };
  try {
    vite = await createViteServer({ root: path.join(root, "app"), configFile: path.join(root, "app/vite.config.ts"), server: { host: "127.0.0.1", port: uiPort, strictPort: true, proxy: { "/api": { target: apiUrl, changeOrigin: false } }, fs: { allow: [root, realpathSync(path.join(root, "node_modules"))] } } });
    await vite.listen();
    let ready = false, lastStatus = 0;
    for (let attempt = 0; attempt < 400; attempt++) {
      if (launchError || child.exitCode !== null) throw new Error(`Owned Team daemon failed: ${output}`);
      try { if ((lastStatus = (await fetch(url + "/api/team/session", { signal: AbortSignal.timeout(500) })).status) === 200) { ready = true; break; } } catch { /* bounded startup wait */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!ready) throw new Error(`Owned Team daemon did not start: status=${lastStatus}; ${output}`);
    return { url, setupCode, close };
  } catch (cause) { await close(); throw cause; }
}
export type TeamReviewFixture = Awaited<ReturnType<typeof startTeamReviewFixture>>;
