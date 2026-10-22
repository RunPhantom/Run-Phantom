import { CostAnalyticsWorkspace } from "../components/CostAnalytics";
import { getLocalPricingAnalytics } from "../api/pricing";

export function CostAnalyticsPage() {
  return <CostAnalyticsWorkspace scopeKey={["local"]} title="Local captured runs" load={getLocalPricingAnalytics} />;
}
