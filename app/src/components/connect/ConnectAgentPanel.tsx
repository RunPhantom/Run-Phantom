import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronRight, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tab, TabList } from "@/components/ui/tabs";
import { replayDemoTraces } from "../../api/demo-traces";
import { useRuns } from "../../hooks/use-runs";
import { runDisplayName } from "../../utils/helpers";
import { runPath } from "../../utils/navigation";
import { useLocalService } from "../../shell/otlp";
import { CodeBlock } from "./CodeBlock";
import {
  CONNECT_TABS, DEFAULT_LOCAL_PORT, EXAMPLE_MODEL, cliCommand, codingAgentGuides, curlSnippet,
  envSnippet, exampleCommand, openTelemetryEnv, pythonSnippet, setupCommand, typescriptSnippet, type ConnectTabId, type LocalService,
} from "./connect-snippets";
import { useNewRunArrival, useTestSpan } from "./use-connect";

const PLACEHOLDER_SERVICE: LocalService = { port: DEFAULT_LOCAL_PORT, endpoint: "http://127.0.0.1:<port>/v1/traces", runtime: "source" };

function Step({ index, title, children }: { index?: number; title: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="flex items-baseline gap-2 text-14 font-semibold text-rp-ink">
        {index !== undefined && <span aria-hidden="true" className="font-mono text-12 font-medium text-rp-blue">{String(index).padStart(2, "0")}</span>}
        {title}
      </h3>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-13 leading-5 text-rp-ink-muted">{children}</p>;
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-sm bg-rp-canvas px-1 py-px font-mono text-12 text-rp-ink">{children}</code>;
}

function FullGuideLink({ tab, children }: { tab: ConnectTabId; children: ReactNode }) {
  return (
    <Link to={tab === "typescript" ? "/connect" : `/connect?tab=${tab}`} className="inline-flex items-center gap-1 text-13 font-medium text-rp-blue underline-offset-4 hover:underline">
      {children}<ArrowRight aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

function TabBody({ tab, service, compact }: { tab: ConnectTabId; service: LocalService; compact: boolean }) {
  const { endpoint } = service;
  const source = service.runtime === "source";
  switch (tab) {
    case "typescript": {
      const example = source && (
        <Step index={compact ? undefined : 1} title="Run the bundled example">
          <Hint>In the Run Phantom folder, with <Code>OPENAI_API_KEY</Code> set in your shell. One question to {EXAMPLE_MODEL} costs well under a cent.</Hint>
          <CodeBlock code={exampleCommand(endpoint)} label="Copy example command" caption="Shell · examples/tool-agent" data-connect-example />
          {!compact && <Hint>Prefer Anthropic or Gemini? Use <Code>--provider anthropic</Code> or <Code>--provider gemini</Code> with that provider&rsquo;s key.</Hint>}
        </Step>
      );
      const ownCode = (
        <Step index={source && !compact ? 2 : undefined} title="Send steps from your own code">
          <Hint>No dependencies. Call <Code>sendSpan</Code> after each model or tool call.</Hint>
          <CodeBlock code={typescriptSnippet(endpoint)} label="Copy TypeScript snippet" caption="runphantom.ts" maxHeight={compact ? 180 : 440} />
        </Step>
      );
      if (compact) return <div className="space-y-3">{example || ownCode}{example && <FullGuideLink tab="typescript">Send steps from your own code</FullGuideLink>}</div>;
      return (
        <div className="space-y-6">
          {example || <Hint>The bundled examples ship with the source repository, in <Code>examples/tool-agent</Code>.</Hint>}
          {ownCode}
        </div>
      );
    }
    case "python":
      return (
        <div className={compact ? "space-y-3" : "space-y-6"}>
          <Step title="Send steps from Python">
            <Hint>Standard library only. Save it as <Code>runphantom.py</Code> and run <Code>python3 runphantom.py</Code>: a run named &ldquo;chat {EXAMPLE_MODEL}&rdquo; appears.</Hint>
            <CodeBlock code={pythonSnippet(endpoint)} label="Copy Python snippet" caption="runphantom.py" maxHeight={compact ? 180 : 440} />
          </Step>
          {!compact && <Hint>Already use OpenTelemetry? Set the variables on the OpenTelemetry tab instead.</Hint>}
        </div>
      );
    case "opentelemetry":
      return (
        <div className={compact ? "space-y-3" : "space-y-6"}>
          <Step index={compact ? undefined : 1} title="Point your exporter here">
            <Hint>Any OpenTelemetry SDK reads these. Run Phantom takes OTLP over HTTP (JSON or protobuf), not gRPC.</Hint>
            <CodeBlock code={openTelemetryEnv(endpoint)} label="Copy OpenTelemetry variables" caption="Shell · environment" data-connect-env />
            {!compact && <Hint>The last line asks GenAI instrumentations to record prompts and replies. Leave it out to keep content off the trace.</Hint>}
          </Step>
          {compact ? <FullGuideLink tab="opentelemetry">Write it to a project&rsquo;s .env instead</FullGuideLink> : (
            <Step index={2} title="Or write it to your project's .env">
              <CodeBlock code={cliCommand(service, "connect --file=/path/to/your/project/.env")} label="Copy connect command" caption={source ? "Shell · Run Phantom folder" : "Shell"} />
            </Step>
          )}
        </div>
      );
    case "curl":
      return (
        <Step title="Send one span from a terminal">
          <Hint>Run it on this machine. A run named &ldquo;Hello from curl&rdquo; appears within a second.</Hint>
          <CodeBlock code={curlSnippet(endpoint)} label="Copy curl command" caption="Shell · macOS or Linux" data-connect-curl />
        </Step>
      );
    case "coding-agents": {
      const guides = codingAgentGuides(service);
      const where = <>{source ? "Run in the Run Phantom folder. " : ""}Replace <Code>/path/to/your/project</Code> with the project&rsquo;s absolute path.</>;
      if (compact) {
        const [claude] = guides;
        return (
          <div className="space-y-3">
            <Step title={`Record ${claude.name} sessions`}>
              <Hint>{where}</Hint>
              <CodeBlock code={claude.command} label={`Copy ${claude.name} command`} caption="Shell" />
              <Hint>{claude.then}</Hint>
            </Step>
            <FullGuideLink tab="coding-agents">Codex, Cursor and agent-led setup</FullGuideLink>
          </div>
        );
      }
      return (
        <div className="space-y-6">
          <Hint>Record your coding agent&rsquo;s own sessions as runs. {where}</Hint>
          {guides.map((guide, index) => (
            <Step key={guide.id} index={index + 1} title={guide.name}>
              <CodeBlock code={guide.command} label={`Copy ${guide.name} command`} caption="Shell" />
              <Hint>{guide.then}</Hint>
              {guide.fullCapture && (
                <details className="group text-13 text-rp-ink-muted">
                  <summary className="flex min-h-11 cursor-pointer list-none [&::-webkit-details-marker]:hidden items-center gap-1.5 text-rp-ink-soft hover:text-rp-ink [@media(pointer:fine)]:min-h-8">
                    <ChevronRight aria-hidden="true" className="size-3.5 transition-transform duration-fast group-open:rotate-90 motion-reduce:transition-none" />
                    Metadata only by default. Also record prompts and replies
                  </summary>
                  <div className="mt-1 space-y-2 pl-5">
                    <Hint>For one project, with your consent to keep message content on this machine:</Hint>
                    <CodeBlock code={guide.fullCapture} label={`Copy ${guide.name} full-capture command`} caption="Shell" />
                  </div>
                </details>
              )}
            </Step>
          ))}
          <Step index={guides.length + 1} title="Or let your agent instrument your app">
            <CodeBlock code={setupCommand(service)} label="Copy setup command" caption="Shell" />
            <Hint>
              This adds the Run Phantom skills to your coding agents. Then type <Code>/instrument-agent</Code> in Claude Code, Codex or Cursor inside your project.
              {service.port !== DEFAULT_LOCAL_PORT && <> The skill assumes port {DEFAULT_LOCAL_PORT}, so give the agent the endpoint above.</>}
            </Hint>
          </Step>
        </div>
      );
    }
  }
}

/**
 * The connect guide: one tab per way in, the real endpoint of this local service, a test
 * span that goes through the same OTLP route, and a live row for the next run to arrive.
 */
export function ConnectAgentPanel({ compact = false, split = false, tab: controlledTab, onTabChange, waitingLabel = "Listening for new runs…", onLoadSamples, samplesLoading, className }: {
  compact?: boolean;
  /** Full page: the connection check sits in a column beside the guide instead of below it. */
  split?: boolean;
  tab?: ConnectTabId;
  onTabChange?: (tab: ConnectTabId) => void;
  waitingLabel?: string;
  /** Replaces the built-in loader, e.g. to open the first sample run. */
  onLoadSamples?: () => void | Promise<void>;
  samplesLoading?: boolean;
  className?: string;
}) {
  const id = useId();
  const service = useLocalService();
  const [ownTab, setOwnTab] = useState<ConnectTabId>("typescript");
  const tab = controlledTab ?? ownTab;
  const selectTab = (next: ConnectTabId) => { setOwnTab(next); onTabChange?.(next); };
  const resolved = service.data ?? PLACEHOLDER_SERVICE;

  const guide = (
    <div className="min-w-0">
      <CodeBlock inline code={envSnippet(resolved.endpoint)} label="Copy endpoint" caption="Endpoint on this machine" data-otlp-snippet />
      {service.isError && <p role="alert" className="mt-1.5 text-12 text-rp-danger">Could not read the local service port; use the port Run Phantom printed when it started.</p>}
      <TabList label="Ways to connect" className={compact ? "mt-3" : "mt-5"}>
        {CONNECT_TABS.map(option => (
          <Tab
            key={option.id}
            id={`${id}-tab-${option.id}`}
            aria-controls={option.id === tab ? `${id}-panel` : undefined}
            selected={option.id === tab}
            onClick={() => selectTab(option.id)}
            className="h-11 [@media(pointer:fine)]:h-10"
            data-connect-tab={option.id}
          >
            {option.label}
          </Tab>
        ))}
      </TabList>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className={compact ? "pt-3" : "pt-5"} data-connect-tabpanel={tab}>
        <TabBody tab={tab} service={resolved} compact={compact} />
      </div>
    </div>
  );
  const live = <LiveRow waitingLabel={waitingLabel} onLoadSamples={onLoadSamples} samplesLoading={samplesLoading} column={split} />;

  if (split) {
    return (
      <div className={cn("grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start", className)} data-connect-panel>
        <div className="min-w-0 rounded-lg border border-rp-line bg-rp-surface p-4 sm:p-6">{guide}</div>
        <aside aria-labelledby={`${id}-check`} className="min-w-0 rounded-lg border border-rp-line bg-rp-surface p-4 sm:p-5 lg:sticky lg:top-5">
          <h2 id={`${id}-check`} className="rp-type-card-title text-rp-ink">Check the connection</h2>
          <p className="mt-1 text-13 leading-5 text-rp-ink-muted">A test span goes through the same endpoint your agent uses and shows up as a run.</p>
          {live}
        </aside>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", className)} data-connect-panel>
      {guide}
      {live}
    </div>
  );
}

function LiveRow({ waitingLabel, onLoadSamples, samplesLoading, column }: { waitingLabel: string; onLoadSamples?: () => void | Promise<void>; samplesLoading?: boolean; column: boolean }) {
  const queryClient = useQueryClient();
  const runs = useRuns();
  const arrival = useNewRunArrival();
  const test = useTestSpan();
  const [samples, setSamples] = useState<{ loading: boolean; error: string | null; firstId: string | null; count: number }>({ loading: false, error: null, firstId: null, count: 0 });

  const loadSamples = async () => {
    setSamples(current => ({ ...current, loading: true, error: null }));
    try {
      if (onLoadSamples) {
        await onLoadSamples();
        setSamples(current => ({ ...current, loading: false }));
        return;
      }
      const ids = await replayDemoTraces();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runs"], exact: true }),
        queryClient.invalidateQueries({ queryKey: ["home"] }),
      ]);
      setSamples({ loading: false, error: null, firstId: ids[0] ?? null, count: ids.length });
    } catch (error) {
      setSamples(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Could not load sample runs." }));
    }
  };

  const testRunId = test.state.phase === "arrived" || test.state.phase === "stored" ? test.state.traceId : null;
  const latest = arrival && arrival.runId !== testRunId ? arrival : null;
  const latestName = latest ? runs.data?.find(run => run.id === latest.runId) : undefined;

  return (
    <div className={column ? "mt-4" : "mt-5 border-t border-rp-line-muted pt-4"} data-connect-live>
      <div className={column ? "flex flex-col gap-3" : "flex flex-wrap items-center justify-between gap-3"}>
        <p className="flex min-w-0 items-center gap-2 text-13 text-rp-ink" role="status" aria-live="polite" data-waiting-first-run>
          {latest ? (
            <>
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-rp-mark-success" />
              <span className="min-w-0 truncate">Run received{latestName ? <>: <span className="font-medium">{runDisplayName(latestName)}</span></> : ""}.</span>
              <Link to={runPath(latest.runId)} className="inline-flex shrink-0 items-center gap-1 font-medium text-rp-blue underline-offset-4 hover:underline">Open it<ArrowRight aria-hidden="true" className="size-3.5" /></Link>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="pulse-dot size-2 shrink-0 rounded-full bg-rp-mark" />
              {waitingLabel}
            </>
          )}
        </p>
        <div className={column ? "flex flex-col-reverse gap-2 [&>button]:w-full" : "flex flex-wrap items-center gap-2"}>
          <Button type="button" size="sm" variant="outline" className="h-11 [@media(pointer:fine)]:h-8" loading={samplesLoading ?? samples.loading} onClick={() => void loadSamples()}>
            {(samplesLoading ?? samples.loading) ? "Loading sample runs…" : "Load sample runs"}
          </Button>
          <Button type="button" size="sm" className="h-11 [@media(pointer:fine)]:h-8" loading={test.state.phase === "sending"} onClick={() => void test.send()} data-send-test-span>
            {test.state.phase !== "sending" && <Send aria-hidden="true" />}
            {test.state.phase === "sending" ? "Sending…" : "Send a test span"}
          </Button>
        </div>
      </div>
      <TestSpanResult state={test.state} />
      {samples.error && <p role="alert" className="mt-2 text-12 text-rp-danger">{samples.error}</p>}
      {samples.count > 0 && (
        <p role="status" className="mt-2 text-13 text-rp-ink-muted">
          Loaded {samples.count} sample runs.{" "}
          <Link to={samples.firstId ? runPath(samples.firstId) : "/runs"} className="font-medium text-rp-blue underline-offset-4 hover:underline">Open the first one</Link>
        </p>
      )}
    </div>
  );
}

function TestSpanResult({ state }: { state: ReturnType<typeof useTestSpan>["state"] }) {
  if (state.phase === "idle" || state.phase === "sending") return null;
  if (state.phase === "failed") {
    return <p role="alert" className="mt-2 text-13 text-rp-danger" data-test-span-result="failed">The test span was not stored: {state.message}</p>;
  }
  return (
    <p role="status" className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-13 leading-5 text-rp-ink" data-test-span-result={state.phase}>
      <span aria-hidden="true" className={cn("size-2 shrink-0 translate-y-[-1px] rounded-full", state.phase === "arrived" ? "bg-rp-mark-success" : "bg-rp-mark-warning")} />
      <span>
        {state.phase === "arrived"
          ? <>Test span stored and shown live after <span className="font-mono">{state.ms}&nbsp;ms</span>.</>
          : <>Test span stored, but no live update arrived. Reload if the run list looks stale.</>}
      </span>
      <Link to={runPath(state.traceId)} className="inline-flex items-center gap-1 font-medium text-rp-blue underline-offset-4 hover:underline">Open the test run<ArrowRight aria-hidden="true" className="size-3.5" /></Link>
    </p>
  );
}
