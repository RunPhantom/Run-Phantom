import { useEffect, useState } from "react";

interface State { available: boolean; authentication: "unknown" | "required"; reason?: string; version?: string; workspaceGeneration: string; sessions: "runphantom_current_daemon"; protocolVersion?: 1 }
const reasons = new Set(["unavailable", "unsupported_protocol", "authentication_required", "protocol_error", "limit", "timeout", "cancelled", "scope_changed", "busy"]);
function parseStatus(value: unknown): State {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ACP status");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["available", "authentication", "reason", "version", "workspaceGeneration", "sessions", "protocolVersion"].includes(key)) || typeof body.available !== "boolean" || (body.authentication !== "unknown" && body.authentication !== "required") || typeof body.workspaceGeneration !== "string" || !/^[a-f0-9]{64}$/.test(body.workspaceGeneration) || body.sessions !== "runphantom_current_daemon" || (body.version !== undefined && (typeof body.version !== "string" || body.version.length > 64)) || (body.reason !== undefined && (typeof body.reason !== "string" || !reasons.has(body.reason))) || (body.protocolVersion !== undefined && body.protocolVersion !== 1) || (body.available && (body.protocolVersion !== 1 || body.reason !== undefined || body.authentication !== "unknown"))) throw new Error("Invalid ACP status");
  return body as unknown as State;
}

export function AcpProviderState({ cwd }: { cwd: string | null | undefined }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState(null); setError(null);
    if (!cwd) return () => controller.abort();
    void fetch(`/api/agent/acp/status?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not check OpenCode ACP.");
        const body = parseStatus(await response.json());
        if (!controller.signal.aborted) setState(body);
      }).catch(() => { if (!controller.signal.aborted) setError("Could not check OpenCode ACP."); });
    return () => controller.abort();
  }, [cwd, attempt]);
  return <div className="border-b border-[color:var(--rp-border)] px-3 py-2 text-xs text-[color:var(--rp-ink-soft)]">
    <p role="status">{!cwd ? "Choose a workspace to use OpenCode." : error ?? (state ? state.available ? "ACP ready. Sign-in has not been verified." : state.authentication === "required" ? "OpenCode sign-in required." : state.reason === "unsupported_protocol" ? "This OpenCode ACP version is unsupported." : "OpenCode ACP is unavailable." : "Checking OpenCode ACP...")}</p>
    <p className="mt-1 text-[10px] leading-relaxed text-[color:var(--rp-ink-muted)]">Chats listed here were created in this Run Phantom session. Client tool permissions are denied. No trace MCP is attached.</p>
    {(error || state?.available === false) && <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-1 min-h-11 rounded border border-[color:var(--rp-border)] px-3">Check again</button>}
  </div>;
}
