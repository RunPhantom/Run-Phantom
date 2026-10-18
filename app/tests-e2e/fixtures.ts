import { test as base, expect } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSourceFixtureOwner, observeSourceRequest, SourceFixtureError, spawnSourceFixture } from "./source-fixture-owner";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export type RunPhantomHandle = {
  url: string;
  dbPath: string;
  port: number;
};

const DAEMON_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    !key.startsWith("RUNPHANTOM_")
    && key !== "ANTHROPIC_API_KEY"
    && key !== "OPENAI_API_KEY"
  ),
);

async function waitForHealth(url: string, proc: ChildProcess, timeoutMs: number,
  diagnostics: Pick<ReturnType<typeof createSourceFixtureOwner>, "healthAttempt" | "healthResponse" | "healthRejection">): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode != null || proc.signalCode != null) {
      throw new SourceFixtureError("HEALTH_EXITED");
    }
    diagnostics.healthAttempt();
    try {
      const res = await fetch(`${url}/health`);
      const ok = res.ok;
      diagnostics.healthResponse(ok);
      if (ok) return;
    } catch (error) {
      diagnostics.healthRejection(error);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new SourceFixtureError("HEALTH_TIMEOUT");
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not resolve a free local port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

export const test = base.extend<{ runPhantom: RunPhantomHandle; localNetworkOnly: void }>({
  // Keep daemon setup before the inherited context so its built-in close runs first.
  context: async ({ runPhantom: _runPhantom, context }, use) => {
    await use(context);
  },
  localNetworkOnly: [async ({ page }, use) => {
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      const isDocumentLocal = ["about:", "blob:", "data:"].includes(url.protocol);
      if (isLocal || isDocumentLocal) await route.continue();
      else await route.abort("blockedbyclient");
    });
    await use();
  }, { auto: true }],
  runPhantom: async ({}, use, testInfo) => {
    const port = await reservePort();
    const tmp = mkdtempSync(path.join(realpathSync(tmpdir()), `runphantom-w${testInfo.workerIndex}-`));
    const dbPath = path.join(tmp, "runphantom.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });

    const proc = spawnSourceFixture(() => spawn("bun", ["src/index.ts", "serve"], {
      cwd: REPO_ROOT,
      env: {
        ...DAEMON_ENV,
        HOME: tmp,
        USERPROFILE: tmp,
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        RUNPHANTOM_OPENAI_API_KEY: "",
        RUNPHANTOM_PORT: String(port),
        RUNPHANTOM_BIND_HOST: "127.0.0.1",
        RUNPHANTOM_ALLOWED_HOSTS: "",
        RUNPHANTOM_ALLOWED_SOURCE_IPS: "",
        RUNPHANTOM_ALLOWED_ORIGINS: "",
        RUNPHANTOM_DB_PATH: dbPath,
        RUNPHANTOM_SECRET_STORE_PATH: path.join(tmp, "secrets.json"),
        RUNPHANTOM_CLAUDE_CLI_CHAT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }));
    const owner = createSourceFixtureOwner(proc, () => rmSync(tmp, { recursive: true, force: true }));
    await owner.run({
      handle: { url: `http://127.0.0.1:${port}`, dbPath, port },
      ready: () => waitForHealth(`http://127.0.0.1:${port}`, proc, 45_000, owner),
      use,
      afterUseStatus: () => ({ actual: testInfo.status, expected: testInfo.expectedStatus }),
    });
  },
});

export { expect, observeSourceRequest };
export const REPO_ROOT_PATH = REPO_ROOT;
