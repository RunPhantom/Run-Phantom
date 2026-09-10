/**
 * Lists agent session transcripts off the main thread.
 *
 * Building this list parses every transcript under ~/.claude or ~/.codex. On a
 * real store that is seconds to tens of seconds of synchronous file I/O, and it
 * ran inside the request handler — so one cold page load froze the whole daemon:
 * health checks, OTLP ingest and the WebSocket UI all stalled behind it. The
 * parsers stay exactly as they are; only the thread they run on changes.
 */
import { listClaudeSessions } from "./claude-sessions";
import { listCodexSessions } from "./codex-sessions";

declare const self: Worker;

interface SessionsRequest {
  provider: "claude" | "codex";
  cwd: string;
}

self.onmessage = (event: MessageEvent<SessionsRequest>) => {
  const { provider, cwd } = event.data;
  try {
    const sessions = provider === "codex" ? listCodexSessions(cwd) : listClaudeSessions(cwd);
    self.postMessage({ ok: true, sessions });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
