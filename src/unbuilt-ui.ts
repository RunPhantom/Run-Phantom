// A source checkout running `bun run dev` serves the UI from Vite on its own
// port and never builds app/dist. Run links that tools build from the daemon
// origin (every example's "Open in Run Phantom" link, http://127.0.0.1:5947/runs/<id>)
// then reached a daemon with no index.html and answered {"error":"invalid request"}.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The Vite UI origin that scripts/dev.ts announces; only a loopback http origin is accepted. */
export function devUiOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface Navigation {
  method: string;
  path: string;
  originalUrl: string;
  accept: string | undefined;
}

/** Browser page loads only; API, ingest and asset requests keep their JSON answers. */
export function isPageNavigation(request: Navigation): boolean {
  return (request.method === "GET" || request.method === "HEAD")
    && !request.path.startsWith("/api/")
    && (request.accept ?? "").includes("text/html");
}

/** Same path and query on the development UI origin. */
export function devUiLocation(origin: string, originalUrl: string): string {
  const target = new URL(originalUrl.startsWith("/") ? originalUrl : `/${originalUrl}`, origin);
  if (target.origin !== origin) return `${origin}/`;
  return target.href;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

export function unbuiltUiPage(uiPort: string): string {
  const devUrl = escapeHtml(`http://localhost:${uiPort}`);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Run Phantom UI not built</title></head>
<body style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.6; color: #1c1c28;">
<h1 style="font-size: 1.4rem;">The Run Phantom UI is not built in this checkout</h1>
<p>This daemon is running from source without <code>app/dist</code>, so it cannot serve pages. Your traces are still being captured.</p>
<p>If <code>bun run dev</code> is running, open the development UI at <a href="${devUrl}">${devUrl}</a>.</p>
<p>To serve the UI from the daemon instead, run <code>bun run build:ui</code> and reload this page.</p>
</body>
</html>`;
}
