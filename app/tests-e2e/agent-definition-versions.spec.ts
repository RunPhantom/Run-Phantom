import { createHash } from "node:crypto";
import type { APIRequestContext, CDPSession } from "@playwright/test";
import { test, expect } from "./fixtures";
import { agentDefinition, definitionTrace, definitionInput, definitionOutput, definitionKey } from "../../tests/fixtures/agent-definitions";
import type { RunComparison } from "../../src/run-comparison-protocol";

async function capturedPair(request: APIRequestContext, base: string, partial = false) {
  const baseline = definitionTrace(1701), candidate = definitionTrace(1702, agentDefinition(partial ? "[REDACTED]" : "Changed private instructions", .123456790));
  for (const capture of [baseline, candidate]) {
    expect((await request.post(base + "/v1/traces", { data: capture.body })).status()).toBe(200);
    const publicFile = await request.get(`${base}/api/runs/${capture.id}/export`); expect(publicFile.status()).toBe(200); const trace = await publicFile.json();
    expect(JSON.stringify(trace)).not.toContain("Private lookup description");
    // The existing comparison mount requires replay-source metadata. Obtain the
    // original private captured columns through its guarded local diagnostic
    // API, then import the exact observed spans with only this fixture link.
    const raw = await request.post(base + "/api/traces/query", { data: { sql: `SELECT id,attributes,otlp_evidence FROM spans WHERE run_id='${capture.id}'` } });
    expect(raw.status()).toBe(200); const rows = (await raw.json()).rows as Array<{ id: string; attributes: string; otlp_evidence: string }>;
    for (const span of trace.spans) {
      const original = rows.find(row => row.id === span.id)!; expect(original).toBeDefined(); span.attributes = original.attributes; span.otlp_evidence = original.otlp_evidence;
      expect(span.input_payload).toBe(definitionInput); expect(span.output_payload).toBe(definitionOutput);
    }
    if (capture === candidate) trace.run.metadata = JSON.stringify({ replay: { sourceRunId: baseline.id, mode: "local" } });
    expect((await request.post(base + "/api/import-run", { data: trace })).status()).toBe(200);
  }
  const response = await request.get(`${base}/api/runs/compare?baseline=${baseline.id}&candidate=${candidate.id}`); expect(response.status()).toBe(200);
  const comparison = await response.json() as RunComparison; expect(comparison.agentDefinitions?.baseline?.records[0].complete).toBe(true);
  return { baseline, candidate, comparison };
}

for (const width of [1440, 390, 320]) test(`actual captured definition hashes, original output and keyboard details remain usable at ${width}px`, async ({ page, request, runPhantom }, testInfo) => {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); await page.emulateMedia({ reducedMotion: "reduce" });
  const { baseline, candidate, comparison: original } = await capturedPair(request, runPhantom.url);
  expect(original.counts).toMatchObject({ paired: 1, changed: 0, unchanged: 1 }); expect(original.agentDefinitions?.candidate?.records[0].complete).toBe(true);
  await page.goto(`${runPhantom.url}/runs/${candidate.id}?debugCompare=1`);
  const comparison = page.getByRole("region", { name: "Captured run comparison" }); await expect(comparison.locator('[data-comparison-count="unchanged"]')).toHaveText("1");
  await page.screenshot({ path: testInfo.outputPath(`definition-before-${width}.png`), fullPage: true });
  const definitions = comparison.getByRole("region", { name: "Captured agent definitions" }); await expect(definitions).toBeVisible();
  await expect(definitions.getByRole("heading", { name: "Captured definitions" })).toBeVisible(); await expect(definitions).toContainText("Captured configuration changed");
  const candidateRecord = definitions.locator('[data-definition-side="candidate"] [data-definition-record]'), control = candidateRecord.locator("summary");
  await control.focus(); await control.press("Enter"); await expect(candidateRecord).toHaveAttribute("open", "");
  const firstHash = original.agentDefinitions!.candidate!.records[0].sha256!;
  await expect(candidateRecord.locator('[data-definition-hash="version"]')).toHaveText(firstHash);
  await expect(candidateRecord.locator('[data-definition-hash="prompt"]')).toHaveText(createHash("sha256").update("Changed private instructions").digest("hex"));
  await expect(definitions).toContainText("Prompt, Runtime"); expect(await definitions.textContent()).not.toContain("Private lookup description"); expect(await definitions.textContent()).not.toContain("Changed private instructions");
  await page.evaluate(async () => { await document.fonts.load('600 18px "Syne"'); await document.fonts.load('400 14px "Inter Variable"'); await document.fonts.ready; });
  const visual = await definitions.evaluate(element => {
    const title = element.querySelector("h3")!, summary = element.querySelector('[data-definition-side="candidate"] summary')!;
    return { color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, headingFont: getComputedStyle(title).fontFamily,
      bodyFont: getComputedStyle(element).fontFamily, fonts: [...document.fonts].filter(face => face.status === "loaded").map(face => face.family), summaryHeight: summary.getBoundingClientRect().height,
      focusColor: getComputedStyle(summary).outlineColor, focusWidth: getComputedStyle(summary).outlineWidth, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(visual.color).toBe("rgb(14, 18, 27)"); expect(visual.background).toBe("rgb(249, 250, 252)"); expect(visual.headingFont).toContain("Syne"); expect(visual.bodyFont).toContain("Inter");
  expect(visual.fonts.some(font => font.includes("Syne"))).toBe(true); expect(visual.fonts.some(font => font.includes("Inter"))).toBe(true); expect(visual.summaryHeight).toBeGreaterThanOrEqual(44);
  expect(visual.focusColor).toBe("rgb(0, 33, 204)"); expect(visual.focusWidth).toBe("2px"); expect(visual.overflow).toBe(false);
  await testInfo.attach("actual-definition-visual.json", { body: JSON.stringify(visual, null, 2), contentType: "application/json" });
  await control.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`definition-focus-${width}.png`), fullPage: true });
  const link = candidateRecord.getByRole("link", { name: "Open candidate definition source span in a new tab" });
  await control.press("Tab"); await expect(link).toBeFocused(); await expect(link).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`definition-source-link-${width}.png`), fullPage: true });
  const [detail] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  try {
    await expect(detail).toHaveURL(new RegExp(`/runs/${candidate.id}/span/${candidate.spanId}$`)); await expect(detail.locator(`[data-span-row="${candidate.spanId}"]`)).toBeVisible();
    await expect(detail.getByText(definitionInput, { exact: true }).first()).toBeVisible();
    await expect(detail.getByText(definitionOutput, { exact: true }).first()).toBeVisible();
  } finally { await detail.close(); }
  const correction = definitionTrace(1702, agentDefinition("Late exact captured correction", .123456791)); expect((await request.post(runPhantom.url + "/v1/traces", { data: correction.body })).status()).toBe(200);
  const updated = await request.get(`${runPhantom.url}/api/runs/compare?baseline=${baseline.id}&candidate=${candidate.id}`); const current = await updated.json() as RunComparison;
  expect(current.agentDefinitions?.candidate?.records[0].sha256).not.toBe(firstHash); expect(current.counts).toEqual(original.counts);
  await comparison.getByRole("button", { name: "Refresh comparison", exact: true }).click(); await expect(candidateRecord.locator('[data-definition-hash="version"]')).toHaveText(current.agentDefinitions!.candidate!.records[0].sha256!);
  await page.reload(); await expect(definitions).toContainText("Captured configuration changed"); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await definitions.getByRole("heading", { name: "Captured definitions" }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`definition-current-${width}.png`), fullPage: true });
});

