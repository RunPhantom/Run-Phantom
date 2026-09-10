import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Cpu, FlaskConical, Key, Plus, Trash2 } from "lucide-react";
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
import { C } from "../utils/colors";
import { fetchPrices, modelPricingConsentEnabled, setModelPricingConsent } from "../utils/costs";

type Tab = "agents" | "keys" | "debug";

const TABS: { id: Tab; label: string; icon: typeof Cpu }[] = [
  { id: "keys", label: "API Keys", icon: Key },
  { id: "agents", label: "Agent Endpoints", icon: Cpu },
  { id: "debug", label: "Debug", icon: FlaskConical },
];

function SectionBlock({
  title,
  description,
  panelId,
  labelledBy,
  children,
}: {
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
      className="rounded-xl border p-5 sm:p-6"
      style={{ borderColor: C.border, background: C.surface, boxShadow: "var(--rp-e1)" }}
    >
      <h2 className="text-[14px] font-medium mb-1" style={{ color: C.fg4 }}>
        {title}
      </h2>
      {description && (
        <p className="mb-5 text-[11px] leading-relaxed" style={{ color: C.fg1 }}>
          {description}
        </p>
      )}
      <div className="space-y-3">{children}</div>
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
    <div className="flex h-full flex-col lg:flex-row">
      <div className="border-b p-5 lg:w-64 lg:flex-shrink-0 lg:border-b-0 lg:border-r lg:p-6" style={{ borderColor: C.border }}>
        <h1 id={tablistLabelId} className="mb-4 pl-10 text-[22px] lg:pl-0" style={{ color: C.fg4 }}>
          Settings
        </h1>
        <nav
          role="tablist"
          aria-labelledby={tablistLabelId}
          aria-orientation="vertical"
          className="grid gap-2"
        >
          {TABS.map(({ id, label, icon: Icon }, index) => (
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
              className="rp-tab flex min-h-[44px] items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-[background-color,border-color,color] duration-150"
              style={{
                color: tab === id ? C.fg4 : C.fg1,
                background: tab === id ? C.selected : C.surface,
                borderColor: tab === id ? C.selectedBorder : C.border,
              }}
            >
              <Icon className="h-3.5 w-3.5 flex-shrink-0" style={{ opacity: tab === id ? 0.92 : 0.55 }} />
              <span className="text-[12px]">{label}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 overflow-auto p-5 lg:p-6">
        <div className="mx-auto w-full max-w-2xl pb-16 lg:mx-0 lg:max-w-3xl">
          <SectionBlock
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

  const reload = useCallback(async () => {
    try {
      const [nextAgents, nextHealth] = await Promise.all([getAgents(), getAgentsHealth()]);
      setAgents(nextAgents);
      setHealth(nextHealth);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useRunPhantomEvent("agents_updated", (data: { agents?: AgentsRegistry }) => {
    if (data?.agents) setAgents(data.agents);
  });

  const persistAgents = useCallback(
    async (nextAgents: AgentsRegistry) => {
      await saveAgents(nextAgents);
      setAgents(nextAgents);
      try {
        setHealth(await getAgentsHealth());
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const addAgent = useCallback(async () => {
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name || !url) return;

    const nextAgents: AgentsRegistry = {
      ...agents,
      [name]: { url, prefillFromTrace: {} satisfies NonNullable<AgentEntry["prefillFromTrace"]> },
    };

    await persistAgents(nextAgents);
    setNewName("");
    setNewUrl("");
  }, [agents, newName, newUrl, persistAgents]);

  const removeAgent = useCallback(
    async (name: string) => {
      const nextAgents = { ...agents };
      delete nextAgents[name];
      await persistAgents(nextAgents);
    },
    [agents, persistAgents],
  );

  return (
    <>
      <LocalAgentSetupCTA
        title="Register a new agent endpoint"
        description="Use the local replay setup flow for your coding tool, then review or edit the registered endpoint here."
      />

      {Object.keys(agents).length > 0 && (
        <div className="overflow-hidden rounded-2xl" style={{ border: `1px solid ${C.border}` }}>
          {Object.entries(agents).map(([name, config], index) => {
            const status = health[name] ?? "offline";
            return (
              <div
                key={name}
                className="group grid gap-2 px-3 py-3 sm:grid-cols-[auto_minmax(92px,120px)_minmax(0,1fr)_auto_auto] sm:items-center"
                style={{
                  borderTop: index > 0 ? `1px solid ${C.border}` : undefined,
                  background: index % 2 === 0 ? C.surface : C.elevated,
                }}
              >
                <div
                  className={`h-2 w-2 rounded-full flex-shrink-0 ${status === "online" ? "pulse-dot" : ""}`}
                  style={{ background: status === "online" ? C.green : C.fg0, opacity: status === "online" ? 0.85 : 0.5 }}
                />
                <span className="min-w-[84px] text-[12px] font-medium" style={{ color: C.fg3 }}>
                  {name}
                </span>
                <span className="flex-1 truncate font-mono text-[11px]" style={{ color: C.fg1 }}>
                  {config.url}
                </span>
                <span className="min-w-[48px] text-right text-[10px]" style={{ color: status === "online" ? C.green : C.fg0 }}>
                  {status}
                </span>
                <button
                  type="button"
                  className="min-h-[44px] rounded-xl px-3 py-2 text-left transition-colors hover:bg-[color:var(--rp-ink-wash)] sm:justify-self-end sm:px-2 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                  onClick={() => void removeAgent(name)}
                  aria-label={`Remove ${name}`}
                >
                  <Trash2 className="h-3 w-3" style={{ color: C.fg1 }} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <form
        className="grid gap-3 rounded-2xl border p-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)_auto] sm:items-end"
        style={{ borderColor: C.border, background: C.elevated }}
        onSubmit={(event) => {
          event.preventDefault();
          void addAgent();
        }}
      >
        <div className="min-w-0">
          <label className="mb-1.5 block text-[11px] font-medium" style={{ color: C.fg2 }} htmlFor="runphantom-agent-name">
            Agent name
          </label>
          <input
            id="runphantom-agent-name"
            className="min-h-[44px] w-full min-w-0 rounded-xl border px-3 py-2 font-mono text-[12px] outline-none transition-colors"
            style={{ background: C.surface, color: C.fg3, borderColor: C.border }}
            placeholder="agent-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
        </div>
        <div className="min-w-0">
          <label className="mb-1.5 block text-[11px] font-medium" style={{ color: C.fg2 }} htmlFor="runphantom-agent-url">
            Replay endpoint URL
          </label>
          <input
            id="runphantom-agent-url"
            className="min-h-[44px] w-full min-w-0 rounded-xl border px-3 py-2 font-mono text-[12px] outline-none transition-colors"
            style={{ background: C.surface, color: C.fg3, borderColor: C.border }}
            placeholder="http://localhost:5860/replay"
            value={newUrl}
            onChange={(event) => setNewUrl(event.target.value)}
          />
        </div>
        <button
          type="submit"
          aria-label="Add agent endpoint"
          className="min-h-[44px] rounded-xl border px-4 py-2 transition-colors rp-hover-wash"
          style={{ background: C.surface, color: C.fg2, borderColor: C.border }}
        >
          <span className="flex items-center justify-center gap-2 text-[12px] font-medium">
            <Plus className="h-3 w-3" />
            Add
          </span>
        </button>
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<SecretKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSecretStatuses()
      .then((next) => {
        if (!cancelled) setStatuses(next);
      })
      .catch(() => {
        if (!cancelled) setStatuses(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    if (!value) return;

    setSaveError(null);
    setSavingKey(key);
    try {
      const nextStatus = await saveSecret(key, value);
      setStatuses((current) => (current ? { ...current, [key]: nextStatus } : current));
      setDrafts((current) => ({ ...current, [key]: "" }));
      window.dispatchEvent(new CustomEvent("runphantom:api-key-change", { detail: { secret: key } }));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingKey(null);
    }
  }, []);

  const clearSecret = useCallback(async (key: SecretKey) => {
    setSaveError(null);
    setSavingKey(key);
    try {
      const nextStatus = await deleteSecret(key);
      setStatuses((current) => (current ? { ...current, [key]: nextStatus } : current));
      setDrafts((current) => ({ ...current, [key]: "" }));
      window.dispatchEvent(new CustomEvent("runphantom:api-key-change", { detail: { secret: key } }));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingKey(null);
    }
  }, []);

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
        className="rounded-xl border px-3 py-2 text-[11px] leading-relaxed"
        style={{ color: C.fg2, borderColor: C.border, background: C.elevated }}
      >
        Provider-backed Ask Agent and summaries send the selected trace content to the configured external provider. Model discovery contacts Anthropic. Optional model pricing contacts OpenRouter only after you enable it below. Capture, browsing, saved data, and registered local replay otherwise stay local unless the replay endpoint itself calls a provider.
      </div>
      <label className="flex min-h-11 items-start gap-3 rounded-xl border px-3 py-2.5" style={{ borderColor: C.border, background: C.elevated }}>
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-[color:var(--rp-accent)]"
          checked={modelPricingEnabled}
          onChange={(event) => {
            const enabled = event.target.checked;
            setModelPricingEnabled(enabled);
            setModelPricingConsent(enabled);
            if (enabled) void fetchPrices();
          }}
        />
        <span className="min-w-0">
          <span className="block text-[12px] font-medium" style={{ color: C.fg3 }}>Fetch public model pricing</span>
          <span className="mt-0.5 block text-[11px] leading-relaxed" style={{ color: C.fg1 }}>
            Contacts OpenRouter for public price metadata. No trace content, prompts, or API keys are included.
          </span>
        </span>
      </label>
      <SecretInput
        label="Anthropic"
        placeholder="sk-ant-..."
        description={sourceText("anthropic", "Used for Ask Agent, model discovery, and summaries that call Anthropic.")}
        value={drafts.anthropic}
        saved={secretSaved("anthropic")}
        sourceIsEnv={secretFromEnv("anthropic")}
        saving={savingKey === "anthropic"}
        onChange={(value) => setDraft("anthropic", value)}
        onSave={(value) => void persist("anthropic", value)}
        onClear={canClearSecret("anthropic") ? () => void clearSecret("anthropic") : undefined}
        getKeyUrl="https://console.anthropic.com/settings/keys"
      />
      <SecretInput
        label="OpenAI"
        placeholder="sk-..."
        description={sourceText("openai", "Used for Ask Agent and demo chat when those features call OpenAI.")}
        value={drafts.openai}
        saved={secretSaved("openai")}
        sourceIsEnv={secretFromEnv("openai")}
        saving={savingKey === "openai"}
        onChange={(value) => setDraft("openai", value)}
        onSave={(value) => void persist("openai", value)}
        onClear={canClearSecret("openai") ? () => void clearSecret("openai") : undefined}
        getKeyUrl="https://platform.openai.com/api-keys"
      />
      {saveError && (
        <div
          role="alert"
          className="rounded-xl border px-3 py-2 text-[11px]"
          style={{ color: C.red, borderColor: "color-mix(in srgb, var(--rp-danger) 24%, white 76%)", background: "color-mix(in srgb, var(--rp-danger) 8%, white 92%)" }}
        >
          {saveError}
        </div>
      )}
    </>
  );
}

function DebugSection() {
  const [reset, setReset] = useState(false);

  const resetChatOnboarding = useCallback(() => {
    try {
      localStorage.removeItem("runphantom:messagePane:providerIntroSeen");
    } catch {}
    window.dispatchEvent(new CustomEvent("runphantom:messagePane:resetOnboarding"));
    setReset(true);
    window.setTimeout(() => setReset(false), 1400);
  }, []);

  return (
    <>
      <div className="flex flex-col gap-4 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: C.border, background: C.elevated }}>
        <div className="flex min-w-0 flex-col">
          <span className="text-[12px]" style={{ color: C.fg3 }}>
            Coding-agent onboarding
          </span>
          <span className="mt-0.5 text-[11px]" style={{ color: C.fg1 }}>
            Show the local coding agent connection screen again.
          </span>
        </div>
        <button
          type="button"
          className="min-h-[44px] rounded-xl px-4 py-2 text-[11px] font-mono transition-colors rp-hover-wash"
          style={{ color: reset ? C.green : C.fg2, background: C.surface, border: `1px solid ${C.border}` }}
          onClick={resetChatOnboarding}
        >
          {reset ? "reset" : "show again"}
        </button>
      </div>
    </>
  );
}
