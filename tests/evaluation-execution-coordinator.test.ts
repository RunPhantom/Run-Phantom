import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

for (const scenario of ["population", "stale-owner", "cancelled"]) test(`inactive execution capture coordinator: actual native ${scenario}`, async () => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-execution-grading-"));
  const child = spawn(process.execPath, [path.resolve(import.meta.dir, "fixtures/execution-coordinator-control.ts"), scenario], {
    cwd: path.resolve(import.meta.dir, ".."), env: { HOME: directory, USERPROFILE: directory, PATH: process.env.PATH,
      RUNPHANTOM_DB_PATH: path.join(directory, "native.db"), RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json"),
      ...(process.env.F46_COORDINATOR_EVIDENCE_PATH ? { F46_NATIVE_EVIDENCE_PATH: process.env.F46_COORDINATOR_EVIDENCE_PATH } : {}),
      RUNPHANTOM_CLAUDE_CLI_CHAT: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", data => { output += String(data); }); child.stderr.on("data", data => { output += String(data); });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code] = await once(child, "close");
    if (process.env.F46_COORDINATOR_EVIDENCE_PATH) writeFileSync(path.join(process.env.F46_COORDINATOR_EVIDENCE_PATH, `${scenario}.log`), output);
    expect(code, output).toBe(0);
    expect(output).toContain(`"scenario":"${scenario}"`);
    expect(output).toContain('"providerCalls":0');
  } finally { clearTimeout(deadline); if (child.exitCode === null) { child.kill("SIGKILL"); await once(child, "close"); } rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