test.describe("actual touch definition navigation", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("coarse pointer can tap, scroll the local definition viewport and open unchanged captured output", async ({ page, request, runPhantom }, testInfo) => {
    const { candidate, comparison: original } = await capturedPair(request, runPhantom.url);
    await page.goto(`${runPhantom.url}/runs/${candidate.id}?debugCompare=1`);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const comparison = page.getByRole("region", { name: "Captured run comparison" }), definitions = comparison.getByRole("region", { name: "Captured agent definitions" });
    const record = definitions.locator('[data-definition-side="candidate"] [data-definition-record]'), summary = record.locator("summary");
    await summary.tap(); await expect(record).toHaveAttribute("open", ""); expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(record.locator('[data-definition-hash="version"]')).toHaveText(original.agentDefinitions!.candidate!.records[0].sha256!);
    const before = await comparison.evaluate(element => element.scrollTop);
    const observation = await comparison.evaluateHandle(element => {
      const source = element.querySelector<HTMLAnchorElement>('[aria-label="Open candidate definition source span in a new tab"]');
      if (!source) throw new Error("Captured source link is missing");
      const geometry = () => {
        const box = element.getBoundingClientRect(), link = source.getBoundingClientRect();
        const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2, startY = Math.min(innerHeight, box.bottom) - 24;
        // Reserve extra interior space for the whole native touch contact.
        const distance = Math.min(1000 / 3, startY - Math.max(0, box.top) - 48), cx = link.x + link.width / 2, cy = link.y + link.height / 2;
        return { x, startY, distance, scrollTop: element.scrollTop, maximum: element.scrollHeight - element.clientHeight,
          startInside: element.contains(document.elementFromPoint(x, startY)), endInside: element.contains(document.elementFromPoint(x, startY - distance)),
          linkUsable: link.height > 0 && cx >= Math.max(0, box.left) && cx < Math.min(innerWidth, box.right)
            && cy >= Math.max(0, box.top) && cy < Math.min(innerHeight, box.bottom) && source.contains(document.elementFromPoint(cx, cy)) };
      };
      type Input = { sequence: number; at: number; type: string; trusted: boolean; defaultPrevented: boolean; x: number | null; y: number | null;
        inside: boolean; targetInsideAnchor: boolean; hitInsideAnchor: boolean; userActivation: { isActive: boolean; hasBeenActive: boolean } };
      type Scroll = { sequence: number; at: number; type: string; trusted: boolean; scrollTop: number };
      type Frame = { generation: number; at: number; phase: "hold" | "quiet"; scrollTop: number; scrollSequence: number; moveSequence: number };
      type Contact = { generation: number; armedAt: number; geometry: ReturnType<typeof geometry>; touch: Input[]; scroll: Scroll[];
        endpoint: { x: number; y: number; tolerance: number }; movesAcknowledgedAt: number | null; movesGeneration: number | null;
        holdOrigin: number | null; hold: { startedAt: number; completedAt: number; moveSequence: number } | null;
        releasePreparedAt: number | null; releaseAcknowledgedAt: number | null; releaseGeneration: number | null;
        frames: Frame[]; quiet: Frame[]; failure: string | null };
      function contactOpen(contact: Contact | undefined): boolean {
        return !!contact && !contact.touch.some(event => ["touchend", "touchcancel"].includes(event.type));
      }
      function endpointOrigin(contact: Contact | undefined, generation: number): number | null {
        if (!contact || !Number.isFinite(contact.armedAt) || !Number.isInteger(generation) || generation < 1 || contact.generation !== generation
          || contact.movesGeneration !== generation || contact.movesAcknowledgedAt === null || !Number.isFinite(contact.movesAcknowledgedAt)
          || contact.movesAcknowledgedAt < contact.armedAt) return null;
        const geometry = contact.geometry, endpoint = contact.endpoint, start = contact.touch[0];
        const move = contact.touch.filter(event => event.type === "touchmove").at(-1);
        if (!endpoint || !Number.isFinite(geometry.x) || !Number.isFinite(geometry.startY) || !Number.isFinite(geometry.distance) || geometry.distance <= 0
          || endpoint.x !== geometry.x || endpoint.y !== geometry.startY - geometry.distance || !Number.isFinite(endpoint.y)
          || !Number.isFinite(endpoint.tolerance) || endpoint.tolerance <= 0 || endpoint.tolerance > Math.min(0.25, geometry.distance / 48)
          || endpoint.tolerance >= geometry.distance / 12 || !start || start.type !== "touchstart" || start.at < contact.armedAt || !move
          || contact.touch.some((event, index) => !event.trusted || event.defaultPrevented || !event.inside || !Number.isFinite(event.at)
            || !Number.isFinite(event.sequence) || (index > 0 && (event.sequence <= contact.touch[index - 1].sequence || event.at < contact.touch[index - 1].at
              || (event.type !== "touchmove" && !(index === contact.touch.length - 1 && ["touchend", "touchcancel"].includes(event.type))))))
          || move.x === null || move.y === null || !Number.isFinite(move.x) || !Number.isFinite(move.y)
          || Math.abs(move.x - endpoint.x) > endpoint.tolerance || Math.abs(move.y - endpoint.y) > endpoint.tolerance) return null;
        return Math.max(contact.movesAcknowledgedAt, move.at);
      }
      function stationaryHoldReady(contact: Contact | undefined, generation: number): boolean {
        const origin = endpointOrigin(contact, generation), hold = contact?.hold;
        if (!contact || origin === null || !hold) return false;
        const move = contact.touch.filter(event => event.type === "touchmove").at(-1)!, terminal = contact.touch.at(-1)!;
        return Number.isFinite(hold.startedAt) && Number.isFinite(hold.completedAt) && hold.startedAt === origin && hold.startedAt === contact.holdOrigin
          && hold.completedAt - hold.startedAt >= 100 && hold.moveSequence === move.sequence
          && (contactOpen(contact) || (contact.releasePreparedAt !== null && Number.isFinite(contact.releasePreparedAt)
            && terminal.at >= hold.completedAt && terminal.at >= contact.releasePreparedAt))
          && contact.frames.some(frame => frame.phase === "hold" && frame.generation === generation && frame.at === hold.completedAt
            && frame.moveSequence === hold.moveSequence);
      }
      function panReadiness(contact: Contact | undefined, generation: number, liveScrollTop: number | null): string[] {
        if (!contact) return ["contact"];
        const missing: string[] = [], start = contact.touch[0], terminal = contact.touch.at(-1), moves = contact.touch.slice(1, -1);
        const lastMove = contact.touch.filter(event => event.type === "touchmove").at(-1);
        const lastScroll = contact.scroll.filter(event => event.type === "scroll").at(-1)?.sequence ?? 0;
        if (!Number.isInteger(generation) || contact.generation !== generation || generation < 1) missing.push("generation");
        if (!start || start.type !== "touchstart" || !terminal || !["touchend", "touchcancel"].includes(terminal.type)
          || !moves.every(event => event.type === "touchmove") || contact.touch.some((event, index) => !Number.isFinite(event.at) || !Number.isFinite(event.sequence)
            || (index > 0 && (event.sequence <= contact.touch[index - 1].sequence || event.at < contact.touch[index - 1].at)))) missing.push("contact-order");
        if (!moves.some(event => event.type === "touchmove")) missing.push("actual-moves");
        if (!contact.touch.every(event => event.trusted)) missing.push("trusted-contact");
        if (!contact.touch.every(event => !event.defaultPrevented)) missing.push("unprevented-contact");
        if (!contact.touch.every(event => event.inside)) missing.push("inside-contact");
        if (!start || !contact.scroll.some(event => event.type === "scroll" && event.trusted && event.sequence > start.sequence)) missing.push("trusted-scroll");
        if (liveScrollTop === null || !Number.isFinite(liveScrollTop) || !Number.isFinite(contact.geometry.scrollTop) || !(liveScrollTop > contact.geometry.scrollTop)) missing.push("offset-progress");
        if (endpointOrigin(contact, generation) === null) missing.push("final-endpoint");
        if (!stationaryHoldReady(contact, generation) || contact.releasePreparedAt === null
          || contact.releasePreparedAt < contact.hold!.completedAt) missing.push("stationary-hold");
        if (contact.releaseAcknowledgedAt === null || !Number.isFinite(contact.releaseAcknowledgedAt) || contact.releaseGeneration !== generation
          || contact.releasePreparedAt === null || !Number.isFinite(contact.releasePreparedAt)
          || contact.releaseAcknowledgedAt < contact.releasePreparedAt) missing.push("release-acknowledgment");
        const quiet = contact.quiet, first = quiet[0], last = quiet.at(-1);
        if (!first || !last || quiet.length < 3 || last.at - first.at < 100 || contact.releaseAcknowledgedAt === null || !terminal
          || !quiet.every((frame, index) => frame.phase === "quiet" && frame.generation === generation && Number.isFinite(frame.at)
            && frame.at >= contact.releaseAcknowledgedAt! && frame.at >= terminal.at && (index === 0 || frame.at > quiet[index - 1].at)
            && frame.scrollTop === liveScrollTop && frame.scrollSequence === lastScroll && frame.moveSequence === (lastMove?.sequence ?? 0))) missing.push("observed-quiet");
        if (!Number.isFinite(contact.armedAt) || (last && last.at - contact.armedAt >= 5000)) missing.push("completion-budget");
        if (contact.failure !== null) missing.push("observer-failure");
        return missing;
      }
      const contacts: Contact[] = [], activation: Input[] = [], activationScroll: Scroll[] = [], unassignedScroll: Scroll[] = [];
      let sequence = 0, activationArmedAt: number | null = null, activationGeometry: ReturnType<typeof geometry> | null = null;
      let disposed = false, frameHandle: number | null = null, deadlineHandle: number | null = null;
      type Waiter = { generation: number; phase: Frame["phase"]; resolve: () => void; reject: (error: Error) => void };
      let waiter: Waiter | null = null;
      const settle = (error?: Error, complete = false) => {
        if (frameHandle !== null) cancelAnimationFrame(frameHandle); frameHandle = null;
        if ((error || complete) && deadlineHandle !== null) { clearTimeout(deadlineHandle); deadlineHandle = null; }
        const pending = waiter; waiter = null;
        if (error) pending?.reject(error); else pending?.resolve();
      };
      const fail = (message: string) => { if (contacts.at(-1)) contacts.at(-1)!.failure = message; settle(new Error(message)); };
      const current = (generation: number) => {
        const contact = contacts.at(-1);
        if (disposed || !contact || contact.generation !== generation) throw new Error("Unexpected native contact generation");
        if (contact.failure) throw new Error(contact.failure);
        if (deadlineHandle !== null && performance.now() - contact.armedAt >= 5000) {
          fail("Current native comparison pan exceeded its completion budget"); throw new Error(contact.failure!);
        }
        return contact;
      };
      const sampleFrame = (pending: Waiter) => {
        if (disposed || waiter !== pending) return;
        frameHandle = null;
        const contact = contacts.at(-1);
        if (!contact || contact.generation !== pending.generation) { fail("Stale native contact frame"); return; }
        if (performance.now() - contact.armedAt >= 5000) { fail("Current native comparison pan exceeded its completion budget"); return; }
        if (pending.phase === "hold" && !contactOpen(contact)) { fail("Native touch terminal arrived before stationary release preparation"); return; }
        const frame: Frame = { generation: contact.generation, at: performance.now(), phase: pending.phase, scrollTop: element.scrollTop,
          scrollSequence: contact.scroll.filter(event => event.type === "scroll").at(-1)?.sequence ?? 0,
          moveSequence: contact.touch.filter(event => event.type === "touchmove").at(-1)?.sequence ?? 0 };
        contact.frames.push(frame);
        if (pending.phase === "hold") {
          contact.holdOrigin = endpointOrigin(contact, pending.generation);
          if (contact.holdOrigin !== null && frame.at - contact.holdOrigin >= 100) {
            contact.hold = { startedAt: contact.holdOrigin, completedAt: frame.at, moveSequence: frame.moveSequence }; settle(); return;
          }
        } else {
          const terminal = contact.touch.at(-1), previous = contact.quiet.at(-1);
          if (!terminal || !["touchend", "touchcancel"].includes(terminal.type)) contact.quiet = [];
          else {
            if (previous && (previous.scrollTop !== frame.scrollTop || previous.scrollSequence !== frame.scrollSequence
              || previous.moveSequence !== frame.moveSequence)) contact.quiet = [];
            contact.quiet.push(frame);
            if (panReadiness(contact, pending.generation, element.scrollTop).length === 0) { settle(undefined, true); return; }
          }
        }
        if (!disposed && waiter === pending) frameHandle = requestAnimationFrame(() => sampleFrame(pending));
      };
      const waitFor = (generation: number, phase: Frame["phase"]) => {
        const contact = current(generation);
        if (waiter || (phase === "hold" ? contact.movesAcknowledgedAt === null : contact.releaseAcknowledgedAt === null)) throw new Error("Unexpected native contact phase");
        return new Promise<void>((resolve, reject) => {
          const pending: Waiter = { generation, phase, resolve, reject }; waiter = pending;
          frameHandle = requestAnimationFrame(() => sampleFrame(pending));
        });
      };
      const types = ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointerup", "pointercancel", "click"] as const;
      const input = (event: Event) => {
        if (disposed) return;
        const target = event.target as Node | null;
        if (!target || !element.contains(target) || (activationArmedAt !== null && !source.contains(target))) return;
        const point = event instanceof TouchEvent ? event.changedTouches[0] ?? event.touches[0] : event instanceof MouseEvent ? event : null;
        const sample: Input = { sequence: ++sequence, at: performance.now(), type: event.type, trusted: event.isTrusted, defaultPrevented: event.defaultPrevented,
          x: point?.clientX ?? null, y: point?.clientY ?? null, inside: !!point && element.contains(document.elementFromPoint(point.clientX, point.clientY)),
          targetInsideAnchor: source.contains(target), hitInsideAnchor: !!point && source.contains(document.elementFromPoint(point.clientX, point.clientY)),
          userActivation: { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive } };
        if (activationArmedAt !== null) activation.push(sample);
        else if (event instanceof TouchEvent) {
          const contact = contacts.at(-1); contact?.touch.push(sample);
          if (contact && event.type === "touchmove") {
            contact.hold = null; contact.quiet = [];
            if (contact.releasePreparedAt !== null) fail("Native touchmove invalidated the prepared stationary release");
            else contact.holdOrigin = endpointOrigin(contact, contact.generation);
          } else if (contact && !contactOpen(contact) && contact.releasePreparedAt === null) fail("Native touch terminal arrived before stationary release preparation");
        }
      };
      const scroll = (event: Event) => {
        if (disposed || event.target !== element) return;
        const sample: Scroll = { sequence: ++sequence, at: performance.now(), type: event.type, trusted: event.isTrusted, scrollTop: element.scrollTop };
        if (activationArmedAt !== null) activationScroll.push(sample);
        else {
          const contact = contacts.at(-1); (contact?.scroll ?? unassignedScroll).push(sample);
          if (contact && event.type === "scroll") contact.quiet = [];
        }
      };
      for (const type of types) window.addEventListener(type, input, { passive: true });
      element.addEventListener("scroll", scroll, { passive: true }); element.addEventListener("scrollend", scroll, { passive: true });
      return { geometry,
        begin: () => {
          if (disposed || waiter || (contacts.length > 0 && panReadiness(contacts.at(-1), contacts.length, element.scrollTop).length > 0)) throw new Error("Previous native pan is not ready");
          const initial = geometry();
          const contact: Contact = { generation: contacts.length + 1, armedAt: performance.now(), geometry: initial, touch: [], scroll: [],
            endpoint: { x: initial.x, y: initial.startY - initial.distance, tolerance: Math.min(0.25, initial.distance / 48) },
            movesAcknowledgedAt: null, movesGeneration: null, holdOrigin: null, hold: null, releasePreparedAt: null, releaseAcknowledgedAt: null, releaseGeneration: null,
            frames: [], quiet: [], failure: null };
          contacts.push(contact);
          // One existing 5s completion budget covers motion, stationary contact and observed quietness.
          deadlineHandle = window.setTimeout(() => {
            if (!disposed && contacts.at(-1) === contact && deadlineHandle !== null) fail("Current native comparison pan exceeded its completion budget");
          }, 5000);
          return { generation: contact.generation, ...contact.geometry };
        },
        moved: (generation: number) => {
          const contact = current(generation);
          if (contact.movesAcknowledgedAt !== null) throw new Error("Duplicate native movement acknowledgment");
          contact.movesAcknowledgedAt = performance.now(); contact.movesGeneration = generation;
          contact.holdOrigin = endpointOrigin(contact, generation);
        },
        stationary: (generation: number) => waitFor(generation, "hold"),
        prepareRelease: (generation: number) => {
          const contact = current(generation);
          if (!contactOpen(contact) || !stationaryHoldReady(contact, generation) || contact.releasePreparedAt !== null) throw new Error("Native stationary hold lacks actual movement or was invalidated");
          contact.releasePreparedAt = performance.now();
        },
        released: (generation: number) => {
          const contact = current(generation);
          if (contact.releasePreparedAt === null || contact.releaseAcknowledgedAt !== null) throw new Error("Unexpected native release acknowledgment");
          contact.releaseAcknowledgedAt = performance.now(); contact.releaseGeneration = generation;
        },
        waitForCompletion: (generation: number) => waitFor(generation, "quiet"),
        completed: () => panReadiness(contacts.at(-1), contacts.length, element.scrollTop).length === 0,
        current: () => ({ contact: contacts.at(-1)!, scrollTop: element.scrollTop }),
        activate: () => {
          activationGeometry = geometry();
          if (panReadiness(contacts.at(-1), contacts.length, element.scrollTop).length > 0 || !activationGeometry.linkUsable) throw new Error("Native pan readiness or source hit target changed before activation");
          activationArmedAt = performance.now(); return activationGeometry;
        },
        activation: () => ({ events: activation, scroll: activationScroll }),
        finish: () => {
          disposed = true; settle(new Error("Native touch observation disposed"));
          for (const type of types) window.removeEventListener(type, input);
          element.removeEventListener("scroll", scroll); element.removeEventListener("scrollend", scroll);
          return { contacts, unassignedScroll, finalScrollTop: element.scrollTop,
            readiness: { generation: contacts.length, missing: panReadiness(contacts.at(-1), contacts.length, element.scrollTop) },
            sampler: { disposed, framePending: frameHandle !== null, deadlinePending: deadlineHandle !== null, waiterPending: waiter !== null },
            activation: { armedAt: activationArmedAt, geometry: activationGeometry, events: activation, scroll: activationScroll } };
        } };
    });
    let touch: CDPSession | undefined, failed = false, touchContactActive = false;
    const cleanupErrors: unknown[] = [];
    try {
      touch = await page.context().newCDPSession(page);
      let panCount = 0;
      for (let swipe = 0; swipe < 3; swipe++) {
        const next = await observation.evaluate(value => value.geometry());
        if (swipe > 0 && (next.linkUsable || next.scrollTop >= next.maximum)) break;
        const gesture = await observation.evaluate(value => value.begin());
        expect(gesture.linkUsable).toBe(false); expect(gesture.maximum).toBeGreaterThan(gesture.scrollTop);
        expect(gesture.distance).toBeGreaterThan(0); expect(gesture.startInside).toBe(true); expect(gesture.endInside).toBe(true);
        touchContactActive = true;
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: gesture.x, y: gesture.startY, id: 0 }] });
        for (let step = 1; step <= 12; step++) await touch.send("Input.dispatchTouchEvent", { type: "touchMove",
          touchPoints: [{ x: gesture.x, y: gesture.startY - gesture.distance * step / 12, id: 0 }] });
        await observation.evaluate((value, generation) => value.moved(generation), gesture.generation);
        await observation.evaluate((value, generation) => value.stationary(generation), gesture.generation);
        await observation.evaluate((value, generation) => value.prepareRelease(generation), gesture.generation);
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); touchContactActive = false;
        await observation.evaluate((value, generation) => value.released(generation), gesture.generation);
        await observation.evaluate((value, generation) => value.waitForCompletion(generation), gesture.generation);
        expect(await observation.evaluate(value => value.completed()), "Current native comparison pan must complete").toBe(true);
        const completed = await observation.evaluate(value => value.current()), delivered = completed.contact.touch;
        expect(delivered.filter(event => event.type === "touchstart")).toHaveLength(1); expect(delivered.filter(event => event.type === "touchmove").length).toBeGreaterThan(0);
        expect(delivered.filter(event => event.type !== "touchmove").map(event => event.type === "touchstart" ? "start" : "terminal")).toEqual(["start", "terminal"]);
        expect(delivered.every(event => event.trusted && event.inside && !event.defaultPrevented)).toBe(true);
        expect(completed.scrollTop).toBeGreaterThan(gesture.scrollTop); panCount++;
      }
      expect(panCount).toBeGreaterThanOrEqual(1); expect(panCount).toBeLessThanOrEqual(3);
      await touch.detach(); touch = undefined;
      expect((await observation.evaluate(value => value.geometry())).linkUsable).toBe(true);
      await expect.poll(() => comparison.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
      const link = record.getByRole("link", { name: "Open candidate definition source span in a new tab" }); await expect(link).toBeVisible();
      const target = (await link.boundingBox())!; expect(target.height).toBeGreaterThanOrEqual(44);
      expect(await link.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath("definition-touch-local-scroll.png"), fullPage: true });
      expect(await observation.evaluate(value => value.completed())).toBe(true);
      expect((await observation.evaluate(value => value.activate())).linkUsable).toBe(true);
      const [detail] = await Promise.all([page.waitForEvent("popup"), link.tap()]);
      try { await expect(detail).toHaveURL(new RegExp(`/runs/${candidate.id}/span/${candidate.spanId}$`)); await expect(detail.getByText(definitionInput, { exact: true }).first()).toBeVisible(); await expect(detail.getByText(definitionOutput, { exact: true }).first()).toBeVisible(); }
      finally { await detail.close(); }
      const activation = await observation.evaluate(value => value.activation()), clicks = activation.events.filter(event => event.type === "click");
      expect(clicks).toHaveLength(1); expect(clicks[0]).toMatchObject({ trusted: true, defaultPrevented: false, targetInsideAnchor: true, hitInsideAnchor: true });
      expect(activation.scroll.filter(event => event.type === "scroll")).toHaveLength(0);
      await testInfo.attach("actual-touch-receipt.json", { body: JSON.stringify({ pointer: "coarse", beforeScroll: before, afterScroll: await comparison.evaluate(element => element.scrollTop), sourceTargetHeight: target.height, originalOutputVerified: true }), contentType: "application/json" });
    } catch (error) { failed = true; throw error; }
    finally {
      try { const receipt = await observation.evaluate(value => value.finish());
        await testInfo.attach("actual-touch-gesture-receipt.json", { body: JSON.stringify({ beforeScroll: before, ...receipt }, null, 2), contentType: "application/json" });
      } catch (error) { cleanupErrors.push(error); }
      try { if (touchContactActive) await touch?.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }); } catch (error) { cleanupErrors.push(error); }
      try { await touch?.detach(); } catch (error) { cleanupErrors.push(error); }
      try { await observation.dispose(); } catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) {
        await testInfo.attach("actual-touch-cleanup-errors.json", { body: JSON.stringify(cleanupErrors.map(String)), contentType: "application/json" }).catch(() => undefined);
      }
    }
    if (cleanupErrors.length && !failed) throw cleanupErrors[0];
  });
});

