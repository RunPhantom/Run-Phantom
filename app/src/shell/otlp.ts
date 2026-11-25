import { useQuery } from "@tanstack/react-query";
import { endpointForPort, type LocalService } from "../components/connect/connect-snippets";

interface HealthBody { ok?: unknown; service?: unknown; port?: unknown; runtime?: unknown }

/** The UI may be served by Vite on another port, so the daemon reports its own port. */
export async function readLocalService(fetcher: typeof fetch = fetch): Promise<LocalService> {
  const response = await fetcher("/health", { cache: "no-store" });
  const body = await response.json().catch(() => null) as HealthBody | null;
  if (!response.ok || body?.service !== "runphantom" || typeof body.port !== "number" || !Number.isInteger(body.port)) {
    throw new Error("Could not read the local service port.");
  }
  return { port: body.port, endpoint: endpointForPort(body.port), runtime: body.runtime === "binary" ? "binary" : "source" };
}

export async function readOtlpEndpoint(fetcher: typeof fetch = fetch): Promise<string> {
  return (await readLocalService(fetcher)).endpoint;
}

export function useLocalService() {
  return useQuery({ queryKey: ["local-service"], queryFn: () => readLocalService(), staleTime: 60_000, retry: 1 });
}
