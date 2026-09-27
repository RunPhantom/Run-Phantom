import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXAMPLES = path.resolve(import.meta.dir, "../examples");
const KEYS = [
  "RP_ABOVE_REPO",
  "RP_ABOVE_REPO_LOCAL",
  "RP_REPO_ROOT",
  "RP_EXAMPLES_LOCAL",
  "RP_EXAMPLE_DIR",
  "RP_PRECEDENCE",
  "RP_PRESET",
];
const EXPECTED = {
  RP_ABOVE_REPO: null,
  RP_ABOVE_REPO_LOCAL: null,
  RP_REPO_ROOT: "loaded",
  RP_EXAMPLES_LOCAL: "loaded",
  RP_EXAMPLE_DIR: "loaded",
  RP_PRECEDENCE: "examples-local",
  RP_PRESET: "shell",
};

const TS_PROBE = `import { loadWorkspaceEnv } from "../loadEnv";
loadWorkspaceEnv(import.meta.url);
console.log(JSON.stringify(Object.fromEntries(process.argv.slice(2).map((key) => [key, process.env[key] ?? null]))));
`;

// Executes the real server.py top to bottom, so its import-time load_env()
// runs exactly as shipped; only the third-party SDKs are stubbed out.
const PYTHON_PROBE = `import json, os, runpy, sys
from unittest import mock
sys.modules["aiohttp"] = mock.MagicMock()
sys.modules["openai"] = mock.MagicMock()
runpy.run_path(sys.argv[1], run_name="env_probe")
print(json.dumps({key: os.environ.get(key) for key in sys.argv[2:]}))
`;

// <parent>/.env stands in for ~/Downloads/.env above a checkout at
// ~/Downloads/<repo>: it once handed unrelated provider keys and AWS
// credentials to every example process.
function withCheckoutBelowDecoy(run: (paths: { parent: string; repo: string }) => void): void {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rp-env-boundary-")));
  try {
    const repo = path.join(parent, "repo");
    const examples = path.join(repo, "examples");
    fs.mkdirSync(path.join(parent, "outside"));
    fs.mkdirSync(path.join(examples, "openai-chat"), { recursive: true });
    fs.mkdirSync(path.join(examples, "python-chat"), { recursive: true });
    fs.writeFileSync(path.join(parent, ".env"), "RP_ABOVE_REPO=leaked\n");
    fs.writeFileSync(path.join(parent, ".env.local"), "RP_ABOVE_REPO_LOCAL=leaked\n");
    fs.writeFileSync(path.join(repo, ".env"), "RP_REPO_ROOT=loaded\nRP_PRECEDENCE=repo\nRP_PRESET=file\n");
    fs.writeFileSync(path.join(examples, ".env.local"), "RP_EXAMPLES_LOCAL=loaded\nRP_PRECEDENCE=examples-local\n");
    fs.writeFileSync(path.join(examples, "openai-chat", ".env"), "RP_EXAMPLE_DIR=loaded\n");
    fs.writeFileSync(path.join(examples, "python-chat", ".env"), "RP_EXAMPLE_DIR=loaded\n");
    fs.copyFileSync(path.join(EXAMPLES, "loadEnv.ts"), path.join(examples, "loadEnv.ts"));
    fs.writeFileSync(path.join(examples, "openai-chat", "probe.ts"), TS_PROBE);
    fs.copyFileSync(path.join(EXAMPLES, "python-chat", "server.py"), path.join(examples, "python-chat", "server.py"));
    run({ parent, repo });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function probe(command: string[], cwd: string): unknown {
  const result = Bun.spawnSync([...command, ...KEYS], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", RP_PRESET: "shell" },
    timeout: 10_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString()) as unknown;
}

describe("example env loaders stay inside the repository", () => {
  test("TypeScript examples started from their own directory", () => {
    withCheckoutBelowDecoy(({ repo }) => {
      expect(probe([process.execPath, "probe.ts"], path.join(repo, "examples", "openai-chat"))).toEqual(EXPECTED);
    });
  });

  test("TypeScript examples started from a directory outside the repository", () => {
    withCheckoutBelowDecoy(({ parent, repo }) => {
      const entry = path.join(repo, "examples", "openai-chat", "probe.ts");
      expect(probe([process.execPath, entry], path.join(parent, "outside"))).toEqual(EXPECTED);
    });
  });

  test("Python example", () => {
    const python = Bun.which("python3");
    expect(python, "python3 must be on PATH to run the Python example").not.toBeNull();
    withCheckoutBelowDecoy(({ repo }) => {
      const server = path.join(repo, "examples", "python-chat", "server.py");
      expect(probe([python!, "-c", PYTHON_PROBE, server], path.dirname(server))).toEqual(EXPECTED);
    });
  });
});
