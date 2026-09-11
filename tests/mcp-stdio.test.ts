import { expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CLI MCP stdio transport initializes and advertises Run Phantom tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.ts", "mcp"],
    cwd: repoRoot,
    env: {
      ...getDefaultEnvironment(),
      RUNPHANTOM_URL: "http://127.0.0.1:1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "runphantom-release-audit", version: "1.0.0" });

  try {
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("runphantom");
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("get_current_run");
    expect(names).toContain("query_traces");
    expect(names).toContain("ask_agent");
  } finally {
    await client.close();
  }
}, 15_000);
