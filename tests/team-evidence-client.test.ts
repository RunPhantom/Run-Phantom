import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { TeamApiError, TeamClient, type SessionResponse } from "../app/src/api/team";
import { parseEvidenceExpectedSources } from "../src/evaluations/evidence-validation";
import { startTeamFixture } from "./helpers/team-server";

const session = (id = "principal-a"): SessionResponse => ({ authenticated: true, setupRequired: false,
  user: { id: "user", email: "member@example.test", isOwner: false, createdAt: 1 },
  session: { id, current: true, createdAt: 1, lastActiveAt: 1, expiresAt: 100, idleExpiresAt: 100 }, csrfToken: "csrf-fixture" });
const path = "/projects/project-a/evidence/sets/set-a";
afterEach(() => { mocks.forEach(mock => mock.mockRestore()); mocks.length = 0; });
const mocks: Array<{ mockRestore: () => void }> = [];
function responses(run: (input: string, init?: RequestInit) => Promise<Response> | Response) {
  mocks.push(spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => Promise.resolve(run(String(input), init))) as typeof fetch));
}
async function rejected(value: Promise<unknown>): Promise<unknown> {
  try { await value; } catch (error) { return error; }
  throw new Error("Expected request refusal");
}
function held() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return { response: new Response(stream, { headers: { "Content-Type": "application/json" } }),
    release: () => { controller.enqueue(new TextEncoder().encode('{"private":"late-body"}')); controller.close(); } };
}
const refusal = (status: number) => Response.json({ error: { code: "not_found", message: "Resource unavailable.", requestId: "safe-request" } }, { status });

describe("Team client protected existing semantics", () => {
  test("JSON mutations keep cookie CSRF, no-store and exact JSON/204 behavior", async () => {
    const client = new TeamClient(() => {}); client.setSession(session());
    responses((input, init) => { expect(input).toBe("/api/team/projects/project-a/notes"); expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: '{"text":"literal"}' }); expect(init?.headers).toEqual({ Accept: "application/json", "Content-Type": "application/json", "X-RunPhantom-CSRF": "csrf-fixture" }); return new Response(null, { status: 204 }); });
    expect(await client.request("/projects/project-a/notes", { method: "POST", body: { text: "literal" } })).toBeUndefined();
  });
  test("a session change refuses an already-held generic JSON body", async () => {
    const client = new TeamClient(() => {}); client.setSession(session()); const body = held(); responses(() => body.response);
    const request = client.request(path); client.setSession(session("principal-b")); body.release();
    expect(await rejected(request)).toMatchObject({ name: "AbortError" });
  });
  test("actual 404 invalidates held same-project body while another project remains publishable", async () => {
    const calls: unknown[] = []; const client = new TeamClient((...args) => calls.push(args)); client.setSession(session());
    const same = held(), other = held(); responses(input => input.endsWith("/missing") ? refusal(404) : input.includes("project-b") ? other.response : same.response);
    const a = client.request(path), b = client.request("/projects/project-b/runs");
    expect(await rejected(client.request("/projects/project-a/missing"))).toMatchObject({ status: 404, code: "not_found", requestId: "safe-request", message: "Resource unavailable." });
    same.release(); other.release(); expect(await rejected(a)).toMatchObject({ name: "AbortError" }); expect(await b).toEqual({ private: "late-body" }); expect(calls).toEqual([[404, "/projects/project-a/missing"]]);
  });
});

