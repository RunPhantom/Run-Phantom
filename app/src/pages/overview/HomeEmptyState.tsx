import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/typography";
import { readOtlpEndpoint } from "../../shell/otlp";
import { KpiStrip } from "./HomeKpis";
import { AgentsPanel, ModelsPanel, NeedsALookPanel, RunsOverTimePanel } from "./HomePanels";
import { sampleOverview } from "./sample-overview";

const ENV_NAME = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";

/**
 * Nothing captured yet: a faded, labelled sample of this page behind a setup card
 * with the OTLP endpoint and a way to load sample runs.
 */
export function HomeEmptyState({ onLoadSamples, loading, loadError }: { onLoadSamples: () => void; loading: boolean; loadError: string | null }) {
  const sample = useMemo(() => sampleOverview(Date.now()), []);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [endpointError, setEndpointError] = useState(false);
  const [copied, setCopied] = useState<"ok" | "blocked" | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    readOtlpEndpoint().then(value => { if (active) setEndpoint(value); }, () => { if (active) setEndpointError(true); });
    return () => { active = false; window.clearTimeout(timer.current); };
  }, []);

  const snippet = `${ENV_NAME}=${endpoint ?? "http://127.0.0.1:<port>/v1/traces"}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied("ok");
    } catch {
      setCopied("blocked");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="relative" data-home-empty>
      <div aria-hidden="true" inert className="pointer-events-none select-none opacity-40 saturate-[0.4]" data-home-ghost>
        <p className="rp-type-eyebrow mb-2 text-rp-ink-subtle">Sample · not your data</p>
        <KpiStrip overview={sample} interactive={false} />
        <div className="mt-4 grid gap-4 lg:grid-cols-12">
          <div className="lg:col-span-7"><RunsOverTimePanel overview={sample} interactive={false} /></div>
          <div className="lg:col-span-5"><NeedsALookPanel overview={sample} /></div>
          <div className="lg:col-span-6"><AgentsPanel overview={sample} /></div>
          <div className="lg:col-span-6"><ModelsPanel overview={sample} /></div>
        </div>
      </div>
      <div className="absolute inset-x-0 top-6 flex justify-center px-0 sm:top-20 sm:px-6">
        <section aria-labelledby="home-get-started" className="w-full max-w-[620px] rounded-lg border border-rp-line bg-rp-surface p-5 shadow-e4 sm:p-7" data-home-setup>
          <Eyebrow marker tone="accent">Get started / 2 minutes</Eyebrow>
          <h2 id="home-get-started" className="rp-type-headline mt-3 text-rp-ink">Your first run will appear here.</h2>
          <p className="rp-type-prose mt-2 text-rp-ink-muted">Point any OpenTelemetry exporter at this machine. This page fills in as soon as the first step arrives.</p>
          <div className="mt-4 flex items-stretch gap-2 rounded-control border border-rp-line bg-rp-canvas">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-3 py-2.5 font-mono text-12 text-rp-ink" data-otlp-snippet>{snippet}</code>
            <button
              type="button"
              onClick={() => void copy()}
              disabled={!endpoint}
              aria-label={copied === "ok" ? "Copied endpoint" : "Copy endpoint"}
              className="flex w-11 shrink-0 items-center justify-center border-l border-rp-line text-rp-ink-muted transition-colors duration-fast hover:bg-rp-row-hover hover:text-rp-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--rp-focus)] disabled:opacity-50"
            >
              {copied === "ok" ? <Check aria-hidden="true" className="size-4 text-rp-success" /> : <Copy aria-hidden="true" className="size-4" />}
            </button>
          </div>
          <p className="mt-2 text-12 text-rp-ink-subtle" role="status">
            {copied === "ok" ? "Copied. Set it in your agent's environment and run it."
              : copied === "blocked" ? "The browser blocked the clipboard. Select the line above and copy it."
              : endpointError ? "Could not read the local service port; use the port Run Phantom printed when it started."
              : "Set it in your agent's environment. Traces go over OTLP/HTTP and stay on this machine."}
          </p>
          <p className="mt-1 text-12 text-rp-ink-subtle">Using Claude Code, Cursor or Codex? <Link to="/settings" className="text-rp-blue underline-offset-4 hover:underline">Connect a coding agent</Link>.</p>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-rp-line-muted pt-4">
            <p className="flex items-center gap-2 text-13 text-rp-ink" role="status" data-waiting-first-run>
              <span aria-hidden="true" className="pulse-dot size-2 rounded-full bg-rp-mark" />
              Waiting for your first run…
            </p>
            <Button type="button" variant="outline" size="sm" loading={loading} onClick={onLoadSamples}>{loading ? "Loading sample runs…" : "Load sample runs"}</Button>
          </div>
          {loadError && <p role="alert" className="mt-2 text-12 text-rp-danger">{loadError}</p>}
        </section>
      </div>
    </div>
  );
}
