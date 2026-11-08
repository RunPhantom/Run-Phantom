import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
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
  getSecretStatuses,
  saveSecret,
  type SecretKey,
  type SecretStatus,
  type SecretStatuses,
} from "../api/secrets";
import { useRunPhantomEvent } from "../hooks/use-runphantom-ws";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Eyebrow } from "@/components/ui/typography";
import "./settings.css";
import { fetchPrices, modelPricingConsentEnabled, setModelPricingConsent } from "../utils/costs";

type Tab = "agents" | "keys" | "debug";

const TABS: { id: Tab; label: string }[] = [
  { id: "keys", label: "API Keys" },
  { id: "agents", label: "Agent Endpoints" },
  { id: "debug", label: "Debug" },
];

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
      <div className="mt-6 space-y-4">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>("keys");
  const tablistLabelId = useId();
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    agents: null,
    keys: null,
    debug: null,
  });

  const sectionMap: Record<Tab, () => ReactNode> = {
    agents: () => <AgentEndpointsSection />,
    keys: () => <KeysSection />,
    debug: () => <DebugSection />,
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
      <div className="border-b border-rp-line bg-white px-5 py-6 lg:w-64 lg:flex-shrink-0 lg:border-b-0 lg:border-r lg:px-5 lg:py-8">
        <Eyebrow marker tone="accent">Settings / Local</Eyebrow>
        <h1 id={tablistLabelId} className="rp-subsection-title mt-2">
          Settings
        </h1>
        <p className="rp-field-hint mt-1">Stored by the daemon on this machine.</p>
        <nav
          role="tablist"
          aria-labelledby={tablistLabelId}
          aria-orientation="vertical"
          className="mt-5 grid gap-1"
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
              className={`rp-tab rp-ease flex min-h-10 items-center gap-3 rounded-sm px-3 text-left text-[14px] ${tab === id ? "bg-rp-wash font-semibold text-rp-blue" : "text-rp-ink-soft hover:bg-rp-row-hover"}`}
            >
              <span aria-hidden="true" className={`font-mono text-[11px] tabular-nums ${tab === id ? "text-rp-blue" : "text-rp-index"}`}>{String(index + 1).padStart(2, "0")}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto px-5 py-8 sm:px-10 sm:py-11">
        <div className="w-full max-w-3xl pb-16">
          <SectionBlock
            key={tab}
            eyebrow={currentTabConfig.id === "keys" ? "Providers / Write-only keys" : currentTabConfig.id === "agents" ? "Replay / Local endpoints" : "Local UI state"}
            title={currentTabConfig.label}
            description={
              currentTabConfig.id === "keys"
                ? "Keys are sent once to the local daemon and are never read back into the browser. Paste a new key to replace a saved one."
                : currentTabConfig.id === "agents"
                  ? "Register local replay endpoints that Run Phantom can launch or reuse when you replay a captured run."
                  : "Tools for resetting local UI state without touching captured traces."
            }
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
        <div className="overflow-hidden rounded-lg border border-rp-line bg-white">
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
        className="grid gap-4 rounded-lg border border-rp-line bg-white p-5 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)_auto] sm:items-end"
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

function KeysSection() {
  const [modelPricingEnabled, setModelPricingEnabled] = useState(modelPricingConsentEnabled);
  const [drafts, setDrafts] = useState<Record<SecretKey, string>>({
    anthropic: "",
    openai: "",
  });
  const [statuses, setStatuses] = useState<SecretStatuses | null>(null);
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
    getSecretStatuses()
      .then((next) => {
        if (!cancelled) setStatuses(next);
      })
      .catch(() => {
        if (!cancelled) { setStatuses(null); setStatusError("Saved key status is unavailable. Try loading it again before changing keys."); }
      });
    return () => {
      cancelled = true;
      active.current = false;
    };
  }, [statusAttempt]);

  useRunPhantomEvent("secrets_updated", (data: { key?: SecretKey; status?: SecretStatus }) => {
    if (!data?.key || !data.status) return;
    const secretKey = data.key;
    const secretStatus = data.status;
    setStatuses((current) => (current ? { ...current, [secretKey]: secretStatus } : current));
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
      window.dispatchEvent(new CustomEvent("runphantom:api-key-change", { detail: { secret: key } }));
    } catch (error) {
      if (active.current) setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      if (active.current) setSavingKey(null);
    }
  }, [statuses]);

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
      window.dispatchEvent(new CustomEvent("runphantom:api-key-change", { detail: { secret: key } }));
    } catch (error) {
      if (active.current) setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      if (active.current) setSavingKey(null);
    }
  }, [statuses]);

  const sourceText = useCallback(
    (key: SecretKey, fallback: string) => {
      const status = statuses?.[key];
      if (!status?.configured) return fallback;
      return status.source === "env" ? "Configured from environment." : undefined;
    },
    [statuses],
  );

  const secretSaved = useCallback((key: SecretKey) => statuses?.[key]?.configured === true, [statuses]);
  const canClearSecret = useCallback((key: SecretKey) => statuses?.[key]?.stored === true, [statuses]);
  const secretFromEnv = useCallback((key: SecretKey) => statuses?.[key]?.stored !== true, [statuses]);

  return (
    <>
      <div
        role="note"
        className="rounded-lg border border-rp-line-muted bg-rp-canvas-blue px-4 py-3 text-[13px] leading-6 text-rp-ink-soft"
      >
        <Eyebrow className="mb-1.5">Data boundary</Eyebrow>
        <p>Provider-backed Ask Agent and summaries send the selected trace content to the configured external provider. Model discovery contacts Anthropic. Optional model pricing contacts OpenRouter only after you enable it below. Capture, browsing, saved data, and registered local replay otherwise stay local unless the replay endpoint itself calls a provider.</p>
      </div>
      <label className="rp-ease flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-rp-line bg-white px-4 py-3.5 hover:border-rp-wash-border">
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
          <span className="mt-0.5 block text-[12px] leading-5 text-rp-ink-muted">
            Contacts OpenRouter for public price metadata. No trace content, prompts, or API keys are included.
          </span>
        </span>
      </label>
      {!statuses && !statusError && <p role="status" className="settings-description">Checking saved key status…</p>}
      {statusError && <div role="alert" className="settings-feedback settings-error"><p>{statusError}</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setStatusAttempt(value => value + 1)}>Try loading key status again</Button></div>}
      <div className="divide-y divide-rp-line-muted rounded-lg border border-rp-line bg-white px-5">
      <SecretInput
        label="Anthropic"
        placeholder="sk-ant-..."
        description={sourceText("anthropic", "Used for Ask Agent, model discovery, and summaries that call Anthropic.")}
        value={drafts.anthropic}
        saved={secretSaved("anthropic")}
        sourceIsEnv={secretFromEnv("anthropic")}
        saving={!statuses || savingKey !== null}
        onChange={(value) => setDraft("anthropic", value)}
        onSave={(value) => void persist("anthropic", value)}
        onClear={canClearSecret("anthropic") ? () => void clearSecret("anthropic") : undefined}
        getKeyUrl="https://console.anthropic.com/settings/keys"
      />
      <SecretInput
        label="OpenAI"
        placeholder="sk-..."
        description={sourceText("openai", "Used for Ask Agent and chat when those features call OpenAI.")}
        value={drafts.openai}
        saved={secretSaved("openai")}
        sourceIsEnv={secretFromEnv("openai")}
        saving={!statuses || savingKey !== null}
        onChange={(value) => setDraft("openai", value)}
        onSave={(value) => void persist("openai", value)}
        onClear={canClearSecret("openai") ? () => void clearSecret("openai") : undefined}
        getKeyUrl="https://platform.openai.com/api-keys"
      />
      </div>
      {saveError && (
        <div
          role="alert"
          className="rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-[13px] text-rp-danger"
        >
          {saveError}
        </div>
      )}
    </>
  );
}

function DebugSection() {
  const [reset, setReset] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const resetChatOnboarding = useCallback(() => {
    try {
      localStorage.removeItem("runphantom:messagePane:providerIntroSeen");
    } catch {}
    window.dispatchEvent(new CustomEvent("runphantom:messagePane:resetOnboarding"));
    setReset(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setReset(false), 1400);
  }, []);

  return (
    <>
      <div className="flex flex-col gap-4 rounded-lg border border-rp-line bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
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
    </>
  );
}
