import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTeamFixture, type TeamFixture } from "./helpers/team-server";
import { rateFixture } from "./fixtures/pricing";

let fixture: TeamFixture, cookie: string, csrf: string, projectId: string;
const request = { from: 0, to: 86_400_000, bucket: "hour", estimateMode: "captured", rates: [rateFixture()] };
async function call(endpoint: string, body: unknown = request, headers: Record<string, string> = {}) {
  return fetch(`${fixture.url}/api/team${endpoint}`, { method: "POST", headers: { Origin: fixture.url, Cookie: cookie, "X-RunPhantom-CSRF": csrf, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
beforeAll(async () => {
  fixture = await startTeamFixture("pricing-api", process.env.RUNPHANTOM_TEAM_TEST_BINARY);
  const setup = await fetch(`${fixture.url}/api/team/setup`, { method: "POST", headers: { Origin: fixture.url, "Content-Type": "application/json" }, body: JSON.stringify({ setupCode: fixture.setupCode, email: "pricing@example.test", password: "Synthetic pricing password 2026" }) });
  expect(setup.status).toBe(201);
  cookie = setup.headers.get("set-cookie")!.split(";")[0]; csrf = (await setup.json()).csrfToken;
  const project = await call("/projects", { name: "Synthetic pricing project" }); expect(project.status).toBe(201); projectId = (await project.json()).id;
}, 20_000);
afterAll(async () => { await fixture?.close(); });

describe("actual team pricing HTTP boundary", () => {
  test("authorized analytics returns an explicitly empty complete roster", async () => {
    const response = await call(`/projects/${projectId}/pricing/analytics`);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.scope).toEqual({ kind: "team", projectId });
    expect(result.estimatedUsd).toMatchObject({ eligibleCount: 0, knownCount: 0, completeTotal: null });
    expect(result.rateAuthority).toBe("request-declared");
    expect(result.sourceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  test("auth, CSRF, origin and unsupported content cannot acquire data", async () => {
    expect((await call(`/projects/${projectId}/pricing/analytics`, request, { Cookie: "" })).status).toBe(401);
    expect((await call(`/projects/${projectId}/pricing/analytics`, request, { "X-RunPhantom-CSRF": "" })).status).toBe(403);
    expect((await call(`/projects/${projectId}/pricing/analytics`, request, { Origin: "https://foreign.example.test" })).status).toBe(403);
    expect((await call(`/projects/${projectId}/pricing/analytics`, request, { "Content-Type": "text/plain" })).status).toBe(415);
  });
  test("invalid request fields and rates are refused atomically", async () => {
    for (const body of [{ ...request, to: "86400000" }, { ...request, projectId: "foreign" }, { ...request, rates: [rateFixture({}, { currency: "EUR" as "USD" })] }]) {
      const response = await call(`/projects/${projectId}/pricing/analytics`, body);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
    }
    expect((await call(`/projects/${projectId}/pricing/analytics?window=all`)).status).toBe(400);
  });
  test("duplicate keys never silently select a replacement rate/window", async () => {
    const response = await fetch(`${fixture.url}/api/team/projects/${projectId}/pricing/analytics`, { method: "POST", headers: { Origin: fixture.url, Cookie: cookie, "X-RunPhantom-CSRF": csrf, "Content-Type": "application/json" }, body: '{"from":0,"from":1,"to":1000,"bucket":"hour","estimateMode":"captured","rates":[]}' });
    expect(response.status).toBe(400);
  });
  test("a foreign project remains inaccessible with a valid session", async () => {
    const response = await call("/projects/00000000-0000-4000-8000-000000000000/pricing/analytics");
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });
});