describe("bounded authenticated Team evidence bodies", () => {
  test("dedicated JSON controls admit exact64KiB UTF8 and refuse the next byte before fetch", async () => {
    let fetched = 0; const client = new TeamClient(() => {}), route = "/projects/project-a/evidence/inventories";
    const empty = new TextEncoder().encode(JSON.stringify({ padding: "" })).byteLength, remaining = 64 * 1024 - empty;
    const body = { padding: "☃".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3) };
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBe(64 * 1024);
    responses((_input, init) => { fetched++; expect(new TextEncoder().encode(String(init?.body)).byteLength).toBe(64 * 1024); return new Response(null, { status: 204 }); });
    expect(await client.evidence(route, { method: "PUT", body })).toBeUndefined(); body.padding += "x";
    expect(await rejected(client.evidence(route, { method: "PUT", body }))).toMatchObject({ code: "too_large" }); expect(fetched).toBe(1);
  });
  test("a genuine maximal32-source inventory is not reduced to the generic16KiB control budget", async () => {
    const client = new TeamClient(() => {});
    const expected = Array.from({ length: 32 }, (_, index) => ({ shardId: "s".repeat(124) + String(index).padStart(4, "0"), kind: "junit", constraints: { runnerId: "r".repeat(128), commit: "c".repeat(256), sourceSha256: "a".repeat(64) } }));
    expect(parseEvidenceExpectedSources(expected)).toEqual(expected);
    const body = { anchor: { kind: "run", id: "1".repeat(32) }, expectedRevision: 0, expected }, bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    expect(bytes).toBeGreaterThan(16 * 1024); expect(bytes).toBeLessThan(64 * 1024);
    responses((_input, init) => { expect(JSON.parse(String(init?.body))).toEqual(body); return Response.json({ revision: 1 }); });
    expect(await client.evidence("/projects/project-a/evidence/inventories", { method: "PUT", body })).toEqual({ revision: 1 });
  });
  test("the actual generic Team HTTP control boundary still refuses16KiB+1", async () => {
    const team = await startTeamFixture("f06-generic-control"), actualFetch = globalThis.fetch;
    try {
      const response = await actualFetch(`${team.url}/api/team/setup`, { method: "POST", headers: { Origin: team.url, "Content-Type": "application/json" }, body: JSON.stringify({ setupCode: team.setupCode, email: "owner@example.test", password: "F06 actual control passphrase" }) });
      expect(response.ok).toBe(true); const principal = await response.json() as SessionResponse, cookie = response.headers.get("set-cookie")?.split(";")[0]; expect(cookie).toBeTruthy();
      const client = new TeamClient(() => {}); client.setSession(principal);
      responses((input, init) => { const headers = new Headers(init?.headers); headers.set("Cookie", cookie!); headers.set("Origin", team.url); return actualFetch(`${team.url}${input}`, { ...init, headers }); });
      const remaining = 16 * 1024 + 1 - new TextEncoder().encode(JSON.stringify({ name: "" })).byteLength;
      const body = { name: "x".repeat(remaining) }; expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBe(16 * 1024 + 1);
      expect(await rejected(client.request("/projects", { method: "POST", body }))).toMatchObject({ status: 413, code: "too_large" });
      expect(await client.request<{ items: unknown[] }>("/projects")).toMatchObject({ items: [] });
    } finally { await team.close(); }
  });
  test("URL normalization cannot move evidence requests outside their admitted path", async () => {
    let fetched = 0; const client = new TeamClient(() => {}); responses(() => { fetched++; return Response.json({}); });
    for (const tail of ["../runs", "%2e%2e/runs", ".%2e/runs", "sets\\..\\runs", "sets#private"]) {
      expect(await rejected(client.evidence(`/projects/project-a/evidence/${tail}`))).toMatchObject({ code: "invalid_request" });
    }
    expect(fetched).toBe(0);
  });
  test("properly encoded projects and opaque JSON query values remain exact", async () => {
    const client = new TeamClient(() => {}); const query = new URLSearchParams({ anchor: JSON.stringify({ kind: "run", id: "literal/#%.. Unicode ☃" }) });
    const route = `/projects/project%20a/evidence/inventories?${query}`;
    responses(input => { expect(input).toBe(`/api/team${route}`); return Response.json({ safe: true }); });
    expect(await client.evidence(route)).toEqual({ safe: true });
  });
  test.each(["session", "abort", "404"])("held JSON body is refused after %s", async reason => {
    const client = new TeamClient(() => {}); client.setSession(session()); const body = held(); const signal = new AbortController();
    responses(input => input.endsWith("/missing") ? refusal(404) : body.response);
    const request = client.evidence(path, { signal: signal.signal });
    if (reason === "session") client.setSession(session("principal-b"));
    else if (reason === "abort") signal.abort();
    else expect(await rejected(client.request("/projects/project-a/missing"))).toBeInstanceOf(TeamApiError);
    body.release(); expect(await rejected(request)).toMatchObject({ name: "AbortError" });
  });
  test("held raw Blob cannot finish after project revocation", async () => {
    const client = new TeamClient(() => {}); client.setSession(session()); const body = held();
    responses(input => input.endsWith("/missing") ? refusal(404) : body.response);
    const request = client.evidenceBlob(`${path}/raw/report-1?revision=1`);
    expect(await rejected(client.request("/projects/project-a/missing"))).toBeInstanceOf(TeamApiError);
    body.release(); expect(await rejected(request)).toMatchObject({ name: "AbortError" });
  });
  test("binary frame remains a Blob with authenticated evidence content type", async () => {
    const client = new TeamClient(() => {}); client.setSession(session()); const body = new Blob([new Uint8Array([0, 0, 0, 2]), "{}", "report"], { type: "application/vnd.runphantom.evidence-import.v1+octet-stream" });
    responses((input, init) => { expect(input).toBe("/api/team/projects/project-a/evidence/imports"); expect(init?.body).toBe(body); expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" }); expect(init?.headers).toEqual({ Accept: "application/json", "Content-Type": body.type, "X-RunPhantom-CSRF": "csrf-fixture" }); return Response.json({ job: { status: "queued" } }, { status: 202 }); });
    expect(await client.evidence("/projects/project-a/evidence/imports", { method: "POST", body })).toEqual({ job: { status: "queued" } });
  });
  test("actual raw bytes at 2MiB accepted and 2MiB+1 refused without trusting declared length", async () => {
    const client = new TeamClient(() => {}); const raw = `${path}/raw/report-1?revision=1`; let size = 2 * 1024 * 1024;
    responses(() => new Response(new Uint8Array(size), { headers: { "Content-Length": "1", "Content-Type": "application/octet-stream" } }));
    expect((await client.evidenceBlob(raw)).size).toBe(size); size++; expect(await rejected(client.evidenceBlob(raw))).toMatchObject({ code: "too_large" });
  });
  test("actual 8MiB JSON accepted and 8MiB+1 refused", async () => {
    const client = new TeamClient(() => {}); let padding = 8 * 1024 * 1024 - 2;
    responses(() => new Response(`"${"x".repeat(padding)}"`, { headers: { "Content-Type": "application/json" } }));
    expect((await client.evidence<string>(path)).length).toBe(padding); padding++; expect(await rejected(client.evidence(path))).toMatchObject({ code: "too_large" });
  });
  test("encoding and large content length refuse before body acquisition", async () => {
    const client = new TeamClient(() => {}); let headers: Record<string, string> = { "Content-Encoding": "gzip" };
    responses(() => new Response("{}", { headers })); expect(await rejected(client.evidence(path))).toMatchObject({ code: "invalid_response" });
    headers = { "Content-Length": String(8 * 1024 * 1024 + 1) }; expect(await rejected(client.evidence(path))).toMatchObject({ code: "too_large" });
  });
  test("safe Team errors are retained and access errors delivered exactly once", async () => {
    const calls: unknown[] = []; const client = new TeamClient((...args) => calls.push(args)); responses(() => refusal(403));
    expect(await rejected(client.evidence(path))).toMatchObject({ status: 403, code: "not_found", message: "Resource unavailable.", requestId: "safe-request" }); expect(calls).toEqual([[403, path]]);
  });
  test("evidence extension refuses local paths and oversized control/upload before fetch", async () => {
    let fetched = 0; const client = new TeamClient(() => {}); responses(() => { fetched++; return Response.json({}); });
    expect(await rejected(client.evidence("/evaluations/evidence/sets"))).toMatchObject({ code: "invalid_request" });
    expect(await rejected(client.evidence("/projects/project-a/evidence/inventories", { method: "PUT", body: { tooBig: "x".repeat(64 * 1024) } }))).toMatchObject({ code: "too_large" });
    expect(await rejected(client.evidence("/projects/project-a/evidence/imports", { method: "POST", body: new Blob([new Uint8Array(8 * 1024 * 1024 + 64 * 1024 + 5)], { type: "application/vnd.runphantom.evidence-import.v1+octet-stream" }) }))).toMatchObject({ code: "too_large" }); expect(fetched).toBe(0);
  });
});


test.each(["json", "blob"] as const)("an outer-await %s materialization refuses the captured principal after a microtask change", async kind => {
  const nativeParse = JSON.parse, NativeBlob = globalThis.Blob;
  const text = '{"private":"fixture-old-principal"}';
  const observations: { replaceAt: number; accepted: boolean; materializedAfterReplacement: boolean }[] = [];
  for (let replaceAt = 1; replaceAt <= 8; replaceAt++) {
    const client = new TeamClient(() => {}); client.setSession(session("principal-a"));
    let tick = 0, replaced = false, materializedAfterReplacement = false;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => new Response(text, { headers: { "Content-Type": "application/json" } }));
    const parseMock = spyOn(JSON, "parse").mockImplementation((value: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (value === text) materializedAfterReplacement = replaced;
      return nativeParse(value, reviver);
    });
    globalThis.Blob = class extends NativeBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) { materializedAfterReplacement = replaced; super(parts, options); }
    } as typeof Blob;
    try {
      const request = kind === "json" ? client.evidence(path) : client.evidenceBlob(path + "/raw/report-1?revision=1");
      const replacement = new Promise<void>(resolve => {
        const advance = () => { if (++tick === replaceAt) { client.setSession(session("principal-b")); replaced = true; resolve(); } else queueMicrotask(advance); };
        queueMicrotask(advance);
      });
      const accepted = await request.then(() => true, error => { expect(error.name).toBe("AbortError"); return false; });
      await replacement;
      observations.push({ replaceAt, accepted, materializedAfterReplacement });
    } finally { globalThis.Blob = NativeBlob; parseMock.mockRestore(); fetchMock.mockRestore(); }
  }
  expect(observations.filter(value => value.accepted && value.materializedAfterReplacement)).toEqual([]);
  expect(observations.some(value => value.accepted && !value.materializedAfterReplacement)).toBe(true);
});
