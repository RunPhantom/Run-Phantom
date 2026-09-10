import type { RequestHandler } from "express";

/**
 * Origin/Referer allowlist for mutating Run Phantom daemon endpoints. Browser
 * requests must originate from the daemon UI, the Vite UI, or an explicit
 * RUNPHANTOM_ALLOWED_ORIGINS entry. Originless CLI and MCP calls remain valid.
 */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;

function normalizedHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function loopbackOrigins(port: number | null): string[] {
  if (!Number.isInteger(port) || (port ?? 0) < 1 || (port ?? 0) > 65535) return [];
  return LOOPBACK_HOSTS.map((host) => new URL(`http://${host}:${port}`).origin.toLowerCase());
}

export function isAllowedRunPhantomOrigin(
  value: string | undefined | null,
  daemonPort: number | null,
  uiPort: number | null,
  extraAllowedOrigins: Iterable<string> = [],
): boolean {
  if (!value) return false;
  const candidate = normalizedHttpOrigin(value);
  if (!candidate) return false;
  const allowed = new Set([...loopbackOrigins(daemonPort), ...loopbackOrigins(uiPort)]);
  for (const origin of extraAllowedOrigins) {
    const normalized = normalizedHttpOrigin(origin);
    if (normalized) allowed.add(normalized);
  }
  return allowed.has(candidate);
}

export function parseAllowedOriginsEnv(value: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  for (const raw of value.split(",")) {
    const normalized = normalizedHttpOrigin(raw.trim());
    if (normalized) out.add(normalized);
  }
  return out;
}

export interface LocalOriginGuardOptions {
  daemonPort?: number | (() => number | null);
  uiPort?: number;
  extraAllowedOrigins?: Iterable<string>;
}

export function createLocalOriginGuard(options: LocalOriginGuardOptions = {}): RequestHandler {
  const daemonPort = options.daemonPort ?? 5947;
  const uiPort = options.uiPort ?? 5948;
  const extra = parseAllowedOriginsEnv([...(options.extraAllowedOrigins ?? [])].join(","));

  return (req, res, next) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    const referer = typeof req.headers.referer === "string" ? req.headers.referer : null;

    // No browser-supplied origin: curl, fetch from MCP child, etc. Allow.
    if (!origin && !referer) return next();

    const candidate = origin ?? referer;
    const resolvedDaemonPort = typeof daemonPort === "function" ? daemonPort() : daemonPort;
    if (isAllowedRunPhantomOrigin(candidate, resolvedDaemonPort, uiPort, extra)) return next();

    res.status(403).json({ error: "origin not allowed" });
  };
}
