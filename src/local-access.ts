import { isIP } from "net";

export const RUNPHANTOM_BIND_HOST = "127.0.0.1";

function normalizeIpAddress(address: string | undefined | null): string | null {
  if (!address) return null;
  let candidate = address.trim().toLowerCase();
  if (candidate.startsWith("[") && candidate.endsWith("]")) {
    candidate = candidate.slice(1, -1);
  }
  if (candidate.startsWith("::ffff:")) {
    const mapped = candidate.slice("::ffff:".length);
    if (isIP(mapped) === 4) return mapped;
  }
  if (isIP(candidate) === 4) return candidate;
  if (isIP(candidate) !== 6) return null;
  try {
    const normalized = new URL(`http://[${candidate}]/`).hostname;
    return normalized.slice(1, -1).toLowerCase();
  } catch {
    return candidate;
  }
}

export function isLoopbackRemoteAddress(address: string | undefined | null): boolean {
  const normalized = normalizeIpAddress(address);
  if (!normalized) return false;
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}

export function parseAllowedSourceIpsEnv(value: string | undefined | null): Set<string> {
  const out = new Set<string>();
  for (const raw of value?.split(",") ?? []) {
    const normalized = normalizeIpAddress(raw);
    if (normalized) out.add(normalized);
  }
  return out;
}

export function isAllowedRemoteAddress(
  address: string | undefined | null,
  allowedSourceIps: ReadonlySet<string>,
): boolean {
  if (isLoopbackRemoteAddress(address)) return true;
  const normalized = normalizeIpAddress(address);
  return normalized !== null && allowedSourceIps.has(normalized);
}

/**
 * Parse RUNPHANTOM_ALLOWED_HOSTS into a set of bare, lowercased
 * hostnames accepted in the Host header (and, when present, the Origin
 * hostname). Entries may include a port (`host.docker.internal:5947`) or even
 * be pasted as a full URL (`http://host.docker.internal:5947/`); both are
 * reduced to the hostname. Source-address access is controlled independently
 * by RUNPHANTOM_ALLOWED_SOURCE_IPS.
 */
export function parseAllowedHostsEnv(value: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  for (const raw of value.split(",")) {
    let trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    // Tolerate URL-shaped entries copied from an exporter configuration.
    if (trimmed.includes("://")) {
      try {
        trimmed = new URL(raw.trim()).hostname.toLowerCase();
      } catch {
        continue;
      }
    }
    const name = hostnameOnly(trimmed);
    if (name) out.add(name);
  }
  return out;
}

/**
 * Extract the bare hostname from a Host header value or allowlist entry,
 * dropping any port. Handles bracketed (`[::1]:5947`) and bare (`::1`) IPv6.
 */
export function hostnameOnly(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(1, end) : host;
  }
  // A bare (unbracketed) IPv6 address contains multiple colons and no port —
  // don't treat the last segment as a port and truncate it.
  if (isIP(host) === 6) return host;
  return host.split(":")[0];
}
