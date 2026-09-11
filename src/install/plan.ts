import { agentLabel } from "./detect";
import type { InstallAgentId, InstallPlan, InstallScope } from "./types";

export interface BuildInstallPlanOptions {
  agents: InstallAgentId[];
  scope: InstallScope;
  cwd: string;
}

export function buildInstallPlan(opts: BuildInstallPlanOptions): InstallPlan {
  return {
    items: opts.agents.map((agent) => ({
      agent,
      scope: opts.scope,
      cwd: opts.scope === "local" ? opts.cwd : null,
      label: agentLabel(agent),
    })),
  };
}
