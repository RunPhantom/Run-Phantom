export type InstallAgentId = string;

export type InstallScope = "global" | "local";

export interface InstallAgentCapability {
  agent: InstallAgentId;
  label: string;
  detected: boolean;
  supportsSkills: boolean;
  supportsMcp: boolean;
}

export interface InstallChoice {
  agent: InstallAgentId;
  scope: InstallScope;
  cwd: string | null;
}

export interface InstallPlanItem extends InstallChoice {
  label: string;
}

export interface InstallPlan {
  items: InstallPlanItem[];
}
