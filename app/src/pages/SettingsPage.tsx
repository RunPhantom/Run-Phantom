import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { CheckCircle2, CircleAlert, Download, Loader2, Plug, Plus, Trash2 } from "lucide-react";
import { LocalAgentSetupCTA } from "../components/LocalAgentSetupCTA";
import { SecretInput } from "../components/SecretInput";
import {
  getAgents,
  getAgentsHealth,
  saveAgents,
  type AgentEntry,
  type AgentsHealth,
  type AgentsRegistry,
} from "../api/agents";
import {
  deleteSecret,
  getSecretOverview,
  saveSecret,
  testSecret,
  type SecretHints,
  type SecretKey,
  type SecretStatus,
  type SecretStatuses,
} from "../api/secrets";
import { DATABASE_BACKUP_URL, getDataSummary, type DataSummary } from "../api/data";
import { clearRuns } from "../api/runs";
import { useRunPhantomEvent } from "../hooks/use-runphantom-ws";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Eyebrow } from "@/components/ui/typography";
import { cn } from "@/lib/utils";
import { CopyButton } from "../components/run-detail/CopyButton";
import { readOtlpEndpoint } from "../shell/otlp";
import { plural } from "../utils/helpers";
import "./settings.css";
import { fetchPrices, modelPricingConsentEnabled, setModelPricingConsent } from "../utils/costs";
import { LIST_PRICES, PRICE_TABLE_AS_OF } from "../../../src/pricing/list-prices";
import type { ProviderCheckResult } from "../../../src/provider-connection-protocol";

type Tab = "agents" | "keys" | "debug";

// The labels keep "API keys" and "Debug" because specs find these tabs by those words; the arrow/End order
// (keys, agents, debug) is pinned too, so new sections go inside a tab rather than becoming one.
const TABS: { id: Tab; label: string; eyebrow: string; description: string }[] = [
  { id: "keys", label: "Provider API keys", eyebrow: "Providers / Keys stay on this machine", description: "Add a key for each provider you use. Keys are sent once to the local service and never read back into the browser." },
  { id: "agents", label: "Agent endpoints", eyebrow: "Replay / Local endpoints", description: "Register local replay endpoints that Run Phantom can launch or reuse when you replay a captured run." },
  { id: "debug", label: "Data and debug", eyebrow: "Local data", description: "See where your runs are stored, take a copy, or start again." },
];

function hashTab(hash: string): Tab | null {
  if (hash === "#pricing" || hash === "#providers") return "keys";
  if (hash === "#data") return "debug";
  if (hash === "#agents") return "agents";
  return null;
}

