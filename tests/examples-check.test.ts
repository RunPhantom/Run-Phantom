import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const manifest = fs.readFileSync(path.resolve(import.meta.dir, "../examples/package.json"), "utf8");

describe("examples aggregate check", () => {
  const folders = ["openai-chat", "anthropic-chat", "tool-agent"] as const;
  for (const codes of [[0, 0, 0], [17, 0, 0], [0, 23, 0], [0, 0, 29]]) {
    test(`executes the real aggregate command and propagates child exits ${codes.join("/")}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "example checks "));
      try {
        fs.writeFileSync(path.join(root, "package.json"), manifest);
        folders.forEach((folder, index) => {
          const dir = path.join(root, folder);
          fs.mkdirSync(dir);
          fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { check: "bun check.ts" } }));
          fs.writeFileSync(path.join(dir, "check.ts"), `import { writeFileSync } from "node:fs"; writeFileSync("../${folder}.ran", "yes"); process.exit(${codes[index]});`);
        });
        const result = Bun.spawnSync([process.execPath, "run", "check"], {
          cwd: root, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` }, timeout: 10_000,
        });
        const firstFailure = codes.findIndex((code) => code !== 0);
        expect(result.exitCode).toBe(firstFailure === -1 ? 0 : codes[firstFailure]);
        folders.forEach((folder, index) => {
          expect(fs.existsSync(path.join(root, `${folder}.ran`))).toBe(firstFailure === -1 || index <= firstFailure);
        });
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});
