import { useMemo } from "react";
import { ConnectAgentPanel } from "../../components/connect/ConnectAgentPanel";
import { TeachingEmptyState } from "../../components/empty/TeachingEmptyState";
import { KpiStrip } from "./HomeKpis";
import { AgentsPanel, ModelsPanel, NeedsALookPanel, RunsOverTimePanel } from "./HomePanels";
import { sampleOverview } from "./sample-overview";

/** Nothing captured yet: a faded, labelled sample of this page behind the connect guide. */
export function HomeEmptyState({ onLoadSamples, loading, loadError }: { onLoadSamples: () => void | Promise<void>; loading: boolean; loadError: string | null }) {
  const sample = useMemo(() => sampleOverview(Date.now()), []);
  const ghost = (
    <div data-home-ghost aria-hidden="true">
      <KpiStrip overview={sample} interactive={false} />
      <div className="mt-4 grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7"><RunsOverTimePanel overview={sample} interactive={false} /></div>
        <div className="lg:col-span-5"><NeedsALookPanel overview={sample} /></div>
        <div className="lg:col-span-6"><AgentsPanel overview={sample} /></div>
        <div className="lg:col-span-6"><ModelsPanel overview={sample} /></div>
      </div>
    </div>
  );

  return (
    <TeachingEmptyState
      ghost={ghost}
      eyebrow="Get started / 2 minutes"
      title="Your first run will appear here."
      titleId="home-get-started"
      lede="Point your agent at this machine, or send a test span to see the path work."
      data-home-empty
    >
      <div data-home-setup>
        <ConnectAgentPanel compact waitingLabel="Waiting for your first run…" onLoadSamples={onLoadSamples} samplesLoading={loading} />
        {loadError && <p role="alert" className="mt-2 text-12 text-rp-danger">{loadError}</p>}
      </div>
    </TeachingEmptyState>
  );
}
