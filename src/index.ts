#!/usr/bin/env node
/** Internal readers must finish before loading either authority runtime. */
if (process.argv[2] === "__runphantom_evidence_worker_v1") {
  if (process.argv.length !== 3) process.exit(1);
  const { EVIDENCE_WORKER_FAILURE, prepareEvidenceWorkerEnvironment } = await import("./evaluations/evidence-worker-environment");
  if (!prepareEvidenceWorkerEnvironment()) {
    await Bun.write(Bun.stdout, EVIDENCE_WORKER_FAILURE);
    process.exit(1);
  }
  const { runEvidenceWorker } = await import("./evaluations/evidence-worker");
  process.exit(await runEvidenceWorker());
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
