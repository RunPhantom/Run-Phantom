import { useMemo } from "react";
import { projectApi } from "../api/team";
import { PromptWorkspace } from "../components/prompts/PromptWorkspace";
import type { PromptClient } from "../components/prompts/client";
import { useAccount, useProject, useTeam } from "./context";
export function PromptsPage() {
  const project = useProject(), account = useAccount(), { client, permissionRevisions } = useTeam();
  const transport = useMemo<PromptClient>(() => ({ request: (path, options) => client.prompts(`${projectApi(project.id)}/prompts${path}`, options) }), [client, project.id]);
  return <PromptWorkspace key={`${account.session.id}:${project.id}:${project.role}:${permissionRevisions[project.id] ?? 0}`} client={transport} canEdit={project.role !== "viewer"} canDelete={project.role === "admin"} scopeLabel={project.name} />;
}
