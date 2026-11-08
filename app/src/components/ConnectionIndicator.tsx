import { useEffect, useState } from "react";
import { ChevronRight, Folder } from "lucide-react";
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
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ background: COLORS[status.state] }}
      />
      {status.state !== "green" && (
        <span className="truncate text-xs font-medium text-rp-ink">{providerLabel(provider)} unavailable</span>
      )}
      {dir && (
        <span className="flex min-w-0 items-center gap-1 text-xs text-rp-ink-muted">
          <Folder aria-hidden="true" className="size-3 shrink-0" />
          <span title={cwd ?? undefined} className="truncate font-mono">{dir}</span>
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
          className="rp-ease flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 hover:bg-rp-row-hover"
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
          className="rp-ease flex items-center gap-2 rounded-sm px-2 py-1 hover:bg-rp-row-hover"
          onClick={() => setShowRemediation((v) => !v)}
        >
          {statusContent}
        </button>
      )}
      {showWorkspaceMenu && status.state === "green" && (
        <div id="runphantom-workspace-menu" role="menu" aria-label="Registered workspaces" className="rp-pop absolute left-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-3rem))] rounded-lg border border-rp-line bg-white p-1 text-xs shadow-e3">
          {onChooseFolder && (
            <button
              type="button"
              role="menuitem"
              className="rp-ease mb-1 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-medium text-rp-blue hover:bg-rp-wash"
              onClick={() => {
                setShowWorkspaceMenu(false);
                onChooseFolder();
              }}
            >
              <Folder aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Choose folder…</span>
            </button>
          )}
          {workspaceError && (
            <div role="alert" className="px-2 py-1.5 text-rp-danger">{workspaceError}</div>
          )}
          {!workspaceError && workspaces.length === 0 && (
            <div className="px-2 py-2 text-rp-ink-muted">No registered workspaces.</div>
          )}
          {!workspaceError && workspaces.map((workspace) => (
            <button
              key={workspace.cwd}
              type="button"
              role="menuitemradio"
              aria-checked={workspace.cwd === cwd}
              title={workspace.cwd}
              className={`rp-ease flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left ${
                workspace.cwd === cwd ? "bg-rp-wash font-medium text-rp-blue" : "text-rp-ink-soft hover:bg-rp-row-hover hover:text-rp-ink"
              }`}
              onClick={() => void switchWorkspace(workspace.cwd, setShowWorkspaceMenu, setWorkspaceError)}
            >
              <Folder aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{cwdLabel(workspace.cwd)}</span>
              {workspace.agents && workspace.agents.length > 0 && (
                <span className="rp-meta shrink-0 truncate">{workspace.agents.join(", ")}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {showRemediation && status.state !== "green" && (
        <div id="runphantom-agent-remediation" role="dialog" aria-label={`${providerLabel(provider)} setup help`} className="rp-pop absolute left-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-3rem))] rounded-lg border border-rp-line bg-white p-4 text-xs shadow-e3">
          <div className="mb-2 leading-5 text-rp-ink">
            Run Phantom chat streams through your local {providerLabel(provider)} CLI. Make sure
            <code className="mx-1 rounded-control bg-rp-canvas-blue px-1 font-mono text-rp-ink">{provider === "codex" ? "codex" : "claude"}</code>
            is on your PATH and you are logged in.
          </div>
          <button
            type="button"
            aria-expanded={firstTimeOpen}
            className="rp-ease mt-1 inline-flex items-center gap-1 font-medium text-rp-blue hover:text-rp-blue-hover"
            onClick={() => setFirstTimeOpen((v) => !v)}
          >
            First time?
            <ChevronRight aria-hidden="true" className={`size-3.5 transition-transform duration-250 ease-standard motion-reduce:transition-none ${firstTimeOpen ? "rotate-90" : ""}`} />
          </button>
          {firstTimeOpen && (
            <div className="mt-3 space-y-2 border-t border-rp-line-muted pt-3 leading-5 text-rp-ink-soft">
              <div>
                From this source checkout, install dependencies once:
              </div>
              <div className="flex items-center gap-2 rounded-sm border border-rp-line-muted bg-rp-canvas-blue px-2 py-1.5 font-mono text-[11px] text-rp-ink">
                <span className="flex-1 select-all break-all">{installCommand}</span>
              </div>
              <div>
                Register Run Phantom with your detected agent tools once:
              </div>
              <div className="flex items-center gap-2 rounded-sm border border-rp-line-muted bg-rp-canvas-blue px-2 py-1.5 font-mono text-[11px] text-rp-ink">
                <span className="flex-1 select-all break-all">{setupCommand}</span>
              </div>
              <div>
                Run Phantom chat streams through {providerLabel(provider)} and injects
                the local Run Phantom MCP server into that session. Claude Code reads MCP
                entries from{" "}
                <code className="rounded-control bg-rp-canvas-blue px-1 font-mono text-rp-ink">
                  ~/.claude.json
                </code>
                , while Codex can also read MCP servers from{" "}
                <code className="rounded-control bg-rp-canvas-blue px-1 font-mono text-rp-ink">
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