test("actual partial capture cannot show a complete definition version or hide unchanged output", async ({ page, request, runPhantom }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); const { candidate, comparison: original } = await capturedPair(request, runPhantom.url, true);
  expect(original.agentDefinitions?.candidate?.records[0].sha256).toBeNull(); expect(original.counts.changed).toBe(0);
  await testInfo.attach("actual-partial-comparison.json", { body: JSON.stringify(original, null, 2), contentType: "application/json" });
  await page.goto(`${runPhantom.url}/runs/${candidate.id}?debugCompare=1`); const definitions = page.getByRole("region", { name: "Captured agent definitions" }); await expect(definitions).toBeVisible();
  await expect(definitions).toContainText("Complete configuration comparison unavailable");
  await expect(definitions.locator('[data-definition-side="baseline"]')).toContainText("Complete capture");
  const record = definitions.locator('[data-definition-side="candidate"] [data-definition-record]'); await record.locator("summary").click();
  await expect(record).toContainText("Partial capture"); await expect(record.locator('[data-definition-hash="version"]')).toHaveText("Unavailable"); await expect(record).toContainText("Capture redacted");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await record.locator("summary").scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("definition-partial-mobile.png"), fullPage: true });
});


test("actual nested definition stays private in expanded source details while safe business output survives reload", async ({ page, request, runPhantom }, testInfo) => {
  const capture = definitionTrace(1773), privatePrompt = "F17 synthetic nested private UI instruction", business = "F17 safe business carrier unchanged";
  const stringBusiness = JSON.stringify({ [definitionKey]: "Ordinary typed business string stays exact" });
  capture.body.resourceSpans[0].scopeSpans[0].spans[0].attributes.push({ key: "ai.settings.fixture", value: { kvlistValue: { values: [
    { key: "business", value: { stringValue: business } },
    { key: definitionKey, value: { stringValue: JSON.stringify(agentDefinition(privatePrompt)) } },
  ] } } } as any, { key: "ordinary.string", value: { stringValue: stringBusiness } });
  expect((await request.post(runPhantom.url + "/v1/traces", { data: capture.body })).status()).toBe(200);
  for (const route of [`/api/runs/detail/${capture.id}`, `/api/runs/${capture.id}/export`]) {
    const response = await request.get(runPhantom.url + route); expect(response.status()).toBe(200); const observed = await response.json();
    expect(JSON.stringify(observed)).not.toContain(privatePrompt); const span = observed.spans[0], flat = JSON.parse(span.attributes);
    expect(JSON.parse(flat["ai.settings.fixture"])).toEqual({ business, [definitionKey]: "[REDACTED]" });
    expect(flat["ordinary.string"]).toBe(stringBusiness); expect(span.input_payload).toBe(definitionInput); expect(span.output_payload).toBe(definitionOutput);
  }
  const searched = await request.get(`${runPhantom.url}/api/runs/${capture.id}/search?scope=span_attributes&pattern=${encodeURIComponent(privatePrompt)}`);
  expect(searched.status()).toBe(200); expect((await searched.json()).matches).toEqual([]);
  const raw = await request.post(runPhantom.url + "/api/traces/query", { data: { sql: `SELECT attributes,otlp_evidence FROM spans WHERE run_id='${capture.id}'` } });
  expect(raw.status()).toBe(200); expect(JSON.stringify(await raw.json())).toContain(privatePrompt);
  await page.goto(`${runPhantom.url}/runs/${capture.id}/span/${capture.spanId}`);
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(page.locator(`[data-span-row="${capture.spanId}"]`)).toBeVisible();
    const options = page.getByRole("button", { name: /Provider Options \(Local-fixture\)/ }); await expect(options).toBeVisible(); await options.click();
    await expect(page.getByText(JSON.stringify(business), { exact: true })).toBeVisible(); await expect(page.getByText(JSON.stringify("[REDACTED]"), { exact: true })).toBeVisible();
    await expect(page.getByText(definitionInput, { exact: true }).first()).toBeVisible(); await expect(page.getByText(definitionOutput, { exact: true }).first()).toBeVisible();
    expect(await page.locator("body").textContent()).not.toContain(privatePrompt);
  }
  await page.screenshot({ path: testInfo.outputPath("definition-nested-public-details.png"), fullPage: true });
  await testInfo.attach("actual-nested-public-ui.json", { body: JSON.stringify({ source: "Actual JSON OTLP ingress, source daemon and Chromium UI", publicProjectionWithheld: true,
    privateDiagnosticRetention: true, genuineTypedBusinessStringExact: true, originalInputOutputEqual: true, expandedSafeSiblingVisibleAfterReload: true }), contentType: "application/json" });
});


