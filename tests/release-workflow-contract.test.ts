import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("release workflow contracts", () => {
  test("the package setup command uses the shipped CLI", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.setup).toBe("bun src/index.ts setup");
  });

  test("the UI advertises the canonical setup command", () => {
    const source = read("app/src/components/ConnectionIndicator.tsx");
    expect(source).toContain('const setupCommand = "runphantom setup"');
    expect(source).not.toContain("bun src/index.ts runphantom mcp");
  });

  test("example orchestration exports the standard OTLP trace endpoint", () => {
    const source = read("scripts/dev-all.ts");
    expect(source).toContain("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
    expect(source).not.toContain("RUNPHANTOM_ENDPOINT");
    expect(source).not.toContain("pruneWrongClaudeAgentSdkLibcVariant");
    expect(source).not.toContain(".devin/");
  });

  test("examples do not claim an unverified Run Phantom domain", () => {
    expect(read("examples/go-chat/go.mod")).not.toContain("runphantom.dev");
  });

  test("functional LLM defaults use current supported model identifiers", () => {
    const server = read("src/server.ts");
    const replayUi = read("app/src/components/RunDetail.tsx");
    const replaySkill = read("skills/setup-agent-replay/SKILL.md");
    const anthropicExample = read("examples/anthropic-chat/server.ts");

    expect(server).toContain('RUNPHANTOM_DEMO_CHAT_MODEL ?? "gpt-5.6-luna"');
    expect(server).toContain('continuation.model ?? "claude-sonnet-5"');
    expect(replayUi).toContain('"claude-sonnet-5"');
    expect(replaySkill).toContain('"models": ["claude-sonnet-5", "gpt-5.6-luna"]');
    expect(anthropicExample).toContain('ANTHROPIC_MODEL || "claude-sonnet-5"');

    for (const source of [server, replayUi, replaySkill, anthropicExample]) {
      expect(source).not.toContain("gpt-5.5-nano");
      expect(source).not.toContain("claude-sonnet-4-20250514");
    }
  });
});
