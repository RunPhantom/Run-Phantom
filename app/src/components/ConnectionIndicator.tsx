import { useEffect, useState } from "react";
import { Folder } from "lucide-react";
import { providerLabel, type AgentProviderId } from "../utils/agent-provider";

type ChannelState = "green" | "amber" | "gray";

interface Status {
  state: ChannelState;
  session_id?: string;
}

interface RegisteredWorkspace {
  cwd: string;
  agents?: string[];
  active?: boolean;
}

const COLORS: Record<ChannelState, string> = {
  green: "var(--rp-success)",
  amber: "var(--rp-warning)",
  gray: "var(--rp-ink-muted)",
};

function cwdLabel(cwd: string | null): string {
  if (!cwd) return "";
  const trimmed = cwd.replace(/\/+$/, "");
  const base = trimmed.split("/").pop();
  return base || trimmed;
}

export function ConnectionIndicator({
  cwd = null,
  provider = "claude",
  onChooseFolder,
}: {
  cwd?: string | null;
  provider?: AgentProviderId;
  onChooseFolder?: () => void;
} = {}) {
  const [status, setStatus] = useState<Status>({ state: "gray" });
  const [showRemediation, setShowRemediation] = useState(false);
  const [firstTimeOpen, setFirstTimeOpen] = useState(false);
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const [workspaces, setWorkspaces] = useState<RegisteredWorkspace[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((body) => setStatus(body.agent ?? body.claude_code ?? { state: "gray" }))
      .catch(() => setStatus({ state: "gray" }));
  }, [provider]);

  useEffect(() => {
    if (!showRemediation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowRemediation(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showRemediation]);

  useEffect(() => {
    if (!showWorkspaceMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowWorkspaceMenu(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-workspace-switcher]")) setShowWorkspaceMenu(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [showWorkspaceMenu]);

  const installCommand = "bun install";
  const setupCommand = "runphantom setup";
  const dir = status.state === "green" ? cwdLabel(cwd) : "";
  const statusContent = (
    <>
      <span
        className="w-2 h-2 rounded-full"
        style={{ background: COLORS[status.state] }}
      />
      {status.state !== "green" && (
        <span className="truncate text-xs text-[color:var(--rp-ink-strong)]">{providerLabel(provider)} unavailable</span>
      )}
      {dir && (
        <span className="flex min-w-0 items-center gap-1 text-xs text-[color:var(--rp-ink-muted)]">
          <Folder className="h-3 w-3 shrink-0" />
          <span className="truncate">{dir}</span>
        </span>
      )}
    </>
  );

  return (
    <div className="relative" data-workspace-switcher>
      {status.state === "green" ? (
        <button
          type="button"
          aria-expanded={showWorkspaceMenu}
          aria-haspopup="menu"
          aria-controls="runphantom-workspace-menu"
          className="flex min-w-0 items-center gap-2 rounded px-2 py-1 transition hover:bg-[color:var(--rp-ink-wash)]"
          onClick={() => {
            setShowWorkspaceMenu((value) => !value);
            void loadRegisteredWorkspaces(setWorkspaces, setWorkspaceError);
          }}
          title="Switch workspace"
        >
          {statusContent}
        </button>
      ) : (
        <button
          type="button"
          aria-expanded={showRemediation}
          aria-haspopup="dialog"
          aria-controls="runphantom-agent-remediation"
          className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[color:var(--rp-ink-wash)] transition"
          onClick={() => setShowRemediation((v) => !v)}
        >
          {statusContent}
        </button>
      )}
      {showWorkspaceMenu && status.state === "green" && (
        <div id="runphantom-workspace-menu" role="menu" aria-label="Registered workspaces" className="absolute left-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-3rem))] rounded-lg border border-[color:var(--rp-border)] bg-[color:var(--rp-surface)] p-1 text-xs shadow-2xl">
          {onChooseFolder && (
            <button
              type="button"
              role="menuitem"
              className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[color:var(--rp-ink-strong)] transition-colors hover:bg-[color:var(--rp-ink-wash)]"
              onClick={() => {
                setShowWorkspaceMenu(false);
                onChooseFolder();
              }}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Choose folder...</span>
            </button>
          )}
          {workspaceError && (
            <div className="px-2 py-1.5 text-[color:var(--rp-danger)]">{workspaceError}</div>
          )}
          {!workspaceError && workspaces.length === 0 && (
            <div className="px-2 py-2 text-[color:var(--rp-ink-muted)]">No registered workspaces.</div>
          )}
          {!workspaceError && workspaces.map((workspace) => (
            <button
              key={workspace.cwd}
              type="button"
              role="menuitemradio"
              aria-checked={workspace.cwd === cwd}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                workspace.cwd === cwd ? "bg-[color:var(--rp-ink-wash)] text-[color:var(--rp-ink-strong)]" : "text-[color:var(--rp-ink-soft)] hover:bg-[color:var(--rp-ink-wash)] hover:text-[color:var(--rp-ink-strong)]"
              }`}
              onClick={() => void switchWorkspace(workspace.cwd, setShowWorkspaceMenu, setWorkspaceError)}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{cwdLabel(workspace.cwd)}</span>
              {workspace.agents && workspace.agents.length > 0 && (
                <span className="shrink-0 truncate text-[10px] text-[color:var(--rp-ink-muted)]">{workspace.agents.join(", ")}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {showRemediation && status.state !== "green" && (
        <div id="runphantom-agent-remediation" role="dialog" aria-label={`${providerLabel(provider)} setup help`} className="absolute left-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-3rem))] rounded-lg border border-[color:var(--rp-border)] bg-[color:var(--rp-surface)] p-3 text-xs shadow-2xl">
          <div className="text-[color:var(--rp-ink-strong)] mb-2 leading-relaxed">
            Run Phantom chat streams through your local {providerLabel(provider)} CLI. Make sure
            <code className="mx-1 rounded bg-[color:var(--rp-ink-wash)] px-1 font-mono">{provider === "codex" ? "codex" : "claude"}</code>
            is on your PATH and you are logged in.
          </div>
          <button
            className="mt-1 text-[color:var(--rp-ink-soft)] hover:text-[color:var(--rp-ink-strong)]"
            onClick={() => setFirstTimeOpen((v) => !v)}
          >
            First time? {firstTimeOpen ? "▾" : "▸"}
          </button>
          {firstTimeOpen && (
            <div className="mt-2 text-[color:var(--rp-ink-soft)] leading-relaxed space-y-2">
              <div>
                From this source checkout, install dependencies once:
              </div>
              <div className="flex items-center gap-2 rounded bg-[color:var(--rp-ink-wash)] px-2 py-1.5 font-mono text-[10px] text-[color:var(--rp-ink-strong)]">
                <span className="flex-1 select-all break-all">{installCommand}</span>
              </div>
              <div>
                Register Run Phantom with your detected agent tools once:
              </div>
              <div className="flex items-center gap-2 rounded bg-[color:var(--rp-ink-wash)] px-2 py-1.5 font-mono text-[10px] text-[color:var(--rp-ink-strong)]">
                <span className="flex-1 select-all break-all">{setupCommand}</span>
              </div>
              <div>
                Run Phantom chat streams through {providerLabel(provider)} and injects
                the local Run Phantom MCP server into that session. Claude Code reads MCP
                entries from{" "}
                <code className="font-mono bg-[color:var(--rp-ink-wash)] px-1 rounded">
                  ~/.claude.json
                </code>
                , while Codex can also read MCP servers from{" "}
                <code className="font-mono bg-[color:var(--rp-ink-wash)] px-1 rounded">
                  ~/.codex/config.toml
                </code>
                .
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

async function loadRegisteredWorkspaces(
  setWorkspaces: (workspaces: RegisteredWorkspace[]) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  setError(null);
  try {
    const res = await fetch("/api/workspace/registered");
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? "Could not load registered workspaces.");
    setWorkspaces(Array.isArray(body?.workspaces) ? body.workspaces : []);
  } catch (err) {
    setError((err as Error).message);
    setWorkspaces([]);
  }
}

async function switchWorkspace(
  cwd: string,
  setOpen: (open: boolean) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  setError(null);
  try {
    const res = await fetch("/api/workspace/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? "Could not switch workspace.");
    setOpen(false);
  } catch (err) {
    setError((err as Error).message);
  }
}
