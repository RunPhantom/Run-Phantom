import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";

export async function browserDaemon(profile: string, environment: Record<string, string> = {}) {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(key)));
  const proc = spawn(process.execPath, ["--no-env-file", path.resolve(import.meta.dir, "../../src/index.ts"), "serve"], { env: { ...env,
    RUNPHANTOM_PORT: String(port), RUNPHANTOM_DB_PATH: path.join(profile, "runs.db"), RUNPHANTOM_BROWSER_ARTIFACTS: path.join(profile, "artifacts"),
    RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_SKIP_WORKSPACE_ACTIVATE: "1", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", ...environment }, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = ""; for (const stream of [proc.stdout, proc.stderr]) stream?.on("data", (chunk: Buffer) => { if (diagnostic.length < 4000) diagnostic += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  const closed = new Promise<void>(resolve => proc.once("close", () => resolve()));
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM"); const force = setTimeout(() => proc.kill("SIGKILL"), 15000);
      await closed; clearTimeout(force);
    }
  };
  try {
    const until = Date.now() + 15000; let healthy = false;
    while (Date.now() < until) {
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Controlled source daemon exited: ${diagnostic}`);
      try { if ((await fetch(`${url}/health`)).ok) { healthy = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!healthy) throw new Error(`Controlled source daemon health unavailable: ${diagnostic}`);
    return { url, proc, stop, api: async <T = any>(route: string, body?: unknown, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}) => {
      const response = await fetch(`${url}/api/verification${route}`, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as T };
    } };
  } catch (error) { await stop(); throw error; }
}
export function isReaped(proc: ChildProcess): boolean { if (!proc.pid) return false; try { process.kill(proc.pid, 0); return false; } catch { return true; } }
