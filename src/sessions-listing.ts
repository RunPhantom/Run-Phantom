/**
 * Non-blocking access to the agent session list.
 *
 * The parse is delegated to a worker so it cannot stall the daemon, and a warm
 * entry is served immediately while a refresh runs behind it — the UI asks for
 * this list on every page load, and re-parsing the whole store each time was
 * what made a cold load feel like a hang.
 */
import type { ClaudeSessionSummary } from "./claude-sessions";

const CACHE_TTL_MS = 10_000;
const WORKER_TIMEOUT_MS = 60_000;

interface Entry {
  sessions: ClaudeSessionSummary[];
  at: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<ClaudeSessionSummary[]>>();

/**
 * Parses in this thread. Correct everywhere, but blocks — only used when the
 * worker is unavailable.
 */
async function runInline(provider: "claude" | "codex", cwd: string): Promise<ClaudeSessionSummary[]> {
  const [{ listClaudeSessions }, { listCodexSessions }] = await Promise.all([
    import("./claude-sessions"),
    import("./codex-sessions"),
  ]);
  return provider === "codex" ? listCodexSessions(cwd) : listClaudeSessions(cwd);
}

function runInWorker(provider: "claude" | "codex", cwd: string): Promise<ClaudeSessionSummary[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sessions-worker.ts", import.meta.url));
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`listing ${provider} sessions exceeded ${WORKER_TIMEOUT_MS}ms`));
    }, WORKER_TIMEOUT_MS);
    const done = (fn: () => void) => { clearTimeout(timer); worker.terminate(); fn(); };
    worker.onmessage = (event: MessageEvent<{ ok: boolean; sessions?: ClaudeSessionSummary[]; error?: string }>) => {
      if (event.data.ok) done(() => resolve(event.data.sessions ?? []));
      else done(() => reject(new Error(event.data.error ?? "session listing failed")));
    };
    worker.onerror = (event: ErrorEvent) => done(() => reject(new Error(event.message || "session worker failed")));
    worker.postMessage({ provider, cwd });
  });
}

// `bun build --compile` does not embed the worker: the reference survives as a
// path into the binary's virtual filesystem that resolves to nothing, so the
// packaged daemon answered every session request with
// `ModuleNotFound resolving "/$bunfs/root/sessions-worker.ts"` -> HTTP 503,
// while source mode worked because the file was really on disk. Passing the
// worker as an extra --compile entry point and dropping `.href` from the URL
// were both tried and neither embedded it.
//
// So probe once and remember. Off-thread stays the default wherever Bun can
// actually spawn the worker, and the packaged binary degrades to a blocking
// parse instead of failing outright. If a future Bun embeds it, the probe
// succeeds and nothing here needs to change.
let workerUsable: boolean | null = null;

async function listSessions(provider: "claude" | "codex", cwd: string): Promise<ClaudeSessionSummary[]> {
  if (workerUsable === false) return runInline(provider, cwd);
  try {
    const sessions = await runInWorker(provider, cwd);
    workerUsable = true;
    return sessions;
  } catch (err) {
    if (workerUsable === true) throw err; // a real listing failure, not a spawn failure
    workerUsable = false;
    return runInline(provider, cwd);
  }
}

function refresh(key: string, provider: "claude" | "codex", cwd: string): Promise<ClaudeSessionSummary[]> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = listSessions(provider, cwd)
    .then((sessions) => {
      cache.set(key, { sessions, at: Date.now() });
      return sessions;
    })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, task);
  return task;
}

export async function listAgentSessions(
  provider: "claude" | "codex",
  cwd: string,
): Promise<{ sessions: ClaudeSessionSummary[]; stale: boolean }> {
  const key = `${provider} ${cwd}`;
  const entry = cache.get(key);

  if (entry && Date.now() - entry.at < CACHE_TTL_MS) {
    return { sessions: entry.sessions, stale: false };
  }

  // Stale-while-revalidate: an expired entry answers now and the refresh lands
  // in the cache for the next caller. Only a genuinely cold cwd waits.
  if (entry) {
    void refresh(key, provider, cwd).catch(() => { /* the served copy is still valid */ });
    return { sessions: entry.sessions, stale: true };
  }

  return { sessions: await refresh(key, provider, cwd), stale: false };
}

export function invalidateAgentSessions(): void {
  cache.clear();
}
