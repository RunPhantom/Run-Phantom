import { homedir } from "node:os";
import { join } from "node:path";
import { writeServerToConfigFile, type McpServerConfig } from "agent-install/mcp";
import type { InstallAgentId, InstallScope } from "./types";

export interface CustomMcpInstallResult {
  agent: InstallAgentId;
  success: boolean;
  path: string;
  error?: string;
}

const WINDSURF_CONFIG_DIR = join(homedir(), ".codeium", "windsurf");
const WINDSURF_MCP_CONFIG = join(WINDSURF_CONFIG_DIR, "mcp_config.json");

export function getCustomMcpAgentIds(scope: InstallScope): InstallAgentId[] {
  return scope === "global" ? ["windsurf"] : [];
}

export function supportsCustomMcpAgent(agent: InstallAgentId, scope: InstallScope): boolean {
  return getCustomMcpAgentIds(scope).includes(agent);
}

export function installCustomMcpServerForAgent(
  serverName: string,
  serverConfig: McpServerConfig,
  agent: InstallAgentId,
  scope: InstallScope,
): CustomMcpInstallResult {
  if (agent !== "windsurf") {
    return { agent, success: false, path: "", error: `No custom MCP adapter for ${agent}` };
  }
  if (scope !== "global") {
    return {
      agent,
      success: false,
      path: WINDSURF_MCP_CONFIG,
      error: "Windsurf MCP installs are global-only",
    };
  }

  try {
    writeServerToConfigFile(WINDSURF_MCP_CONFIG, "jsonc", "mcpServers", serverName, serverConfig);
    return { agent, success: true, path: WINDSURF_MCP_CONFIG };
  } catch (err) {
    return { agent, success: false, path: WINDSURF_MCP_CONFIG, error: (err as Error).message };
  }
}