function SectionBlock({
  eyebrow,
  title,
  description,
  panelId,
  labelledBy,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  panelId: string;
  labelledBy: string;
  children: ReactNode;
}) {
  return (
    <section
      id={panelId}
      role="tabpanel"
      aria-labelledby={labelledBy}
      tabIndex={0}
      className="settings-panel animate-fade-rise"
    >
      <Eyebrow marker tone="accent">{eyebrow}</Eyebrow>
      <h2 className="rp-section-title mt-3">
        {title}
      </h2>
      {description && (
        <p className="rp-lede mt-2">
          {description}
        </p>
      )}
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const location = useLocation();
  const [tab, setTab] = useState<Tab>(() => hashTab(location.hash) ?? "keys");
  const tablistLabelId = useId();
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    agents: null,
    keys: null,
    debug: null,
  });

  useEffect(() => {
    const target = hashTab(location.hash);
    if (!target) return;
    setTab(target);
    const frame = requestAnimationFrame(() => document.getElementById(`settings-${location.hash.slice(1)}`)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [location.hash]);

  const sectionMap: Record<Tab, () => ReactNode> = {
    agents: () => <AgentEndpointsSection />,
    keys: () => <KeysSection />,
    debug: () => <DataAndDebugSection />,
  };
  const tabIndex = TABS.findIndex(({ id }) => id === tab);
  const currentTabConfig = TABS[tabIndex];
  const currentTabId = `runphantom-settings-tab-${currentTabConfig.id}`;
  const currentPanelId = `runphantom-settings-panel-${currentTabConfig.id}`;

  const moveTabFocus = useCallback((nextIndex: number) => {
    const nextTab = TABS[(nextIndex + TABS.length) % TABS.length];
    setTab(nextTab.id);
    tabRefs.current[nextTab.id]?.focus();
  }, []);

  const onTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault();
        moveTabFocus(index + 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault();
        moveTabFocus(index - 1);
        break;
      case "Home":
        event.preventDefault();
        moveTabFocus(0);
        break;
      case "End":
        event.preventDefault();
        moveTabFocus(TABS.length - 1);
        break;
      default:
        break;
    }
  }, [moveTabFocus]);

  return (
    <div className="settings-workspace flex h-full min-h-0 flex-col lg:flex-row">
      <div className="border-b border-rp-line bg-rp-surface px-5 py-5 lg:w-64 lg:flex-shrink-0 lg:border-b-0 lg:border-r lg:px-5 lg:py-6">
        <Eyebrow marker tone="accent">Settings / This machine</Eyebrow>
        <h1 id={tablistLabelId} className="rp-subsection-title mt-2">
          Settings
        </h1>
        <nav
          role="tablist"
          aria-labelledby={tablistLabelId}
          aria-orientation="vertical"
          className="mt-4 grid gap-1"
        >
          {TABS.map(({ id, label }, index) => (
            <button
              key={id}
              id={`runphantom-settings-tab-${id}`}
              ref={(element) => {
                tabRefs.current[id] = element;
              }}
              type="button"
              onClick={() => setTab(id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              role="tab"
              aria-selected={tab === id}
              // Only the selected panel is mounted, so pointing every tab at a
              // panel id leaves two of three aria-controls dangling — a screen
              // reader announces a tab that controls nothing.
              aria-controls={tab === id ? `runphantom-settings-panel-${id}` : undefined}
              tabIndex={tab === id ? 0 : -1}
              className={`rp-tab rp-ease flex min-h-10 items-center rounded-sm px-3 text-left text-[14px] ${tab === id ? "bg-rp-wash font-semibold text-rp-blue" : "text-rp-ink-soft hover:bg-rp-row-hover"}`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto rp-page">
        <div className="w-full max-w-4xl pb-16">
          <SectionBlock
            key={tab}
            eyebrow={currentTabConfig.eyebrow}
            title={currentTabConfig.label}
            description={currentTabConfig.description}
            panelId={currentPanelId}
            labelledBy={currentTabId}
          >
            {sectionMap[tab]()}
          </SectionBlock>
        </div>
      </div>
    </div>
  );
}

function AgentEndpointsSection() {
  const [agents, setAgents] = useState<AgentsRegistry>({});
  const [health, setHealth] = useState<AgentsHealth>({});
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const active = useRef(true);
  const pending = useRef(false);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const owner = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const [nextAgents, nextHealth] = await Promise.all([getAgents(), getAgentsHealth()]);
      if (!active.current || owner !== generation.current) return;
      setAgents(nextAgents);
      setHealth(nextHealth);
      setLoaded(true);
    } catch (cause) {
      if (active.current && owner === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (active.current && owner === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void reload();
    return () => { active.current = false; };
  }, [reload]);

  useRunPhantomEvent("agents_updated", (data: { agents?: AgentsRegistry }) => {
    if (data?.agents) setAgents(data.agents);
  });

  const persistAgents = useCallback(async (nextAgents: AgentsRegistry, message: string, confirmed: (actual: AgentsRegistry) => boolean) => {
    if (pending.current || loading || !loaded) return false;
    pending.current = true;
    const owner = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice("");
    let sent = false;
    try {
      await saveAgents(nextAgents);
      sent = true;
      if (!active.current || owner !== generation.current) return false;
      const actual = await getAgents();
      if (!active.current || owner !== generation.current) return false;
      setAgents(actual);
      if (!confirmed(actual)) {
        setError("The daemon did not retain this endpoint change. Review the endpoint and try again.");
        return false;
      }
      setNotice(message);
      void getAgentsHealth().then(next => {
        if (active.current && owner === generation.current) setHealth(next);
      }).catch(() => {});
      return true;
    } catch (cause) {
      if (active.current && owner === generation.current) {
        if (sent) setLoaded(false);
        setError(sent ? "Change sent, but the saved registry could not be checked. Load it again before making more changes." : cause instanceof Error ? cause.message : String(cause));
      }
      return false;
    } finally {
      pending.current = false;
      if (active.current && owner === generation.current) setBusy(false);
    }
  }, [loaded, loading]);

  const addAgent = useCallback(async () => {
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name || !url) return;
    if (Object.prototype.hasOwnProperty.call(agents, name)) { setError("An endpoint with this name already exists. Choose another name."); return; }
    let normalized: string;
    try {
      const parsed = new URL(url);
      if (url.length > 4096 || url.includes("#") || !["http:", "https:"].includes(parsed.protocol)
        || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase()) || parsed.username || parsed.password) throw new Error();
      normalized = parsed.toString();
    } catch { setError("Use a local HTTP or HTTPS replay URL without credentials or fragments (up to 4096 characters)."); return; }
    const saved = await persistAgents({ ...agents, [name]: { url: normalized, prefillFromTrace: {} satisfies NonNullable<AgentEntry["prefillFromTrace"]> } }, `Endpoint ${name} registered.`, actual => actual[name]?.url === normalized);
    if (saved && active.current) { setNewName(""); setNewUrl(""); }
  }, [agents, newName, newUrl, persistAgents]);

  const removeAgent = useCallback(async (name: string) => {
    const nextAgents = { ...agents };
    delete nextAgents[name];
    await persistAgents(nextAgents, `Endpoint ${name} removed.`, actual => !Object.prototype.hasOwnProperty.call(actual, name));
  }, [agents, persistAgents]);

  return (
    <>
      <LocalAgentSetupCTA
        title="Register a new agent endpoint"
        description="Use the local replay setup flow for your coding tool, then review or edit the registered endpoint here."
      />

      {loading && <p role="status" className="settings-description">Loading registered endpoints…</p>}
      {error && <div role="alert" className="settings-feedback settings-error"><p>{error}</p>{!loaded ? <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void reload()} disabled={busy}>Try loading again</Button> : null}</div>}
      {notice && <p role="status" className="settings-feedback">{notice}</p>}
      {!loading && !error && Object.keys(agents).length === 0 && <p className="settings-description">No replay endpoints registered. Start with the setup prompt or add an existing endpoint below.</p>}
      {Object.keys(agents).length > 0 && (
        <div className="overflow-hidden rounded-lg border border-rp-line bg-rp-surface">
          <div className="hidden grid-cols-[minmax(92px,160px)_minmax(0,1fr)_auto_36px] gap-3 border-b border-rp-line bg-rp-canvas px-4 py-2 sm:grid">
            <span className="rp-eyebrow">Name</span>
            <span className="rp-eyebrow">Replay URL</span>
            <span className="rp-eyebrow">Health</span>
            <span className="sr-only">Actions</span>
          </div>
          {Object.entries(agents).map(([name, config]) => {
            const status = health[name] ?? "unavailable";
            return (
              <div
                key={name}
                className="rp-ease group grid grid-cols-[minmax(0,1fr)_auto_36px] items-center gap-x-3 gap-y-1 border-b border-rp-line-muted px-4 py-3 last:border-b-0 hover:bg-rp-row-hover sm:grid-cols-[minmax(92px,160px)_minmax(0,1fr)_auto_36px] sm:gap-y-0"
              >
                <span className="min-w-0 break-words text-[13px] font-medium text-rp-ink">
                  {name}
                </span>
                <span title={config.url || undefined} className={`rp-meta order-last col-span-3 min-w-0 truncate sm:order-none sm:col-span-1 ${config.url ? "text-rp-ink-soft" : "text-rp-ink-muted"}`}>
                  {config.url || "No URL registered"}
                </span>
                <StatusPill status={status === "online" ? "success" : "neutral"} live={status === "online"} className="justify-self-start">
                  {status}
                </StatusPill>
                <button
                  type="button"
                  className="rp-ease grid size-9 place-items-center justify-self-end rounded-sm text-rp-ink-muted hover:bg-rp-danger-soft hover:text-rp-danger sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100"
                  disabled={busy || loading || !loaded}
                  onClick={() => void removeAgent(name)}
                  aria-label={`Remove ${name}`}
                  title={`Remove ${name}`}
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <form
        className="grid gap-4 rounded-lg border border-rp-line bg-rp-surface p-5 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void addAgent();
        }}
      >
        <p className="rp-eyebrow sm:col-span-3">Add an existing endpoint</p>
        <div className="grid min-w-0 gap-1.5">
          <label className="rp-field-label" htmlFor="runphantom-agent-name">
            Agent name
          </label>
          <Input
            id="runphantom-agent-name"
            className="font-mono text-[13px]"
            required
            disabled={busy || loading || !loaded}
            maxLength={128}
            placeholder="agent-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <label className="rp-field-label" htmlFor="runphantom-agent-url">
            Replay endpoint URL
          </label>
          <Input
            id="runphantom-agent-url"
            className="font-mono text-[13px]"
            required
            disabled={busy || loading || !loaded}
            placeholder="http://localhost:5860/replay"
            value={newUrl}
            onChange={(event) => setNewUrl(event.target.value)}
          />
        </div>
        <Button
          type="submit"
          aria-label="Add agent endpoint"
          disabled={busy || loading || !loaded || !newName.trim() || !newUrl.trim()}
          loading={busy}
        >
          {!busy && <Plus aria-hidden="true" />}
          {busy ? "Saving…" : "Add"}
        </Button>
      </form>
    </>
  );
}

const PROVIDERS: { key: SecretKey; label: string; placeholder: string; usage: string; getKeyUrl: string }[] = [
  { key: "openai", label: "OpenAI", placeholder: "sk-...", usage: "Used for Ask Agent and chat when those features call OpenAI.", getKeyUrl: "https://platform.openai.com/api-keys" },
  { key: "anthropic", label: "Anthropic", placeholder: "sk-ant-...", usage: "Used for Ask Agent, model discovery, and summaries that call Anthropic.", getKeyUrl: "https://console.anthropic.com/settings/keys" },
  { key: "gemini", label: "Google Gemini", placeholder: "AIza...", usage: "Used when the Playground calls Gemini models.", getKeyUrl: "https://aistudio.google.com/app/apikey" },
];

type CheckState = { status: "checking" } | { status: "done"; result: ProviderCheckResult } | { status: "error"; message: string };

function ConnectionCheck({ label, configured, state, onCheck }: { label: string; configured: boolean; state: CheckState | undefined; onCheck: () => void }) {
  const checking = state?.status === "checking";
  const result = state?.status === "done" ? state.result : null;
  if (!configured && !result) return null;
  return (
    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`Test ${label} connection`}
        title={configured ? `Ask ${label} to list its models. This request is free.` : `Add a ${label} key first`}
        disabled={!configured || checking}
        onClick={onCheck}
        className="self-start"
      >
        {checking ? <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Plug aria-hidden="true" />}
        {checking ? "Testing…" : "Test connection"}
      </Button>
      <p role="status" aria-live="polite" className="min-w-0 text-12 leading-5">
        {checking ? <span className="text-rp-ink-muted">Asking {label} to list its models…</span>
          : state?.status === "error" ? <span className="text-rp-danger">{state.message}</span>
          : result ? (
            <span className={cn("inline-flex min-w-0 items-start gap-1.5", result.ok ? "text-rp-success" : "text-rp-danger")}>
              {result.ok ? <CheckCircle2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /> : <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />}
              <span className="min-w-0 break-words">
                <span className="text-rp-ink">{result.message}</span>
                {result.latencyMs !== null && <span className="ml-1.5 font-mono text-rp-ink-muted">{result.latencyMs} ms</span>}
                <span className="ml-1.5 text-rp-ink-muted">· checked {new Date(result.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                {result.providerMessage && <span className="mt-0.5 block text-rp-ink-muted">{label} said: {result.providerMessage}</span>}
              </span>
            </span>
          ) : <span className="text-rp-ink-muted">Not tested yet. The test lists models, which is free.</span>}
      </p>
    </div>
  );
}

function KeysSection() {
  const [modelPricingEnabled, setModelPricingEnabled] = useState(modelPricingConsentEnabled);
  const [drafts, setDrafts] = useState<Record<SecretKey, string>>({
    anthropic: "",
    openai: "",
    gemini: "",
  });
  const [statuses, setStatuses] = useState<SecretStatuses | null>(null);
  const [hints, setHints] = useState<SecretHints | null>(null);
  const [checks, setChecks] = useState<Partial<Record<SecretKey, CheckState>>>({});
  const active = useRef(true);
  const pending = useRef(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<SecretKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    active.current = true;
    setStatusError(null);
    getSecretOverview()
      .then((next) => {
        if (!cancelled) { setStatuses(next.keys); setHints(next.hints); }
      })
      .catch(() => {
        if (!cancelled) { setStatuses(null); setStatusError("Saved key status is unavailable. Try loading it again before changing keys."); }
      });
    return () => {
      cancelled = true;
      active.current = false;
    };
  }, [statusAttempt]);

  const refreshHints = useCallback(() => {
    getSecretOverview().then(next => { if (active.current) setHints(next.hints); }).catch(() => {});
  }, []);

  const keyChanged = useCallback((key: SecretKey) => {
    setChecks(current => ({ ...current, [key]: undefined }));
    refreshHints();
  }, [refreshHints]);

  useRunPhantomEvent("secrets_updated", (data: { key?: SecretKey; status?: SecretStatus }) => {
    if (!data?.key || !data.status) return;
    const secretKey = data.key;
    const secretStatus = data.status;
    setStatuses((current) => (current ? { ...current, [secretKey]: secretStatus } : current));
    keyChanged(secretKey);
  });

  const setDraft = useCallback((key: SecretKey, value: string) => {
    setDrafts((current) => ({ ...current, [key]: value }));
  }, []);

  const persist = useCallback(async (key: SecretKey, rawValue: string) => {
    const value = rawValue.trim();
    if (!value || pending.current || !statuses) return;
    pending.current = true;
    setSaveError(null);
    setSavingKey(key);
    try {
      const nextStatus = await saveSecret(key, value);
      if (!active.current) return;
      setStatuses((current) => (current ? { ...current, [key]: nextStatus } : current));
      setDrafts((current) => ({ ...current, [key]: "" }));
      keyChanged(key);
      window.dispatchEvent(new CustomEvent("runphantom:api-key-change", { detail: { secret: key } }));
    } catch (error) {
      if (active.current) setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      if (active.current) setSavingKey(null);
    }
  }, [keyChanged, statuses]);

  const clearSecret = useCallback(async (key: SecretKey) => {
    if (pending.current || !statuses) return;
    pending.current = true;
    setSaveError(null);
    setSavingKey(key);
    try {
      const nextStatus = await deleteSecret(key);
      if (!active.current) return;
      setStatuses((current) => (current ? { ...current, [key]: nextStatus } : current));
      setDrafts((current) => ({ ...current, [key]: "" }));
      keyChanged(key);
      window.dispatchEvent(new CustomEvent("runphantom:api-key-change", { detail: { secret: key } }));
    } catch (error) {
      if (active.current) setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      if (active.current) setSavingKey(null);
    }
  }, [keyChanged, statuses]);

  const runCheck = useCallback((key: SecretKey) => {
    setChecks(current => ({ ...current, [key]: { status: "checking" } }));
    testSecret(key)
      .then(result => { if (active.current) setChecks(current => ({ ...current, [key]: { status: "done", result } })); })
      .catch(error => { if (active.current) setChecks(current => ({ ...current, [key]: { status: "error", message: error instanceof Error ? `The check could not run: ${error.message}` : "The check could not run." } })); });
  }, []);

  const configuredCount = statuses ? PROVIDERS.filter(({ key }) => statuses[key]?.configured).length : null;

  return (
    <>
      <div
        role="note"
        className="rounded-lg border border-rp-line-muted bg-rp-canvas-blue px-4 py-3 text-[13px] leading-6 text-rp-ink-soft"
      >
        <Eyebrow className="mb-1.5">What leaves this machine</Eyebrow>
        <ul className="list-disc space-y-0.5 pl-5 marker:text-rp-ink-muted">
          <li>Captured runs, saved runs, notes and replay endpoints stay here.</li>
          <li>Ask Agent and provider summaries send the selected trace content to that provider. The Playground sends the prompt you write to the provider you pick.</li>
          <li>Model discovery and the connection test ask a provider to list its models. Public pricing, if you turn it on, downloads OpenRouter's price list.</li>
        </ul>
      </div>

      <section id="settings-providers" aria-labelledby="settings-providers-heading" className="scroll-mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="settings-providers-heading" className="rp-subsection-title">Providers</h3>
          {configuredCount !== null && <p className="text-12 text-rp-ink-muted"><span className="font-mono text-rp-ink">{configuredCount}</span> of {PROVIDERS.length} have a key</p>}
        </div>
        {!statuses && !statusError && <p role="status" className="settings-description mt-3">Checking saved key status…</p>}
        {statusError && <div role="alert" className="settings-feedback settings-error mt-3"><p>{statusError}</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setStatusAttempt(value => value + 1)}>Try loading key status again</Button></div>}
        <div className="mt-3 divide-y divide-rp-line-muted rounded-lg border border-rp-line bg-rp-surface px-5">
          {PROVIDERS.map(provider => {
            const status = statuses?.[provider.key];
            const configured = status?.configured === true;
            const fromEnv = status?.stored !== true;
            const sourceNote = keySourceNote(status);
            return (
              <SecretInput
                key={provider.key}
                label={provider.label}
                placeholder={provider.placeholder}
                description={provider.usage}
                value={drafts[provider.key]}
                saved={configured}
                sourceIsEnv={configured && status?.source === "env" ? true : fromEnv}
                envVar={status?.env_var}
                hint={hints?.[provider.key] ?? null}
                saving={!statuses || savingKey !== null}
                onChange={(value) => setDraft(provider.key, value)}
                onSave={(value) => void persist(provider.key, value)}
                onClear={status?.stored === true ? () => void clearSecret(provider.key) : undefined}
                getKeyUrl={provider.getKeyUrl}
                footer={(
                  <>
                    {sourceNote && <p className="settings-description mt-2">{sourceNote}</p>}
                    <ConnectionCheck label={provider.label} configured={configured} state={checks[provider.key]} onCheck={() => runCheck(provider.key)} />
                  </>
                )}
              />
            );
          })}
        </div>
        {saveError && (
          <div
            role="alert"
            className="mt-3 rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-[13px] text-rp-danger"
          >
            {saveError}
          </div>
        )}
      </section>

      <section id="settings-pricing" aria-labelledby="settings-pricing-heading" className="scroll-mt-6">
        <h3 id="settings-pricing-heading" className="rp-subsection-title">Cost estimates</h3>
        <dl className="mt-3 grid gap-px overflow-hidden rounded-lg border border-rp-line bg-rp-line sm:grid-cols-3">
          <div className="bg-rp-surface px-4 py-3">
            <dt className="rp-type-eyebrow text-rp-ink-subtle">Reported by provider</dt>
            <dd className="mt-1 text-[13px] leading-5 text-rp-ink">Used as is, whenever a run records what a call cost.</dd>
          </div>
          <div className="bg-rp-surface px-4 py-3">
            <dt className="rp-type-eyebrow text-rp-ink-subtle">Bundled price list</dt>
            <dd className="mt-1 text-[13px] leading-5 text-rp-ink">List prices for <span className="font-mono">{LIST_PRICES.length}</span> models, dated <span className="whitespace-nowrap font-mono">{PRICE_TABLE_AS_OF}</span>. Works offline; marked "est.".</dd>
          </div>
          <div className="bg-rp-surface px-4 py-3">
            <dt className="rp-type-eyebrow text-rp-ink-subtle">Public pricing</dt>
            <dd className="mt-1 text-[13px] leading-5 text-rp-ink">{modelPricingEnabled ? "On. Models missing from the bundled list are priced from OpenRouter." : "Off. Models missing from the bundled list show no cost."}</dd>
          </div>
        </dl>
        <label className="rp-ease mt-3 flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-rp-line bg-rp-surface px-4 py-3.5 hover:border-rp-wash-border">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[color:var(--rp-blue)]"
            checked={modelPricingEnabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              setModelPricingEnabled(enabled);
              setModelPricingConsent(enabled);
              if (enabled) void fetchPrices();
            }}
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-rp-ink">Fetch public model pricing</span>
            <span className="mt-0.5 block text-12 leading-5 text-rp-ink-muted">
              Downloads OpenRouter's public price list to price models the bundled list does not cover. Only the price list is requested; no traces, prompts or keys are sent.
            </span>
          </span>
        </label>
      </section>
    </>
  );
}

function keySourceNote(status: SecretStatus | undefined): string | null {
  if (!status?.configured) return null;
  if (status.source === "env") return `Using ${status.env_var} from the environment. Save a key here to use it instead.`;
  return status.env_available ? `Using the saved key. ${status.env_var} is also set; clear the saved key to use it.` : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function DataAndDebugSection() {
  const queryClient = useQueryClient();
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [reset, setReset] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(() => {
    const owner = ++generation.current;
    setSummaryError(null);
    getDataSummary()
      .then(next => { if (mounted.current && owner === generation.current) setSummary(next); })
      .catch(error => { if (mounted.current && owner === generation.current) setSummaryError(error instanceof Error ? error.message : "Local data details are unavailable."); });
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    readOtlpEndpoint().then(value => { if (mounted.current) setEndpoint(value); }).catch(() => {});
    return () => { mounted.current = false; clearTimeout(resetTimer.current); };
  }, [load]);

  useRunPhantomEvent("clear", load);

  const resetChatOnboarding = useCallback(() => {
    try {
      localStorage.removeItem("runphantom:messagePane:providerIntroSeen");
    } catch {}
    window.dispatchEvent(new CustomEvent("runphantom:messagePane:resetOnboarding"));
    setReset(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setReset(false), 1400);
  }, []);

  const deleteAll = async () => {
    const count = summary?.runs ?? 0;
    await clearRuns();
    await queryClient.invalidateQueries();
    window.dispatchEvent(new CustomEvent("runphantom:run-removed", { detail: { runIds: [] } }));
    load();
    setNotice(`Deleted ${plural(count, "run")} and their results. Saved runs and settings were kept.`);
  };

  const tiles: { label: string; value: string; detail: string }[] = summary ? [
    { label: "Runs", value: summary.runs.toLocaleString(), detail: "captured on this machine" },
    { label: "Steps", value: summary.steps.toLocaleString(), detail: "model calls, tools and agents" },
    { label: "Saved runs", value: summary.savedRuns.toLocaleString(), detail: "kept when runs are deleted" },
    { label: "On disk", value: formatBytes(summary.dbBytes), detail: "database and its journal" },
  ] : [];

  return (
    <>
      <section id="settings-data" aria-labelledby="settings-data-heading" className="scroll-mt-6">
        <h3 id="settings-data-heading" className="rp-subsection-title">Data</h3>
        {summaryError ? (
          <div role="alert" className="settings-feedback settings-error mt-3"><p>{summaryError}</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={load}>Try loading again</Button></div>
        ) : !summary ? (
          <p role="status" className="settings-description mt-3">Reading local data…</p>
        ) : (
          <>
            <ul aria-label="Stored data" className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rp-line bg-rp-line lg:grid-cols-4">
              {tiles.map(tile => (
                <li key={tile.label} className="min-w-0 bg-rp-surface px-4 py-3">
                  <span className="rp-type-eyebrow text-rp-ink-subtle">{tile.label}</span>
                  <span className="rp-type-kpi mt-1.5 block text-rp-ink">{tile.value}</span>
                  <span className="mt-0.5 block truncate text-12 text-rp-ink-muted">{tile.detail}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-3 divide-y divide-rp-line-muted rounded-lg border border-rp-line bg-rp-surface px-4 text-[13px]">
              <div className="grid gap-1 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
                <dt className="text-rp-ink-muted">Database</dt>
                <dd className="flex min-w-0 items-center gap-2"><code className="min-w-0 break-all font-mono text-12 text-rp-ink">{summary.dbPath}</code><CopyButton value={summary.dbPath} label="Copy database location" /></dd>
              </div>
              <div className="grid gap-1 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
                <dt className="text-rp-ink-muted">Receiving traces</dt>
                <dd className="flex min-w-0 items-center gap-2">{endpoint ? <><code className="min-w-0 break-all font-mono text-12 text-rp-ink">{endpoint}</code><CopyButton value={endpoint} label="Copy trace endpoint" /></> : <span className="text-rp-ink-muted">Reading the local service port…</span>}</dd>
              </div>
              <div className="grid gap-1 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
                <dt className="text-rp-ink-muted">Version</dt>
                <dd className="font-mono text-12 text-rp-ink">{summary.version}</dd>
              </div>
            </dl>
          </>
        )}
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="flex flex-col justify-between gap-3 rounded-lg border border-rp-line bg-rp-surface p-4">
            <div>
              <p className="text-[14px] font-medium text-rp-ink">Download a backup</p>
              <p className="mt-1 text-[13px] leading-5 text-rp-ink-muted">One SQLite file with every run, saved run, note and result. Open it with any SQLite tool.</p>
            </div>
            <Button asChild variant="outline" className="self-start">
              <a href={DATABASE_BACKUP_URL} download><Download aria-hidden="true" />Download backup</a>
            </Button>
          </div>
          <div className="flex flex-col justify-between gap-3 rounded-lg border border-rp-danger-border bg-rp-surface p-4">
            <div>
              <p className="text-[14px] font-medium text-rp-ink">Delete all runs</p>
              <p className="mt-1 text-[13px] leading-5 text-rp-ink-muted">Removes every captured run with its steps, notes, test sets, review queues and verification reports. Saved runs, prompts, keys and settings stay.</p>
            </div>
            <Button ref={deleteButton} type="button" variant="destructive-outline" className="self-start" disabled={!summary || summary.runs === 0} title={summary?.runs === 0 ? "There are no runs to delete" : undefined} onClick={() => setConfirmOpen(true)}>
              <Trash2 aria-hidden="true" />Delete all runs…
            </Button>
          </div>
        </div>
        {notice && <p role="status" className="settings-feedback mt-3">{notice}</p>}
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Delete ${plural(summary?.runs ?? 0, "run")}?`}
          description="This removes them from this machine and cannot be undone. Download a backup first if you might need them."
          confirmLabel={`Delete ${plural(summary?.runs ?? 0, "run")}`}
          busyLabel="Deleting…"
          onConfirm={deleteAll}
          returnFocus={() => deleteButton.current}
        >
          <ul className="mt-4 space-y-1 rounded-sm border border-rp-line bg-rp-canvas p-3 text-[13px] text-rp-ink-soft">
            <li><span className="font-medium text-rp-ink">Deleted:</span> {plural(summary?.runs ?? 0, "run")}, {plural(summary?.steps ?? 0, "step")}, notes, test sets, review queues, verification reports.</li>
            <li><span className="font-medium text-rp-ink">Kept:</span> {plural(summary?.savedRuns ?? 0, "saved run")}, prompts, provider keys, agent endpoints.</li>
          </ul>
        </ConfirmDialog>
      </section>

      <section aria-labelledby="settings-debug-heading">
        <h3 id="settings-debug-heading" className="rp-subsection-title">Debug</h3>
        <div className="mt-3 flex flex-col gap-4 rounded-lg border border-rp-line bg-rp-surface p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col">
            <span className="text-[14px] font-medium text-rp-ink">
              Coding-agent onboarding
            </span>
            <span className="mt-1 text-[13px] leading-5 text-rp-ink-muted">
              Show the local coding agent connection screen again.
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            className={reset ? "border-rp-success-border bg-rp-success-soft text-rp-success hover:border-rp-success-border hover:bg-rp-success-soft" : undefined}
            onClick={resetChatOnboarding}
          >
            {reset ? "Reset" : "Show again"}
          </Button>
        </div>
      </section>
    </>
  );
}
