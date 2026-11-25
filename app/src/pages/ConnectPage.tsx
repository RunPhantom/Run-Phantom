import { useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/ui/typography";
import { ConnectAgentPanel } from "../components/connect/ConnectAgentPanel";
import { isConnectTab, type ConnectTabId } from "../components/connect/connect-snippets";

export function ConnectPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: ConnectTabId = isConnectTab(requested) ? requested : "typescript";
  const setTab = (next: ConnectTabId) => {
    setParams(current => {
      const updated = new URLSearchParams(current);
      if (next === "typescript") updated.delete("tab"); else updated.set("tab", next);
      return updated;
    }, { replace: true });
  };

  return (
    <div className="rp-page" data-connect-page>
      <PageHeader
        eyebrow="Connect / 2 minutes"
        title="Connect an agent"
        description="Send traces from your app or coding agent to this machine. They stay here."
      />
      <ConnectAgentPanel split tab={tab} onTabChange={setTab} className="mt-6 max-w-[1180px]" />
    </div>
  );
}
