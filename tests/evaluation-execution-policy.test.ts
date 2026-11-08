import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseExecutionPolicy, readExecutionPolicyFile } from "../src/evaluations/execution-endpoint";

const endpoint = (overrides: Record<string, unknown> = {}) => ({ endpointName: "local-agent", revision: "r1", enabled: true, costAccount: "local", costMode: "free_local",
  maximumAttemptMicrousd: 0, maximumTotalMicrousd: 0, maximumOutputTokens: 256, maximumIterations: 2, ...overrides });

test("a free_local endpoint policy cannot authorize any paid attempt or total", () => {
  expect(parseExecutionPolicy({ version: 1, enabled: true, endpoints: [endpoint()] }).endpoints[0].costMode).toBe("free_local");
  expect(() => parseExecutionPolicy({ version: 1, enabled: true, endpoints: [endpoint({ maximumAttemptMicrousd: 1 })] })).toThrow("Free local policy cannot authorize paid work");
  expect(() => parseExecutionPolicy({ version: 1, enabled: true, endpoints: [endpoint({ maximumTotalMicrousd: 1 })] })).toThrow("Free local policy cannot authorize paid work");
  expect(() => parseExecutionPolicy({ version: 1, enabled: true, endpoints: [endpoint({ costMode: "paid" })] })).toThrow();
  expect(() => parseExecutionPolicy({ version: 1, enabled: true, endpoints: [endpoint({ consent: true })] })).toThrow();
});

test("a missing policy file disables execution and a group-readable file is refused", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "rp-execution-policy-")));
  try {
    chmodSync(directory, 0o700);
    expect(readExecutionPolicyFile(join(directory, "absent.json")).policy).toEqual({ version: 1, enabled: false, endpoints: [] });
    const file = join(directory, "policy.json");
    writeFileSync(file, JSON.stringify({ version: 1, enabled: true, endpoints: [endpoint({ costMode: "guarded_paid", maximumAttemptMicrousd: 1000, maximumTotalMicrousd: 1000 })] }), { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(() => readExecutionPolicyFile(file)).toThrow("Native execution policy file is unavailable");
    chmodSync(file, 0o600);
    expect(readExecutionPolicyFile(file).policy.endpoints[0].costMode).toBe("guarded_paid");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
