import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import request from "supertest";
import { getDbPath } from "../src/db";

const ROOT = path.resolve(import.meta.dir, "..");
const DISTRIBUTABLE_TARGETS = [
  "src",
  "app",
  "bin",
  "examples",
  "scripts",
  "skills",
  "README.md",
  "AGENTS.md",
  "install.sh",
  "package.json",
  "bunfig.toml",
  "drizzle.config.ts",
];

const FORBIDDEN_IDENTITY_HASHES = new Set([
  "ee510d1a07ac7e6491ea191cd1918ea553ed2a358c8a0a04c1b90bd89222c314",
  "1a89614a7ae4f0ff33ad4cf25ee6512cdf87b763d086466ac684ebc596a57e2d",
  "4588f70d61b5b284b2d45f738cac4d581f8c7b5ec64a54167f76c4f4d4eb5ddc",
  "ed8bb924757d5f549c1e323d541a12fbb53534b291b8b9f20f69ce61f9a2b9b7",
]);

function hashIdentity(value: string): string {
  return createHash("sha256").update(value.toLowerCase()).digest("hex");
}

function lineContainsForbiddenIdentity(line: string): boolean {
  const candidates = line.toLowerCase().match(/[a-z][a-z0-9._-]*/g) ?? [];
  return candidates.some((candidate) => {
    const namespace = candidate.split("_")[0] ?? candidate;
    return FORBIDDEN_IDENTITY_HASHES.has(hashIdentity(candidate)) ||
      FORBIDDEN_IDENTITY_HASHES.has(hashIdentity(namespace));
  });
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8")) as T;
}

function walkFiles(relativePath: string): string[] {
  const absolutePath = path.join(ROOT, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return [absolutePath];

  const out: string[] = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "target" ||
      entry.name === "test-results"
    ) {
      continue;
    }
    out.push(...walkFiles(path.join(relativePath, entry.name)));
  }
  return out;
}

function collectForbiddenIdentityMatches(): string[] {
  const findings: string[] = [];
  for (const target of DISTRIBUTABLE_TARGETS) {
    for (const file of walkFiles(target)) {
      const raw = fs.readFileSync(file);
      if (raw.includes(0)) continue;
      const content = raw.toString("utf8");
      const rel = path.relative(ROOT, file);
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!lineContainsForbiddenIdentity(line)) continue;
        findings.push(`${rel}:${index + 1}: ${line.trim()}`);
        if (findings.length >= 40) {
          return findings;
        }
      }
    }
  }
  return findings;
}

describe("Run Phantom product identity contract", () => {
  test("package manifests expose the product slug", () => {
    const rootPackage = readJson<{ name: string; description?: string; bin?: Record<string, string>; maintainers?: Array<{ name?: string }> }>("package.json");
    const appPackage = readJson<{ name?: string }>(path.join("app", "package.json"));

    expect(rootPackage.name.toLowerCase()).toContain("runphantom");
    expect(rootPackage.description?.toLowerCase() ?? "").toContain("run phantom");
    expect(Object.keys(rootPackage.bin ?? {})).toContain("runphantom");
    expect(rootPackage.maintainers?.some((maintainer) => maintainer.name === "Divyam Talwar")).toBe(true);
    expect(appPackage.name?.toLowerCase() ?? "").toContain("runphantom");
  });

  test("browser source exposes the canonical daylight identity", () => {
    const html = fs.readFileSync(path.join(ROOT, "app", "index.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT, "app", "src", "index.css"), "utf8");
    const navigation = fs.readFileSync(path.join(ROOT, "app", "src", "components", "NavSidebar.tsx"), "utf8");
    const emptyState = fs.readFileSync(path.join(ROOT, "app", "src", "components", "EmptyState.tsx"), "utf8");
    const favicon = fs.readFileSync(path.join(ROOT, "app", "public", "favicon.svg"), "utf8");

    expect(html).toContain("<title>Run Phantom</title>");
    expect(html).toContain('name="author" content="Divyam Talwar"');
    expect(css).toContain("color-scheme: light");
    expect(css).toContain("--rp-canvas:");
    expect(`${navigation}\n${emptyState}`).toContain("See the run. Find the reason.");
    expect(favicon).toContain("#F8F4EE");
    expect(favicon).toContain("#C7462D");
    expect(favicon).not.toContain("linearGradient");
  });

  test("default local state path uses the runphantom slug", () => {
    const dbPath = getDbPath().replaceAll(path.sep, "/");
    expect(dbPath).toContain("/.runphantom/");
    expect(dbPath.endsWith("/runphantom.db")).toBe(true);
  });

  test("health reports runphantom identity, actual port, and rejects non-local hosts", async () => {
    let createServer: ((port: number) => Promise<{ server: Parameters<typeof request>[0] }>) | undefined;
    try {
      ({ createServer } = await import("../src/server"));
    } catch (error) {
      throw new Error(`server module failed to load for health verification: ${(error as Error).message}`);
    }

    const { server } = await createServer(0);
    try {
      const health = await request(server).get("/health").set("Host", "localhost");
      expect(health.status).toBe(200);
      expect(health.body?.ok).toBe(true);
      expect(health.body?.service).toBe("runphantom");
      expect(health.body?.port).toBeGreaterThan(0);

      const forbidden = await request(server).get("/health").set("Host", "evil.example");
      expect(forbidden.status).toBe(403);
      expect(forbidden.body).toEqual({ error: "forbidden" });
    } finally {
      server.close();
    }
  });

  test("all browser API mutations require an approved UI origin", async () => {
    const { createServer } = await import("../src/server");
    const { server } = await createServer(0);
    try {
      for (const method of ["post", "put", "patch", "delete"] as const) {
        const blocked = await request(server)[method]("/api/__origin_probe")
          .set("Host", "localhost")
          .set("Origin", "http://localhost:65530");
        expect(blocked.status).toBe(403);
        expect(blocked.body).toEqual({ error: "origin not allowed" });
      }

      const originless = await request(server).post("/api/__origin_probe").set("Host", "localhost");
      expect(originless.status).toBe(404);

      const uiOrigin = await request(server).post("/api/__origin_probe")
        .set("Host", "localhost")
        .set("Origin", "http://localhost:5948");
      expect(uiOrigin.status).toBe(404);

      const health = await request(server).get("/health").set("Host", "localhost");
      const daemonOrigin = await request(server).post("/api/__origin_probe")
        .set("Host", "localhost")
        .set("Origin", `http://localhost:${health.body.port}`);
      expect(daemonOrigin.status).toBe(404);
    } finally {
      server.close();
    }
  });

  test("distributable source contains no forbidden identity strings", () => {
    const findings = collectForbiddenIdentityMatches();
    expect(findings).toEqual([]);
  });
});
