function isJson(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("application/json");
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = isJson(res) ? await res.json().catch(() => null) : null;
    const message = typeof body?.error === "string"
      ? body.error
      : typeof body?.error?.message === "string"
        ? body.error.message
        : `API error ${res.status}`;
    throw new Error(message);
  }
  // A 200 that isn't JSON (e.g. the SPA index.html served for an unknown /api
  // route) must not reach res.json() and reject with an opaque SyntaxError.
  if (!isJson(res)) throw new Error(`Expected JSON from ${path} but received ${res.headers.get("content-type") ?? "unknown"}`);
  return res.json() as Promise<T>;
}

export async function apiJsonOrNull<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(path, init);
  if (!res.ok || !isJson(res)) return null;
  return res.json() as Promise<T>;
}

export async function apiText(path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(text || `API error ${res.status}`);
  return text;
}

export function jsonInit(method: string, body?: unknown, init?: RequestInit): RequestInit {
  return {
    ...init,
    method,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
