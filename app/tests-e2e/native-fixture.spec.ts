import { test, expect } from "./fixtures";

test("runtime fixture starts a fresh daemon for the selected execution mode", async ({ request, runPhantom }) => {
  expect((await request.get(`${runPhantom.url}/health`)).ok()).toBe(true);
  const runs = await request.get(`${runPhantom.url}/api/runs`);
  expect(runs.ok()).toBe(true);
  expect(await runs.json()).toEqual([]);
});
