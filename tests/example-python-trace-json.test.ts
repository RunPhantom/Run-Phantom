import { expect, test } from "bun:test";
import path from "node:path";

const SERVER = path.resolve(import.meta.dir, "../examples/python-chat/server.py");
// Imports the example with its provider and web packages mocked, then serializes argv[2] with trace_json.
const PROBE = `import json, runpy, sys
from unittest import mock
sys.modules["aiohttp"] = mock.MagicMock()
sys.modules["openai"] = mock.MagicMock()
module = runpy.run_path(sys.argv[1], run_name="trace_json_probe")
sys.stdout.buffer.write(module["trace_json"](json.loads(sys.argv[2])).encode("utf-8"))
`;

test("the Python example records a prompt exactly as the TypeScript example does", () => {
  // Repeated trials refused runs of the same soak prompt from the two examples as
  // "Candidate input does not match the frozen case input" because Python wrote ", " and ": ".
  const python = Bun.which("python3");
  expect(python, "python3 must be on PATH to run the Python example").not.toBeNull();
  const messages = [{ role: "user", content: "Unicode check: reply with ‘café’, 'naïve', 日本語" }];
  const result = Bun.spawnSync([python!, "-I", "-c", PROBE, SERVER, JSON.stringify(messages)], { cwd: path.dirname(SERVER), timeout: 10_000 });
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toBe(JSON.stringify(messages));
});
