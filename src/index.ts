#!/usr/bin/env node
/** Select shared or local authority before loading either runtime. */
if (process.argv[2] === "hooks" && process.argv[3] === "handle" && process.argv[4] === "claude") {
  // A host hook must not initialize the daemon/database or let telemetry failure affect its caller.
  const deadline = setTimeout(() => process.exit(0), 1500);
  try {
    const { runClaudeHookCallback } = await import("./coding-hooks/callback");
    await runClaudeHookCallback(process.argv.slice(5));
  } catch { /* Telemetry is silent and cannot block the host. */ }
  finally { clearTimeout(deadline); }
  process.exit(0);
} else if (process.argv[2] === "team") {
  try {
    const { runTeamCli } = await import("./team/cli");
    process.exit(await runTeamCli(process.argv.slice(3)));
  } catch {
    console.error("Run Phantom team could not start. Check the team configuration and data directory.");
    process.exit(1);
  }
} else {
  await import("./local-cli");
}

export {};