test("actual escaped portable carrier is visibly unavailable after reload with original private capture retained", async ({ page, request, runPhantom }, testInfo) => {
  const capture = definitionTrace(1774), marker = "F17 tracked escaped private UI instruction", safe = "Safe business outside the uncertain carrier";
  const span = capture.body.resourceSpans[0].scopeSpans[0].spans[0]; span.attributes = span.attributes.filter(entry => entry.key !== definitionKey);
  span.attributes.push({ key: "ai.settings.fixture", value: { kvlistValue: { values: [
    { key: "business", value: { stringValue: "Safe original carrier sibling" } }, { key: definitionKey, value: { stringValue: marker } },
  ] } } } as any, { key: "ai.settings.safe", value: { stringValue: safe } });
  expect((await request.post(runPhantom.url + "/v1/traces", { data: capture.body })).status()).toBe(200);
  const exported = await request.get(`${runPhantom.url}/api/runs/${capture.id}/export`); expect(exported.status()).toBe(200); const portable = await exported.json();
  const raw = await request.post(runPhantom.url + "/api/traces/query", { data: { sql: `SELECT attributes,otlp_evidence FROM spans WHERE run_id='${capture.id}'` } }); expect(raw.status()).toBe(200); const source = (await raw.json()).rows[0], attributes = JSON.parse(source.attributes);
  attributes["ai.settings.fixture"] = attributes["ai.settings.fixture"].replace(definitionKey, "\\u0072\\u0075nphantom.agent.definition"); expect(JSON.parse(attributes["ai.settings.fixture"])[definitionKey]).toBe(marker);
  portable.run.id = "f17-tracked-escaped-ui"; for (const row of portable.spans) { row.run_id = portable.run.id; row.attributes = JSON.stringify(attributes); row.otlp_evidence = source.otlp_evidence; }
  expect((await request.post(runPhantom.url + "/api/import-run", { data: portable })).status()).toBe(200);
  await page.goto(`${runPhantom.url}/runs/${portable.run.id}/span/${capture.spanId}`);
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(page.locator(`[data-span-row="${capture.spanId}"]`)).toBeVisible(); await page.getByRole("button", { name: /Provider Options \(Local-fixture\)/ }).click();
    await expect(page.getByText(JSON.stringify(safe), { exact: true })).toBeVisible(); await expect(page.getByText(definitionInput, { exact: true }).first()).toBeVisible(); await expect(page.getByText(definitionOutput, { exact: true }).first()).toBeVisible();
    const body = await page.locator("body").textContent(); await testInfo.attach(`actual-escaped-ui-${reload ? "reload" : "initial"}.json`, { body: JSON.stringify({ actualOtlpAndPortableImport: true, privateVisible: body!.includes(marker), safeBusinessVisible: body!.includes(safe), originalInputOutputEqual: body!.includes(definitionInput) && body!.includes(definitionOutput) }), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath(`definition-escaped-${reload ? "reload" : "initial"}.png`), fullPage: true });
    expect(body).not.toContain(marker); await expect(page.getByText(JSON.stringify("[UNAVAILABLE]"), { exact: true })).toBeVisible();
  }
  for (const route of [`/api/runs/detail/${portable.run.id}`, `/api/runs/${portable.run.id}/export`]) {
    const response = await request.get(runPhantom.url + route); expect(response.status()).toBe(200); const body = await response.json(); expect(JSON.stringify(body)).not.toContain(marker);
    expect(JSON.parse(body.spans[0].attributes)["ai.settings.fixture"]).toBe("[UNAVAILABLE]"); expect(body.spans[0].output_payload).toBe(definitionOutput);
  }
  const searched = await request.get(`${runPhantom.url}/api/runs/${portable.run.id}/search?scope=span_attributes&pattern=${encodeURIComponent(marker)}`); expect(searched.status()).toBe(200); expect((await searched.json()).matches).toEqual([]);
  const retained = await request.post(runPhantom.url + "/api/traces/query", { data: { sql: `SELECT attributes,otlp_evidence FROM spans WHERE run_id='${portable.run.id}'` } }); expect(retained.status()).toBe(200);
  expect((await retained.json()).rows[0]).toEqual({ attributes: JSON.stringify(attributes), otlp_evidence: source.otlp_evidence });
});
