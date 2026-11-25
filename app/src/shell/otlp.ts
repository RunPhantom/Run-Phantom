interface HealthBody { ok?: unknown; service?: unknown; port?: unknown }

/** The UI may be served by Vite on another port, so the daemon reports its own port. */
export async function readOtlpEndpoint(fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher("/health", { cache: "no-store" });
  const body = await response.json().catch(() => null) as HealthBody | null;
  if (!response.ok || body?.service !== "runphantom" || typeof body.port !== "number" || !Number.isInteger(body.port)) {
    throw new Error("Could not read the local service port.");
  }
  return `http://127.0.0.1:${body.port}/v1/traces`;
}
