import { CostAnalyticsWorkspace } from "../components/CostAnalytics";
import { projectApi } from "../api/team";
import { useAccount, useProject, useTeam } from "./context";

export function PricingPage() {
  const project = useProject(); const account = useAccount(); const { client, permissionRevisions } = useTeam();
  return <CostAnalyticsWorkspace scopeKey={["team", account.session.id, account.user.id, project.id, permissionRevisions[project.id] ?? 0]} title={project.name}
    load={(request, signal) => client.request(`${projectApi(project.id)}/pricing/analytics`, { method: "POST", body: request, signal })} />;
}
