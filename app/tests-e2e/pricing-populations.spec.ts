import { createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import type { Snapshot } from "../../src/evaluations/protocol";
import { expect, test } from "./fixtures";
import { headerSeparatorProblems } from "./helpers";

const CATALOGUE_URL = "https://openrouter.ai/api/v1/models";
const CATALOGUE = JSON.stringify({ data: [
  { id: "fixture/known", pricing: { prompt: "0.000003", completion: "0.000015" } },
  { id: "fixture/free", pricing: { prompt: "0", completion: "0" } },
] });
const REVISION = `sha256:${createHash("sha256").update(CATALOGUE).digest("hex")}`;
const DESKTOP = { width: 1536, height: 720 };
const MOBILE = [{ width: 390, height: 844 }, { width: 320, height: 740 }];
const SUMMARY = /^(?:Estimate unavailable|Estimated cost \$|Known estimates \$)/;

type CapturedRow = { model: string | null; input: number | null; output: number | null; reported: number | null };
type Population = { name: string; runId: string; rows: readonly CapturedRow[]; ready: string | null; reported: number | null };
const POPULATIONS: readonly Population[] = [
  { name: "TRACE-only empty", runId: "0000000000000000000000000000f150", rows: [], ready: null, reported: null },
  { name: "all unavailable", runId: "0000000000000000000000000000f160", rows: [
    { model: null, input: 12, output: 24, reported: null },
    { model: "fixture/known", input: 200, output: null, reported: null },
    { model: "fixture/missing-price", input: 100, output: 50, reported: null },
  ], ready: "Estimate unavailable", reported: null },
  { name: "free zero", runId: "0000000000000000000000000000f170", rows: [
    { model: "fixture/free", input: 0, output: 0, reported: 0.123 },
  ], ready: "Estimated cost $0.00", reported: 0.123 },
  { name: "mixed known and unavailable", runId: "0000000000000000000000000000f180", rows: [
    { model: "fixture/known", input: 200, output: 300, reported: 0.123 },
    { model: "fixture/missing-price", input: 100, output: 50, reported: 0.123 },
  ], ready: "Known estimates $0.0051 · 1 unavailable", reported: 0.246 },
];

test.use({ hasTouch: true });

type State = "disabled" | "loading" | "ready" | "revoked";
type CapturedSpan = {
  id: string; run_id: string; parent_span_id: string | null; span_type: string | null;
  model: string | null; input_tokens: number | null; output_tokens: number | null; attributes: string;
};
type Detail = { run: { id: string }; spans: CapturedSpan[] };
const spanId = (population: Population, index: number) =>
  (BigInt(`0x${population.runId.slice(-16)}`) + BigInt(index)).toString(16).padStart(16, "0");

async function capture(url: string, population: Population, promptCanary: string): Promise<Detail> {
  const end = Date.now() - 60_000, start = end - 800;
  const root = {
    traceId: population.runId, spanId: spanId(population, 0), name: `Population layout: ${population.name}`, kind: 1,
    startTimeUnixNano: String(BigInt(start) * 1_000_000n), endTimeUnixNano: String(BigInt(end) * 1_000_000n), status: { code: 1 },
    attributes: [
      { key: "runphantom.span.kind", value: { stringValue: "trace" } },
      { key: "runphantom.event.name", value: { stringValue: `Population layout: ${population.name}` } },
      { key: "runphantom.input", value: { stringValue: promptCanary } },
      { key: "runphantom.output", value: { stringValue: "Captured synthetic root output." } },
    ],
  };
  const children = population.rows.map((row, index) => ({
    traceId: population.runId, spanId: spanId(population, index + 1), parentSpanId: root.spanId,
    name: "population.fixture.generation", kind: 1,
    startTimeUnixNano: String(BigInt(start + 10 + index * 20) * 1_000_000n),
    endTimeUnixNano: String(BigInt(start + 20 + index * 20) * 1_000_000n), status: { code: 1 },
    attributes: [
      { key: "runphantom.span.kind", value: { stringValue: "llm_call" } },
      { key: "ai.operationId", value: { stringValue: "ai.generateText" } },
      { key: "ai.model.provider", value: { stringValue: "fixture-provider" } },
      { key: "runphantom.output", value: { stringValue: "Captured synthetic generation output." } },
      ...(row.model === null ? [] : [{ key: "ai.model.id", value: { stringValue: row.model } }]),
      ...(row.input === null ? [] : [{ key: "ai.usage.inputTokens", value: { intValue: String(row.input) } }]),
      ...(row.output === null ? [] : [{ key: "ai.usage.outputTokens", value: { intValue: String(row.output) } }]),
      ...(row.reported === null ? [] : [{ key: "gen_ai.usage.cost_usd", value: { doubleValue: row.reported } }]),
    ],
  }));
  const response = await fetch(`${url}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [root, ...children] }] }] }) });
  expect(response.ok).toBe(true);
  const detail = await readDetail(url, population);
  expect(detail.run.id).toBe(population.runId);
  expect(detail.spans).toHaveLength(population.rows.length + 1);
  const expected = [{ id: root.spanId, run_id: population.runId, parent_span_id: null, span_type: "TRACE", model: null,
    input_tokens: null, output_tokens: null, reported: null, hasReported: false },
  ...population.rows.map((row, index) => ({ id: spanId(population, index + 1), run_id: population.runId,
    parent_span_id: root.spanId, span_type: "LLM_GENERATION", model: row.model, input_tokens: row.input,
    output_tokens: row.output, reported: row.reported, hasReported: row.reported !== null }))];
  expect(detail.spans.map(span => {
    const attributes = JSON.parse(span.attributes) as Record<string, unknown>;
    return { id: span.id, run_id: span.run_id, parent_span_id: span.parent_span_id, span_type: span.span_type,
      model: span.model, input_tokens: span.input_tokens, output_tokens: span.output_tokens,
      reported: attributes["gen_ai.usage.cost_usd"] ?? null, hasReported: Object.hasOwn(attributes, "gen_ai.usage.cost_usd") };
  }).sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
  expect(detail.spans.filter(span => span.span_type === "LLM_GENERATION")).toHaveLength(population.rows.length);
  const rootAttributes = JSON.parse(detail.spans.find(span => span.id === root.spanId)!.attributes) as Record<string, unknown>;
  expect(rootAttributes["runphantom.input"]).toBe(promptCanary);
  expect(Object.keys(rootAttributes).some(key => /model|usage|tokens/.test(key))).toBe(false);
  return detail;
}

async function readDetail(url: string, population: Population): Promise<Detail> {
  const response = await fetch(`${url}/api/runs/detail/${population.runId}`);
  expect(response.ok).toBe(true);
  return await response.json() as Detail;
}

async function readSnapshot(url: string, population: Population): Promise<Snapshot> {
  const response = await fetch(`${url}/api/evaluations/runs/${population.runId}/snapshot`);
  expect(response.ok).toBe(true);
  return await response.json() as Snapshot;
}

const capturedPricing = (detail: Detail) => detail.spans.map(span => ({ id: span.id, parent: span.parent_span_id,
  type: span.span_type, model: span.model, input: span.input_tokens, output: span.output_tokens, attributes: span.attributes,
})).sort((a, b) => a.id.localeCompare(b.id));

function controlledNetwork(pages: { run: Page; settings: Page }, origin: string, canaries: readonly string[]) {
  const counters = () => ({ requests: 0, fulfilled: 0, blockedNonlocal: 0, invalidCatalogue: 0, canaryLeak: 0,
    handlerFailures: 0, cleanupAborts: 0, firstHeldAt: 0 });
  const counts = { run: counters(), settings: counters() };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = new Set<Promise<void>>();
  let runHandler: ((route: Route) => Promise<void>) | undefined;
  let stopping = false;
  const dispatch = async (label: keyof typeof pages, route: Route) => {
    const stats = counts[label];
    try {
      const request = route.request(), target = new URL(request.url());
      if (request.url() === CATALOGUE_URL) {
        stats.requests++;
        const headers = await request.allHeaders();
        const body = request.postData();
        const valid = request.method() === "GET" && body === null
          && !Object.keys(headers).some(key => /^(?:authorization|proxy-authorization)$/i.test(key));
        const data = [request.url(), body ?? "", ...Object.values(headers)].join("\n");
        const privateDataAbsent = canaries.every(canary => !data.includes(canary));
        if (!valid || !privateDataAbsent) {
          if (!valid) stats.invalidCatalogue++;
          if (!privateDataAbsent) stats.canaryLeak++;
          await route.abort("blockedbyclient");
          return;
        }
        stats.firstHeldAt ||= Date.now();
        await held;
        if (stopping) { stats.cleanupAborts++; await route.abort("aborted"); }
        else { await route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: CATALOGUE }); stats.fulfilled++; }
      } else if (target.origin === origin || ["about:", "blob:", "data:"].includes(target.protocol)) {
        if (stopping) { stats.cleanupAborts++; await route.abort("aborted"); }
        else await route.continue();
      } else {
        stats.blockedNonlocal++;
        await route.abort("blockedbyclient");
      }
    } catch (error) {
      const closedByCleanup = stopping && pages[label].isClosed() && error instanceof Error
        && /Target (?:page, context or browser|page|context|browser).*closed|has been closed/i.test(error.message);
      if (!closedByCleanup) stats.handlerFailures++;
    }
  };
  return {
    counts,
    release,
    async install() {
      for (const label of ["run", "settings"] as const) {
        const handler = (route: Route) => {
          const task = dispatch(label, route);
          pending.add(task);
          void task.finally(() => pending.delete(task));
          return task;
        };
        if (label === "run") runHandler = handler;
        await pages[label].route("**/*", handler);
      }
    },
    verify(requests: number, fulfilled: number) {
      for (const stats of Object.values(counts)) expect({ requests: stats.requests, fulfilled: stats.fulfilled,
        blockedNonlocal: stats.blockedNonlocal, invalidCatalogue: stats.invalidCatalogue, canaryLeak: stats.canaryLeak,
        handlerFailures: stats.handlerFailures }).toEqual({ requests, fulfilled, blockedNonlocal: 0,
        invalidCatalogue: 0, canaryLeak: 0, handlerFailures: 0 });
    },
    heldMilliseconds() { return Math.max(...Object.values(counts).map(stats => stats.firstHeldAt ? Date.now() - stats.firstHeldAt : 0)); },
    async stop() {
      stopping = true;
      release();
      try { await pages.settings.close(); }
      finally {
        try {
          if (runHandler && !pages.run.isClosed()) await pages.run.unroute("**/*", runHandler);
        } finally { await Promise.all([...pending]); }
      }
      expect(Object.values(counts).every(stats => stats.handlerFailures === 0 && stats.blockedNonlocal === 0
        && stats.invalidCatalogue === 0 && stats.canaryLeak === 0)).toBe(true);
    },
    receipt() {
      return Object.fromEntries(Object.entries(counts).map(([label, stats]) => [label, {
        requests: stats.requests, fulfilled: stats.fulfilled, blockedNonlocal: stats.blockedNonlocal,
        validCatalogueShape: stats.invalidCatalogue === 0, canariesAbsent: stats.canaryLeak === 0,
        handlerFailures: stats.handlerFailures, cleanupAborts: stats.cleanupAborts,
      }]));
    },
  };
}

type NativeCatalogueBody = {
  calls: number; responses: number; status: number | null; bytes: number[] | null;
  phase: "idle" | "pending" | "reading" | "complete" | "error";
  failure: "duplicate" | "fetch-error" | "clone-error" | "read-error" | "oversize" | "observer-error" | null;
  timing: { fetch: number | null; response: number | null; read: number | null; terminal: number | null };
};
type NativeCataloguePort = {
  read(): Promise<NativeCatalogueBody>;
  stop(): NativeCatalogueBody;
};

function nativeCatalogueBodies(pages: { run: Page; settings: Page }) {
  const key = "__runPhantomPopulationCatalogueBody";
  const receipts: Record<keyof typeof pages, unknown> = { run: null, settings: null };
  const remember = (label: keyof typeof pages, value: NativeCatalogueBody) => {
    const bytes = value.bytes === null ? null : Buffer.from(value.bytes);
    receipts[label] = { calls: value.calls, responses: value.responses, status: value.status,
      phase: value.phase, failure: value.failure, timing: value.timing, byteLength: bytes?.length ?? null,
      bodySha256: bytes === null ? null : createHash("sha256").update(bytes).digest("hex"),
      exactBytes: bytes === null ? null : bytes.equals(Buffer.from(CATALOGUE)) };
  };
  return {
    async install() {
      for (const label of ["run", "settings"] as const) {
        await pages[label].addInitScript(({ url, key, maxBytes }) => {
          // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply below preserves the caller's fetch receiver and the actual Response receiver for clone.
          const nativeFetch = window.fetch, nativeClone = Response.prototype.clone;
          // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply below supplies the actual cloned Response receiver.
          const nativeRead = Response.prototype.arrayBuffer;
          const monotonicNow = performance.now.bind(performance), installedAt = monotonicNow();
          // Times are relative to this page's installation, not another page's clock.
          const timing: NativeCatalogueBody["timing"] = { fetch: null, response: null, read: null, terminal: null };
          let calls = 0, responses = 0, status: number | null = null, bytes: number[] | null = null;
          let phase: NativeCatalogueBody["phase"] = "idle", failure: NativeCatalogueBody["failure"] = null;
          let complete!: () => void;
          const done = new Promise<void>(resolve => { complete = resolve; });
          const snapshot = (): NativeCatalogueBody => ({ calls, responses, status,
            bytes: bytes === null ? null : [...bytes], phase, failure, timing: { ...timing } });
          const fail = (reason: NonNullable<NativeCatalogueBody["failure"]>) => {
            if (failure === null) { failure = reason; timing.terminal = monotonicNow() - installedAt; }
            phase = "error"; bytes = null; complete();
          };
          // Cloning tees the native stream. This observer is restricted to the
          // fixed 153-byte catalogue, with a small cap and no application wait.
          const observedFetch = function (this: unknown, ...args: Parameters<typeof nativeFetch>) {
            let promise: ReturnType<typeof nativeFetch>;
            try { promise = Reflect.apply(nativeFetch, this, args) as ReturnType<typeof nativeFetch>; }
            catch (error) {
              if (args[0] === url) { calls++; timing.fetch ??= monotonicNow() - installedAt; fail("fetch-error"); }
              throw error;
            }
            if (args[0] !== url) return promise;
            try {
              calls++;
              timing.fetch ??= monotonicNow() - installedAt;
              if (calls !== 1) { fail("duplicate"); return promise; }
              phase = "pending";
              const observed = promise.then(response => {
                try {
                  if (failure !== null) return;
                  responses++; status = response.status; phase = "reading";
                  timing.response = monotonicNow() - installedAt;
                  let clone: Response;
                  try { clone = Reflect.apply(nativeClone, response, []) as Response; }
                  catch { fail("clone-error"); return; }
                  let reading: Promise<ArrayBuffer>;
                  try { timing.read = monotonicNow() - installedAt; reading = Reflect.apply(nativeRead, clone, []) as Promise<ArrayBuffer>; }
                  catch { fail("read-error"); return; }
                  void reading.then(buffer => {
                    try {
                      if (failure !== null) return;
                      if (buffer.byteLength > maxBytes) { fail("oversize"); return; }
                      bytes = Array.from(new Uint8Array(buffer)); phase = "complete";
                      timing.terminal = monotonicNow() - installedAt; complete();
                    } catch { fail("observer-error"); }
                  }, () => fail("read-error")).catch(() => fail("observer-error"));
                } catch { fail("observer-error"); }
              }, () => fail("fetch-error"));
              void observed.catch(() => fail("observer-error"));
            } catch { fail("observer-error"); }
            return promise;
          };
          const port: NativeCataloguePort = Object.freeze({
            async read() {
              if (calls === 1 && failure === null && phase !== "complete") await done;
              return snapshot();
            },
            stop() {
              const value = snapshot();
              if (window.fetch === observedFetch) window.fetch = nativeFetch;
              const target = window as unknown as Record<string, unknown>;
              if (target[key] === port) delete target[key];
              return value;
            },
          });
          try {
            Object.defineProperty(window, key, { value: port, configurable: true });
            window.fetch = observedFetch;
          } catch { fail("observer-error"); }
        }, { url: CATALOGUE_URL, key, maxBytes: 512 });
      }
    },
    async text(label: keyof typeof pages) {
      const value = await pages[label].evaluate(async key => {
        const port = (window as unknown as Record<string, NativeCataloguePort | undefined>)[key];
        return port ? await port.read() : null;
      }, key);
      if (!value) throw new Error("Native catalogue observer is unavailable");
      remember(label, value);
      expect({ calls: value.calls, responses: value.responses, status: value.status,
        phase: value.phase, failure: value.failure }).toEqual({ calls: 1, responses: 1,
        status: 200, phase: "complete", failure: null });
      if (value.bytes === null) throw new Error("Native catalogue body is unavailable");
      const bytes = Buffer.from(value.bytes);
      expect(bytes).toEqual(Buffer.from(CATALOGUE));
      return bytes.toString("utf8");
    },
    async stop() {
      let failed = false;
      // Do not join a pending read during failure cleanup: the existing fixture
      // owns context closure. Successful body oracles already require completion.
      for (const label of ["run", "settings"] as const) {
        try {
          const value = await pages[label].evaluate(key => {
            const port = (window as unknown as Record<string, NativeCataloguePort | undefined>)[key];
            return port ? port.stop() : null;
          }, key);
          if (value) { remember(label, value); if (value.failure !== null) failed = true; }
          else { receipts[label] = { diagnosticUnavailable: true }; failed = true; }
        } catch { receipts[label] = { diagnosticUnavailable: true }; failed = true; }
      }
      if (failed) throw new Error("Native catalogue observation or cleanup failed");
    },
    receipt() { return receipts; },
  };
}

async function openDesktopDebug(page: Page) {
  await page.setViewportSize(DESKTOP);
  await page.getByRole("button", { name: "Debug", exact: true }).click();
  const pane = page.getByRole("complementary", { name: "Coding-agent debug chat" });
  await expect(pane).toBeVisible();
  const resize = page.getByRole("separator", { name: "Resize debug chat", exact: true });
  await resize.focus();
  // Mobile legitimately clamps the saved pane width. Restore a desktop
  // constraint through at most twelve actual keyboard resize actions.
  for (let step = 0; step < 12; step++) {
    const before = Number(await resize.getAttribute("aria-valuenow"));
    if (before >= 620) break;
    await resize.press("ArrowLeft");
    await expect.poll(async () => Number(await resize.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
  }
  await expect.poll(async () => Number(await resize.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(620);
  await expect.poll(async () => {
    const box = await pane.boundingBox(), stats = await page.locator(".rp-meta-metrics").boundingBox();
    return !!box && !!stats && box.width >= 620 && box.width <= 644 && box.x >= stats.x + stats.width - 1
      && box.x + box.width <= DESKTOP.width + 1 && stats.width > 200 && stats.width < 400;
  }).toBe(true);
  await test.info().attach("Desktop Debug numeric geometry", {
    body: JSON.stringify({
      viewport: page.viewportSize(),
      paneBox: await pane.boundingBox(),
      statsBox: await page.locator(".rp-meta-metrics").boundingBox(),
      separatorAriaValue: Number(await resize.getAttribute("aria-valuenow")),
    }),
    contentType: "application/json",
  });
}

async function collapseDebug(page: Page) {
  const pane = page.getByRole("complementary", { name: "Coding-agent debug chat" });
  await pane.getByRole("button", { name: "Hide chat", exact: true }).click();
  await expect(pane).toHaveCount(0);
}

async function physicalLayout(page: Page, runId: string) {
  return page.evaluate(runId => {
    // One CSS pixel tolerates subpixel font rounding. Rows come from shared
    // vertical intersection, independently of DOM adjacency or marker state.
    const tolerance = 1;
    const row = document.querySelector<HTMLElement>(".rp-meta-metrics")!;
    const container = row.getBoundingClientRect();
    const items = [...row.children].map((element, index) => {
      const box = element.getBoundingClientRect();
      return { index, element, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        width: box.width, height: box.height };
    }).filter(item => item.width > 0 && item.height > 0 && getComputedStyle(item.element).visibility !== "hidden");
    const rows: { top: number; bottom: number; indices: number[] }[] = [];
    for (const item of [...items].sort((a, b) => a.top - b.top || a.left - b.left)) {
      const physicalRow = rows.find(candidate => Math.min(candidate.bottom, item.bottom) - Math.max(candidate.top, item.top) > tolerance);
      if (physicalRow) { physicalRow.top = Math.max(physicalRow.top, item.top); physicalRow.bottom = Math.min(physicalRow.bottom, item.bottom); physicalRow.indices.push(item.index); }
      else rows.push({ top: item.top, bottom: item.bottom, indices: [item.index] });
    }
    const rightmost = new Set(rows.map(group => group.indices.reduce((last, index) =>
      items.find(item => item.index === index)!.right > items.find(item => item.index === last)!.right ? index : last)));
    const problems: string[] = [];
    for (const item of items) {
      if (item.element.hasAttribute("data-line-end") !== rightmost.has(item.index)) problems.push(`wrong line marker on Stat ${item.index}`);
      if (item.left < container.left - tolerance || item.right > container.right + tolerance) problems.push(`clipped Stat ${item.index}`);
      const text = document.createTreeWalker(item.element, NodeFilter.SHOW_TEXT);
      while (text.nextNode()) {
        if (!text.currentNode.textContent?.trim() || getComputedStyle(text.currentNode.parentElement!).visibility === "hidden") continue;
        const range = document.createRange(); range.selectNodeContents(text.currentNode);
        const bounds = range.getBoundingClientRect();
        if (bounds.width > 0 && (bounds.left < container.left - tolerance || bounds.right > container.right + tolerance)) problems.push(`clipped Stat text ${item.index}`);
      }
    }
    for (let index = 0; index < items.length; index++) for (const other of items.slice(index + 1)) {
      const item = items[index];
      if (Math.min(item.right, other.right) - Math.max(item.left, other.left) > tolerance
        && Math.min(item.bottom, other.bottom) - Math.max(item.top, other.top) > tolerance) problems.push("overlapping Stat controls");
    }
    const trace = document.querySelector<HTMLElement>(`.rp-meta-ids span[title="${runId}"]`);
    const ids = trace?.closest(".rp-meta-ids")?.getBoundingClientRect();
    if (!trace || !ids || trace.textContent !== runId) problems.push("missing exact trace identity");
    else {
      const range = document.createRange(); range.selectNodeContents(trace); const text = range.getBoundingClientRect();
      if (trace.scrollWidth > trace.clientWidth + tolerance || text.left < ids.left - tolerance || text.right > ids.right + tolerance) problems.push("clipped trace identity");
    }
    if (document.documentElement.scrollWidth > window.innerWidth + tolerance) problems.push("horizontal document overflow");
    return { problems, rowCount: rows.length, rows: rows.map(group => group.indices), contentWidth: container.width,
      marked: items.map(item => ({ index: item.index, lineEnd: item.element.hasAttribute("data-line-end"),
        text: item.element.textContent?.replace(/\s+/g, " ").trim() })) };
  }, runId);
}

async function checkLayout(page: Page, population: Population, state: State, desktop: boolean) {
  const stats = page.locator(".rp-meta-metrics"), triggers = stats.getByRole("button", { name: SUMMARY });
  await expect(stats).toBeVisible();
  if (population.rows.length === 0) {
    await expect(triggers).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Nominal cost estimates" })).toHaveCount(0);
    await expect(stats.locator(":scope > span")).toHaveCount(1);
    await expect(stats).not.toContainText("$0.00");
  } else {
    const label = state === "ready" ? population.ready! : "Estimate unavailable";
    await expect(triggers).toHaveCount(1);
    await expect(stats.getByRole("button", { name: label, exact: true })).toBeVisible();
    await expect(stats.locator(":scope > span").last().getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  if (population.name === "free zero") {
    await expect(stats.getByText("tokens", { exact: true })).toHaveCount(0);
    const duration = stats.getByText("duration", { exact: true }).locator("..");
    await expect(duration.locator(":scope > [data-separator]")).toHaveCount(1);
  }
  await expect.poll(() => headerSeparatorProblems(page)).toEqual([]);
  await expect.poll(async () => (await physicalLayout(page, population.runId)).problems).toEqual([]);
  const layout = await physicalLayout(page, population.runId);
  if (desktop && population.name === "mixed known and unavailable") expect(layout.rowCount).toBeGreaterThanOrEqual(2);
  const button = population.rows.length ? await triggers.boundingBox() : null;
  return { state, desktop, viewport: page.viewportSize(), labelWidth: button?.width ?? null, ...layout };
}

async function disclosure(page: Page, population: Population, state: State, activation: "keyboard" | "click" | "touch", outside = false) {
  const triggers = page.locator(".rp-meta-metrics").getByRole("button", { name: SUMMARY });
  if (!population.rows.length) { await expect(triggers).toHaveCount(0); return; }
  const label = state === "ready" ? population.ready! : "Estimate unavailable";
  const button = page.getByRole("button", { name: label, exact: true });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const target = (await button.boundingBox())!;
  expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44);
  if (activation === "keyboard") { await button.focus(); await page.keyboard.press("Enter"); }
  else if (activation === "touch") await button.tap();
  else await button.click();
  const region = page.getByRole("region", { name: "Nominal cost estimates", exact: true });
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(region).toBeVisible();
  const id = await region.getAttribute("id"); expect(id).toBeTruthy();
  await expect(button).toHaveAttribute("aria-controls", id!);
  await expect(region).toContainText("Reported cost stays separate.");
  await expect(region).toContainText("OpenRouter catalogue quotes");
  await expect(region.locator(":scope > div")).toHaveCount(population.rows.length + 1);
  for (const row of population.rows) {
    const model = row.model ?? "Model unavailable";
    const entry = region.getByText(model, { exact: true }).locator("..");
    await expect(entry).toBeVisible();
    const available = state === "ready" && row.model !== null && row.input !== null && row.output !== null && row.model !== "fixture/missing-price";
    if (available) {
      const free = row.model === "fixture/free";
      await expect(entry).toContainText(free ? "0 input @ $0/M" : "200 input @ $3/M");
      await expect(entry).toContainText(free ? "0 output @ $0/M" : "300 output @ $15/M");
      await expect(entry).toContainText(`Catalogue ID: ${row.model}`);
      await expect(entry).toContainText(REVISION);
      await expect(entry).toContainText(/Fetched: \d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    } else {
      const reason = row.model === null ? "Model identity was not captured."
        : row.input === null || row.output === null ? "Input or output token capture is unavailable."
        : state === "disabled" || state === "revoked" ? "Public pricing is disabled. Enable it in Settings."
        : state === "loading" ? "Public pricing is loading." : "No unambiguous exact catalogue price is available.";
      await expect(entry).toContainText(reason);
      await expect(entry).not.toContainText("Catalogue ID:");
      await expect(entry).not.toContainText("Revision:");
    }
  }
  if (population.ready === "Estimate unavailable") {
    await expect(triggers).not.toHaveAccessibleName(/^Estimated cost \$|^Known estimates \$/);
    await expect(region).not.toContainText("$0.00");
  }
  const viewport = page.viewportSize()!;
  await expect.poll(async () => {
    const box = await region.boundingBox();
    return !!box && box.x >= 16 && box.y >= 16 && box.x + box.width <= viewport.width - 16 + 1
      && box.y + box.height <= viewport.height - 16 + 1;
  }).toBe(true);
  expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  if (outside) await page.locator(".rp-meta-metrics").getByText("duration", { exact: true }).click();
  else await page.keyboard.press("Escape");
  await expect(region).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  if (!outside) await expect(button).toBeFocused();
}

for (const population of POPULATIONS) {
  test(`pricing populations: ${population.name} retain honest cost and physical row boundaries`, async ({ page, runPhantom }, testInfo) => {
    const settings = await page.context().newPage();
    const promptCanary = `population-layout-private-prompt-${population.name}`;
    const network = controlledNetwork({ run: page, settings }, new URL(runPhantom.url).origin, [population.runId, promptCanary]);
    const nativeBodies = nativeCatalogueBodies({ run: page, settings });
    const measurements: unknown[] = [];
    const cleanupErrors: Error[] = [];
    let primary: unknown, failed = false;
    try {
      await network.install();
      await nativeBodies.install();
      const original = await capture(runPhantom.url, population, promptCanary);
      const snapshot = await readSnapshot(runPhantom.url, population);
      if (population.reported !== null) expect(snapshot.metrics.costUsd).toBe(population.reported);
      const unchangedCapture = async () => {
        expect(capturedPricing(await readDetail(runPhantom.url, population))).toEqual(capturedPricing(original));
        const after = await readSnapshot(runPhantom.url, population);
        expect(after.metrics).toEqual(snapshot.metrics); expect(after.models).toEqual(snapshot.models);
      };
      const runUrl = `${runPhantom.url}/runs/${population.runId}`;
      await page.setViewportSize(DESKTOP);
      await page.goto(runUrl);
      await settings.goto(`${runPhantom.url}/settings`);
      const consent = settings.getByRole("checkbox", { name: /fetch public model pricing/i });
      await expect(consent).not.toBeChecked();
      network.verify(0, 0);
      await openDesktopDebug(page);
      measurements.push(await checkLayout(page, population, "disabled", true));
      await disclosure(page, population, "disabled", "click", true);
      await collapseDebug(page);
      for (const viewport of MOBILE) {
        await page.setViewportSize(viewport);
        await expect(page.getByRole("dialog", { name: "Coding-agent debug chat" })).toHaveCount(0);
        await disclosure(page, population, "disabled", "touch");
        measurements.push(await checkLayout(page, population, "disabled", false));
        await expect(page).toHaveURL(runUrl); network.verify(0, 0);
      }
      await openDesktopDebug(page);
      await consent.check();
      await expect.poll(() => [network.counts.run.requests, network.counts.settings.requests]).toEqual([1, 1]);
      network.verify(1, 0);
      await disclosure(page, population, "loading", "click");
      const loading = await checkLayout(page, population, "loading", true); measurements.push(loading);
      expect(network.heldMilliseconds()).toBeLessThan(20_000);
      const responses = Promise.all([page.waitForResponse(CATALOGUE_URL), settings.waitForResponse(CATALOGUE_URL)]);
      network.release();
      const catalogueResponses = await responses;
      for (const label of ["run", "settings"] as const) {
        const response = catalogueResponses[label === "run" ? 0 : 1];
        expect(response.status()).toBe(200); expect(await nativeBodies.text(label)).toBe(CATALOGUE);
      }
      await expect.poll(() => [network.counts.run.fulfilled, network.counts.settings.fulfilled]).toEqual([1, 1]);
      network.verify(1, 1);
      const ready = await checkLayout(page, population, "ready", true); measurements.push(ready);
      if (population.name === "mixed known and unavailable") expect(ready.labelWidth!).toBeGreaterThan(loading.labelWidth! + 1);
      await disclosure(page, population, "ready", "keyboard");
      await unchangedCapture();
      await page.screenshot({ path: testInfo.outputPath("population-ready-desktop-debug.png"), fullPage: true });
      await collapseDebug(page);
      for (const viewport of MOBILE) {
        await page.setViewportSize(viewport);
        await expect(page.getByRole("dialog", { name: "Coding-agent debug chat" })).toHaveCount(0);
        await disclosure(page, population, "ready", "touch");
        measurements.push(await checkLayout(page, population, "ready", false));
        if (viewport.width === 320) await page.screenshot({ path: testInfo.outputPath("population-ready-320.png"), fullPage: true });
        await expect(page).toHaveURL(runUrl); network.verify(1, 1);
      }
      await openDesktopDebug(page);
      await consent.uncheck();
      const revoked = await checkLayout(page, population, "revoked", true); measurements.push(revoked);
      if (population.name === "mixed known and unavailable") {
        expect(revoked.labelWidth!).toBeLessThan(ready.labelWidth! - 1);
        expect(Math.abs(revoked.labelWidth! - loading.labelWidth!)).toBeLessThanOrEqual(1);
      }
      await disclosure(page, population, "revoked", "click");
      await unchangedCapture();
      await collapseDebug(page);
      for (const viewport of MOBILE) {
        await page.setViewportSize(viewport);
        await expect(page.getByRole("dialog", { name: "Coding-agent debug chat" })).toHaveCount(0);
        await disclosure(page, population, "revoked", "touch");
        measurements.push(await checkLayout(page, population, "revoked", false));
        await expect(page).toHaveURL(runUrl); network.verify(1, 1);
      }
    } catch (error) { failed = true; primary = error; }
    finally {
      try { await nativeBodies.stop(); } catch { cleanupErrors.push(new Error("Native catalogue observation cleanup failed")); }
      try { await network.stop(); } catch { cleanupErrors.push(new Error("Population route cleanup or network contract failed")); }
      try {
        await testInfo.attach("Population layout and safe network observations", {
          body: JSON.stringify({ population: population.name, catalogueRevision: REVISION, network: network.receipt(),
            measurements, nativeCatalogue: nativeBodies.receipt(), cleanupErrors: cleanupErrors.length,
            runtime: "fixture-owned-source-daemon", catalogue: "controlled-synthetic" }),
          contentType: "application/json",
        });
      } catch { cleanupErrors.push(new Error("Population observation attachment failed")); }
    }
    if (failed) throw primary;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Population fixture cleanup failed");
  });
}
