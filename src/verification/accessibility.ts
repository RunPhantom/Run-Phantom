/** Explicit native engine evidence. Page values never provide audit authority. */
import { BrowserInputError, browserArray, browserGeneration, browserId, browserObject, parseBrowserTarget, scrubBrowserSecrets } from "./browser-contract";
import { createHash, randomUUID } from "node:crypto";
import engineSource from "./vendor/axe-core-4.11.0/axe.min.js" with { type: "text" };
import type { AccessibilityRule, AccessibilityLoss, AccessibilityRequest, AccessibilityIdentity, AccessibilityTarget, AccessibilityFinding, AccessibilityEvidence } from "./accessibility-types";
export type { AccessibilityRule, AccessibilityLoss, AccessibilityRequest, AccessibilityIdentity, AccessibilityTarget, AccessibilityFinding, AccessibilityRulePopulation, AccessibilityEvidence } from "./accessibility-types";

export const ACCESSIBILITY_ENGINE = { name: "axe-core", version: "4.11.0",
  bundleSha256: "e9e5863c33a874f09bc01acd9234b7e3c871479f5eef8802fa582544465e6d01" } as const;
export const ACCESSIBILITY_LIMITS = { regions: 4, rules: 4, selectorBytes: 256, domNodes: 2000,
  findings: 100, targetBytes: 256, outputBytes: 65536, engineMs: 5000 } as const;
export const ACCESSIBILITY_RULES = ["button-name", "image-alt", "label", "color-contrast"] as const;
const rootLoss = ["closed-shadow-root", "iframe-excluded", "root-inventory-limit", "root-inventory-unavailable", "document-changed"] as const;
const categories = ["passes", "violations", "incomplete", "inapplicable"] as const;
const invalid = (): never => { throw new BrowserInputError(400, "Explicit bounded accessibility rules and regions required"); };

export function parseAccessibilityRequest(value: unknown, secrets: readonly string[] = []): AccessibilityRequest {
  const body = browserObject(value, ["generation", "rules", "regions"]);
  const generation = browserGeneration(body.generation);
  const rules = browserArray(body.rules, ACCESSIBILITY_LIMITS.rules).map(rule => {
    if (!ACCESSIBILITY_RULES.includes(rule as AccessibilityRule)) invalid();
    return rule as AccessibilityRule;
  });
  const regions = browserArray(body.regions, ACCESSIBILITY_LIMITS.regions).map(region => {
    if (typeof region !== "string" || Buffer.byteLength(region) > ACCESSIBILITY_LIMITS.selectorBytes || region !== region.trim()
      || /<|https?:\/\/|javascript:|data:/i.test(region) || scrubBrowserSecrets(region, secrets) !== region) invalid();
    const target = parseBrowserTarget({ kind: "css", selector: region });
    return target.kind === "css" ? target.selector : invalid();
  });
  if (!rules.length || !regions.length || new Set(rules).size !== rules.length || new Set(regions).size !== regions.length) invalid();
  return { generation, rules, regions };
}

// Read only the engine fields needed for provenance and population. Never copy HTML,
// check messages, arbitrary help URLs or engine error bodies into retained evidence.
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) throw new Error("data");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("data");
  return descriptor.value as unknown;
}
function dataArray(value: unknown, max: number): unknown[] { return browserArray(value, max); }

export function normalizeAccessibility(rawRequest: unknown, rawIdentity: unknown, rawResults: unknown, secrets: readonly string[] = []): AccessibilityEvidence {
  const request = parseAccessibilityRequest(rawRequest, secrets), identity = browserObject(rawIdentity, ["sessionId", "generation", "capturedAt"]);
  const sessionId = browserId(identity.sessionId), generation = browserGeneration(identity.generation);
  if (generation !== request.generation) throw new BrowserInputError(409, "Accessibility generation changed");
  if (!Number.isSafeInteger(identity.capturedAt) || (identity.capturedAt as number) < 0) throw new BrowserInputError(400, "Valid accessibility capture time required");
  const evidence: AccessibilityEvidence = { formatVersion: 1, source: "host-run-native-engine", engine: { ...ACCESSIBILITY_ENGINE },
    sessionId, generation, capturedAt: identity.capturedAt as number, requestedRules: [...request.rules], selectedRegions: [...request.regions],
    coverage: "unavailable", status: "inconclusive", population: { total: null, retained: 0, dropped: 0 }, regions: [], findings: [], loss: [], limits: { ...ACCESSIBILITY_LIMITS } };
  const lose = (reason: AccessibilityLoss) => { if (!evidence.loss.includes(reason)) evidence.loss.push(reason); };
  let supplied: unknown[] = [];
  try { supplied = dataArray(rawResults, ACCESSIBILITY_LIMITS.regions); } catch { lose("engine-unavailable"); }
  let completed = 0, total = 0, applicable = 0, populationKnown = true;
  const safeTarget = (value: unknown, loss: Set<AccessibilityLoss>): AccessibilityTarget => {
    const safeText = (raw: unknown): string => {
      if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > ACCESSIBILITY_LIMITS.targetBytes || /[\0<>]|https?:\/\/|javascript:|data:/i.test(raw)) { loss.add("target-unavailable"); return "[TARGET OMITTED]"; }
      const safe = scrubBrowserSecrets(raw, secrets);
      if (safe !== raw) loss.add("target-redacted");
      if (Buffer.byteLength(safe) > ACCESSIBILITY_LIMITS.targetBytes) { loss.add("target-unavailable"); return "[TARGET OMITTED]"; }
      return safe;
    };
    try {
      const target = dataArray(value, 4);
      if (!target.length) throw new Error("target");
      return target.map(entry => {
        if (!Array.isArray(entry)) return safeText(entry);
        const path = dataArray(entry, 4); if (!path.length) throw new Error("target"); return path.map(safeText);
      });
    } catch { loss.add("target-unavailable"); return ["[TARGET OMITTED]"]; }
  };
  for (const region of request.regions) {
    const row: AccessibilityEvidence["regions"][number] = { region, coverage: "unavailable", rules: request.rules.map(rule => ({ rule, passed: 0, violations: 0, incomplete: 0, inapplicable: false, observed: false })) };
    evidence.regions.push(row);
    let matches: unknown[];
    try { matches = supplied.filter(item => field(item, "region") === region); } catch { lose("engine-result-invalid"); populationKnown = false; continue; }
    if (matches.length !== 1) { lose(supplied.length ? "region-unavailable" : "engine-unavailable"); populationKnown = false; continue; }
    const source = matches[0]; let result: unknown;
    try { result = field(source, "result"); } catch { lose("engine-unavailable"); populationKnown = false; continue; }
    if (!result) { lose("engine-unavailable"); populationKnown = false; continue; }
    try {
      const engine = field(result, "testEngine");
      if (field(engine, "name") !== ACCESSIBILITY_ENGINE.name || field(engine, "version") !== ACCESSIBILITY_ENGINE.version) { lose("engine-identity"); populationKnown = false; continue; }
    } catch { lose("engine-identity"); populationKnown = false; continue; }
    const regionFindings: AccessibilityFinding[] = []; let regionTotal = 0, regionApplicable = 0;
    const regionLoss = new Set<AccessibilityLoss>();
    try {
      const nativeCoverage = field(source, "rootCoverage"), reasons = dataArray(field(source, "rootLoss"), rootLoss.length);
      if (!["complete", "partial"].includes(nativeCoverage as string) || reasons.some(reason => !rootLoss.includes(reason as typeof rootLoss[number]))
        || nativeCoverage === "complete" && reasons.length || nativeCoverage === "partial" && !reasons.length) throw new Error("coverage");
      for (const reason of reasons) regionLoss.add(reason as AccessibilityLoss);
      let nodePopulation = 0;
      for (const category of categories) {
        const entries = dataArray(field(result, category), ACCESSIBILITY_LIMITS.rules), seen = new Set<AccessibilityRule>();
        for (const entry of entries) {
          const id = field(entry, "id") as AccessibilityRule;
          if (!request.rules.includes(id) || seen.has(id)) throw new Error("rule"); seen.add(id);
          const nodes = dataArray(field(entry, "nodes"), ACCESSIBILITY_LIMITS.domNodes);
          nodePopulation += nodes.length; if (nodePopulation > ACCESSIBILITY_LIMITS.domNodes) { regionLoss.add("population-limit"); throw new Error("population"); }
          const rule = row.rules.find(item => item.rule === id)!; rule.observed = true;
          if (category === "inapplicable") { if (nodes.length) throw new Error("inapplicable"); rule.inapplicable = true; }
          else {
            if (!nodes.length) throw new Error("empty");
            rule[category === "passes" ? "passed" : category] = nodes.length; regionApplicable += nodes.length;
            if (category === "incomplete") regionLoss.add("review-required");
          }
          if (category === "violations") {
            regionTotal += nodes.length;
            for (const node of nodes) {
              if (regionFindings.length + evidence.findings.length >= ACCESSIBILITY_LIMITS.findings) { regionLoss.add("finding-limit"); continue; }
              const impact = field(node, "impact");
              if (impact !== null && !["minor", "moderate", "serious", "critical"].includes(impact as string)) throw new Error("impact");
              regionFindings.push({ rule: id, region, impact: impact as AccessibilityFinding["impact"], target: safeTarget(field(node, "target"), regionLoss) });
            }
          }
        }
      }
      for (const rule of row.rules) {
        if (!rule.observed) regionLoss.add("rule-unavailable");
        if (rule.inapplicable && (rule.passed || rule.violations || rule.incomplete)) throw new Error("inapplicable");
      }
      if (!regionApplicable) regionLoss.add("no-applicable-nodes");
      completed++; total += regionTotal; applicable += regionApplicable; evidence.findings.push(...regionFindings);
      row.coverage = regionLoss.size ? "partial" : "complete";
    } catch {
      regionLoss.add("engine-result-invalid"); populationKnown = false;
      // A malformed result cannot authenticate a subset of its claimed findings.
      for (const rule of row.rules) Object.assign(rule, { passed: 0, violations: 0, incomplete: 0, inapplicable: false, observed: false });
    }
    for (const reason of regionLoss) lose(reason);
  }
  if (!completed && !evidence.loss.length) lose("engine-unavailable");
  if (completed && !applicable) lose("no-applicable-nodes");
  evidence.population.total = populationKnown && completed === request.regions.length ? total : null;
  const finish = () => {
    evidence.population.retained = evidence.findings.length;
    evidence.population.dropped = Math.max(0, total - evidence.findings.length);
    evidence.coverage = !completed ? "unavailable" : evidence.loss.length || completed !== request.regions.length ? "partial" : "complete";
    evidence.status = evidence.findings.length ? "findings" : evidence.coverage === "complete" && applicable > 0 ? "no-findings" : "inconclusive";
  };
  finish();
  while (Buffer.byteLength(JSON.stringify(evidence)) > ACCESSIBILITY_LIMITS.outputBytes && evidence.findings.length) { evidence.findings.pop(); lose("output-limit"); finish(); }
  if (Buffer.byteLength(JSON.stringify(evidence)) > ACCESSIBILITY_LIMITS.outputBytes) throw new BrowserInputError(503, "Accessibility evidence exceeded its finite output budget");
  return evidence;
}

/** Revalidate finite native replies at the host boundary before exposing any evidence. */
export function parseAccessibilityEvidence(value: unknown, rawRequest: unknown, identity: AccessibilityIdentity, secrets: readonly string[] = []): AccessibilityEvidence {
  const base = normalizeAccessibility(rawRequest, identity, undefined, secrets), request = parseAccessibilityRequest(rawRequest, secrets);
  const reject = (): never => { throw new BrowserInputError(503, "Native accessibility evidence is invalid or unavailable"); };
  const body = browserObject(value, ["formatVersion", "source", "engine", "sessionId", "generation", "capturedAt", "requestedRules", "selectedRegions", "coverage", "status", "population", "regions", "findings", "loss", "limits"]);
  if (body.formatVersion !== 1 || body.source !== base.source || body.sessionId !== base.sessionId || body.generation !== base.generation || body.capturedAt !== base.capturedAt) reject();
  for (const [key, expected] of [["engine", ACCESSIBILITY_ENGINE], ["limits", ACCESSIBILITY_LIMITS]] as const) {
    const supplied = browserObject(body[key], Object.keys(expected));
    if (Object.keys(supplied).length !== Object.keys(expected).length || Object.entries(expected).some(([name, wanted]) => supplied[name] !== wanted)) reject();
  }
  const same = (actual: unknown, expected: string[], max: number) => {
    const array = browserArray(actual, max); if (array.length !== expected.length || array.some((item, index) => item !== expected[index])) reject();
  };
  same(body.requestedRules, request.rules, ACCESSIBILITY_LIMITS.rules); same(body.selectedRegions, request.regions, ACCESSIBILITY_LIMITS.regions);
  const permittedLoss: AccessibilityLoss[] = ["engine-unavailable", "engine-identity", "engine-result-invalid", "region-unavailable", "rule-unavailable", "review-required", "no-applicable-nodes", ...rootLoss,
    "finding-limit", "target-redacted", "target-unavailable", "output-limit", "population-limit", "engine-timeout", "unsupported-browser"];
  const loss = browserArray(body.loss, permittedLoss.length).map(reason => { if (!permittedLoss.includes(reason as AccessibilityLoss)) reject(); return reason as AccessibilityLoss; });
  if (new Set(loss).size !== loss.length) reject();
  const count = (value: unknown): number => { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > ACCESSIBILITY_LIMITS.domNodes) reject(); return value as number; };
  let total = 0, applicable = 0, incomplete = 0;
  const regions = browserArray(body.regions, ACCESSIBILITY_LIMITS.regions).map((value, index) => {
    const region = browserObject(value, ["region", "coverage", "rules"]);
    if (region.region !== request.regions[index] || !["complete", "partial", "unavailable"].includes(region.coverage as string)) reject();
    const rules = browserArray(region.rules, ACCESSIBILITY_LIMITS.rules).map((value, index) => {
      const rule = browserObject(value, ["rule", "passed", "violations", "incomplete", "inapplicable", "observed"]);
      if (rule.rule !== request.rules[index] || typeof rule.inapplicable !== "boolean" || typeof rule.observed !== "boolean") reject();
      const passed = count(rule.passed), violations = count(rule.violations), review = count(rule.incomplete);
      if (rule.inapplicable && (passed || violations || review) || !rule.observed && (passed || violations || review || rule.inapplicable)
        || rule.observed && !rule.inapplicable && !(passed || violations || review) || region.coverage === "complete" && (!rule.observed || review)) reject();
      total += violations; applicable += passed + violations + review; incomplete += review;
      return { rule: rule.rule as AccessibilityRule, passed, violations, incomplete: review, inapplicable: rule.inapplicable as boolean, observed: rule.observed as boolean };
    });
    if (rules.length !== request.rules.length) reject();
    return { region: region.region as string, coverage: region.coverage as AccessibilityEvidence["coverage"], rules };
  });
  if (regions.length !== request.regions.length || applicable > ACCESSIBILITY_LIMITS.domNodes * ACCESSIBILITY_LIMITS.regions) reject();
  const text = (value: unknown): string => {
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > ACCESSIBILITY_LIMITS.targetBytes || /[\0<>]|https?:\/\/|javascript:|data:/i.test(value)) reject();
    // Existing host placeholders are data; do not rescan their letters as entered secrets.
    if ((value as string).split(/\[(?:REDACTED|TARGET OMITTED)\]/g).some(part => scrubBrowserSecrets(part, secrets) !== part)) reject();
    return value as string;
  };
  const findings = browserArray(body.findings, ACCESSIBILITY_LIMITS.findings).map(value => {
    const finding = browserObject(value, ["rule", "region", "impact", "target"]);
    if (!request.rules.includes(finding.rule as AccessibilityRule) || !request.regions.includes(finding.region as string)
      || finding.impact !== null && !["minor", "moderate", "serious", "critical"].includes(finding.impact as string)) reject();
    const target = browserArray(finding.target, 4).map(part => { if (!Array.isArray(part)) return text(part); const path = browserArray(part, 4).map(text); if (!path.length) reject(); return path; });
    if (!target.length) reject();
    return { rule: finding.rule as AccessibilityRule, region: finding.region as string, impact: finding.impact as AccessibilityFinding["impact"], target };
  });
  for (const region of regions) for (const rule of region.rules) {
    if (findings.filter(finding => finding.region === region.region && finding.rule === rule.rule).length > rule.violations) reject();
  }
  const population = browserObject(body.population, ["total", "retained", "dropped"]);
  if (population.retained !== findings.length || population.dropped !== total - findings.length || total < findings.length
    || population.total !== null && population.total !== total) reject();
  const coverage = regions.every(region => region.coverage === "unavailable") ? "unavailable" : loss.length || regions.some(region => region.coverage !== "complete") ? "partial" : "complete";
  if (body.coverage !== coverage || coverage === "complete" && (population.total === null || !applicable || incomplete)) reject();
  const status = findings.length ? "findings" : coverage === "complete" && applicable > 0 ? "no-findings" : "inconclusive";
  if (body.status !== status) reject();
  const result: AccessibilityEvidence = { ...base, coverage, status, engine: { ...ACCESSIBILITY_ENGINE }, limits: { ...ACCESSIBILITY_LIMITS },
    regions, findings, loss, population: { total: population.total as number | null, retained: findings.length, dropped: total - findings.length } };
  if (Buffer.byteLength(JSON.stringify(result)) > ACCESSIBILITY_LIMITS.outputBytes) reject();
  return result;
}

export interface AccessibilityCDP {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, any>>;
  detach(): Promise<void>;
}
export interface AccessibilityPage {
  context(): { newCDPSession(page: AccessibilityPage): Promise<AccessibilityCDP> };
  isClosed(): boolean;
}
export interface AccessibilityAuthority {
  current(): boolean;
  /** Must invalidate and tear down the owned connection, not merely reject a promise. */
  terminate(): Promise<void>;
}
function installAuditScope(input: { regions: string[]; cap: number }) {
  let changed = false, capped = false;
  const observer = new MutationObserver(() => { changed = true; });
  const observe = (root: Node) => observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  observe(document);
  const roots = input.regions.map(selector => {
    const matches = document.querySelectorAll(selector);
    if (matches.length !== 1) throw new Error("region");
    const root = matches[0], style = getComputedStyle(root);
    if (!root.isConnected || root.ownerDocument !== document || style.display === "none" || style.visibility !== "visible" || !root.getClientRects().length) throw new Error("region");
    return root;
  });
  const nodes: Element[] = [], visited = new Set<Node>(), pending: Node[] = [...roots]; let count = 0;
  while (pending.length && !capped) {
    const root = pending.pop()!, walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    let node: Node | null = root;
    while (node) {
      if (!visited.has(node)) {
        visited.add(node); if (++count > input.cap) { capped = true; break; }
        if (node instanceof Element) {
          // Bound native metadata responses before requesting any node description.
          let attributes = 0;
          if (node.attributes.length > 100) { capped = true; break; }
          for (const attribute of node.attributes) { attributes += attribute.name.length + attribute.value.length; if (attributes > 16384) { capped = true; break; } }
          if (capped) break; nodes.push(node);
          if (node.shadowRoot) { observe(node.shadowRoot); pending.push(node.shadowRoot); }
        }
      }
      node = walker.nextNode();
    }
  }
  const current = () => {
    if (observer.takeRecords().length) changed = true;
    return !changed && roots.every((root, index) => root.isConnected && root.ownerDocument === document
      && document.querySelectorAll(input.regions[index]).length === 1 && document.querySelector(input.regions[index]) === root);
  };
  return { roots, nodes, capped, current, dispose: () => observer.disconnect() };
}

const isolatedWorlds = new WeakMap<AccessibilityPage, string>();

async function executeAuditScope(input: { rules: string[]; regions: string[]; cap: number; findings: number; targetBytes: number }) {
  const globals = globalThis as unknown as { axe: { configure(options: unknown): void; frameMessenger(options: unknown): void; run(root: Element, options: unknown): Promise<Record<string, any>> };
    __rpAudit: ReturnType<typeof installAuditScope> };
  const scope = globals.__rpAudit, engine = globals.axe;
  const results: Array<Record<string, unknown>> = []; let population = 0, retained = 0;
  try {
    // Frames are explicitly excluded: close the native postMessage listener.
    engine.frameMessenger({ open: () => () => {}, post: () => false });
    engine.configure({ noHtml: true, allowedOrigins: [] });
    for (let index = 0; index < scope.roots.length; index++) {
      if (!scope.current()) throw new Error("document-changed");
      const raw = await engine.run(scope.roots[index], { runOnly: { type: "rule", values: input.rules }, iframes: false,
        preload: false, resultTypes: ["violations", "incomplete", "passes", "inapplicable"], elementRef: false, selectors: true });
      const result: Record<string, unknown> = { testEngine: { name: raw.testEngine?.name, version: raw.testEngine?.version } };
      for (const category of ["passes", "violations", "incomplete", "inapplicable"]) {
        if (!Array.isArray(raw[category]) || raw[category].length > input.rules.length) throw new Error("result");
        result[category] = raw[category].map((entry: Record<string, any>) => {
          if (!Array.isArray(entry.nodes)) throw new Error("result");
          population += entry.nodes.length; if (population > input.cap) throw new Error("population-limit");
          return { id: entry.id, nodes: entry.nodes.map((node: Record<string, any>) => {
            if (category !== "violations") return null;
            if (retained++ >= input.findings) return { impact: null, target: [""] };
            const target = node.target;
            // Keep only a finite selector path, never HTML, check data or failure text.
            const valid = Array.isArray(target) && target.length > 0 && target.length <= 4
              && target.every((part: unknown) => typeof part === "string" || Array.isArray(part) && part.length > 0 && part.length <= 4 && part.every(item => typeof item === "string"))
              && new TextEncoder().encode(JSON.stringify(target)).length <= input.targetBytes;
            return { impact: node.impact ?? null, target: valid ? target : [""] };
          }) };
        });
      }
      results.push({ region: input.regions[index], result });
    }
    if (!scope.current()) throw new Error("document-changed");
    return { results, failure: null };
  } catch (error) { const reason = error instanceof Error ? error.message : ""; return { results: [], failure: reason === "document-changed" || reason === "population-limit" ? reason : "engine-unavailable" }; }
}

/** A host-private isolated world is reused per page; a genuine engine is reloaded for each audit. */
export async function scanAccessibility(page: AccessibilityPage, rawRequest: unknown, rawIdentity: unknown,
  authority: AccessibilityAuthority, secrets: readonly string[] = []): Promise<AccessibilityEvidence> {
  const request = parseAccessibilityRequest(rawRequest, secrets);
  // Validate identity even on an unavailable path; no unauthenticated live identity is echoed.
  const unavailable = (reason: AccessibilityLoss) => {
    const result = normalizeAccessibility(request, rawIdentity, undefined, secrets);
    if (!result.loss.includes(reason)) result.loss.push(reason); return result;
  };
  if (createHash("sha256").update(engineSource).digest("hex") !== ACCESSIBILITY_ENGINE.bundleSha256) return unavailable("engine-identity");
  if (!authority.current() || page.isClosed()) return unavailable("document-changed");
  let cdp: AccessibilityCDP | undefined, world: number | undefined, timedOut = false, changed = false;
  let teardown: Promise<void> | undefined;
  const group = `rp-audit-${randomUUID()}`;
  let worldName = isolatedWorlds.get(page);
  if (!worldName) { worldName = `rp-audit-world-${randomUUID()}`; isolatedWorlds.set(page, worldName); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async (): Promise<AccessibilityEvidence> => {
    cdp = await page.context().newCDPSession(page);
    const tree = await cdp.send("Page.getFrameTree");
    world = (await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName, grantUniveralAccess: false })).executionContextId as number;
    if (!authority.current() || page.isClosed()) return unavailable("document-changed");
    const setup = await cdp.send("Runtime.evaluate", { contextId: world, expression: `globalThis.__rpAudit=(${installAuditScope.toString()})(${JSON.stringify({ regions: request.regions, cap: ACCESSIBILITY_LIMITS.domNodes })});globalThis.__rpAudit.capped`, returnByValue: true, objectGroup: group });
    if (setup.exceptionDetails) return unavailable("region-unavailable");
    if (setup.result.value !== false) return unavailable("root-inventory-limit");
    const handles = await cdp.send("Runtime.evaluate", { contextId: world, expression: "globalThis.__rpAudit.nodes", objectGroup: group });
    if (handles.exceptionDetails || !handles.result.objectId) return unavailable("root-inventory-unavailable");
    const properties = await cdp.send("Runtime.getProperties", { objectId: handles.result.objectId, ownProperties: true, generatePreview: false });
    if (!Array.isArray(properties.result) || properties.result.length > ACCESSIBILITY_LIMITS.domNodes + 1) return unavailable("root-inventory-limit");
    const ids: string[] = properties.result.filter((property: Record<string, any>) => /^\d+$/.test(property.name)).map((property: Record<string, any>) => property.value?.objectId as string);
    if (ids.some(id => typeof id !== "string")) return unavailable("root-inventory-unavailable");
    const loss = new Set<AccessibilityLoss>();
    const inventory = async () => {
      const signatures: string[] = [];
      // Bounded handles and depth-zero native descriptions, never a flattened DOM dump.
      for (let index = 0; index < ids.length; index += 8) {
        if (!authority.current() || page.isClosed() || timedOut) throw new Error("changed");
        const batch = await Promise.all(ids.slice(index, index + 8).map(objectId => cdp!.send("DOM.describeNode", { objectId, depth: 0, pierce: false })));
        for (const response of batch) {
          const node = response.node;
          if (!node || !Number.isSafeInteger(node.backendNodeId) || node.children?.length) throw new Error("inventory");
          const roots = node.shadowRoots ?? [];
          if (!Array.isArray(roots) || roots.length > 4) throw new Error("inventory");
          if (roots.some((root: Record<string, any>) => root.shadowRootType === "closed")) loss.add("closed-shadow-root");
          if (roots.some((root: Record<string, any>) => !["open", "closed", "user-agent"].includes(root.shadowRootType as string))) throw new Error("inventory");
          if (node.frameId || ["IFRAME", "FRAME", "OBJECT", "EMBED"].includes(node.nodeName as string)) loss.add("iframe-excluded");
          signatures.push(`${node.backendNodeId}:${roots.map((root: Record<string, any>) => `${root.backendNodeId}:${root.shadowRootType}`).join(",")}`);
        }
      }
      return signatures.join("|");
    };
    let before: string;
    try { before = await inventory(); } catch { return unavailable("root-inventory-unavailable"); }
    const loaded = await cdp.send("Runtime.evaluate", { contextId: world, expression: engineSource, objectGroup: group });
    if (loaded.exceptionDetails) return unavailable("engine-unavailable");
    const audited = await cdp.send("Runtime.evaluate", { contextId: world, expression: `(${executeAuditScope.toString()})(${JSON.stringify({ rules: request.rules, regions: request.regions, cap: ACCESSIBILITY_LIMITS.domNodes, findings: ACCESSIBILITY_LIMITS.findings, targetBytes: ACCESSIBILITY_LIMITS.targetBytes })})`, awaitPromise: true, returnByValue: true, objectGroup: group });
    if (audited.exceptionDetails) {
      const stable = await cdp.send("Runtime.evaluate", { contextId: world, expression: "globalThis.__rpAudit.current()", returnByValue: true });
      return unavailable(stable.result?.value === false ? "document-changed" : "engine-unavailable");
    }
    const after = await inventory();
    const stable = await cdp.send("Runtime.evaluate", { contextId: world, expression: "globalThis.__rpAudit.current()", returnByValue: true });
    changed = stable.result?.value !== true || before !== after || !authority.current() || page.isClosed();
    if (changed) return unavailable("document-changed");
    if (audited.result.value?.failure !== null) return unavailable(["document-changed", "population-limit", "engine-unavailable"].includes(audited.result.value?.failure)
      ? audited.result.value.failure as AccessibilityLoss : "engine-result-invalid");
    const results = dataArray(audited.result.value.results, ACCESSIBILITY_LIMITS.regions).map(value => ({
      region: field(value, "region"), result: field(value, "result"), rootCoverage: loss.size ? "partial" : "complete", rootLoss: [...loss],
    }));
    return normalizeAccessibility(request, rawIdentity, results, secrets);
  };
  const deadline = new Promise<AccessibilityEvidence>(resolve => { timer = setTimeout(() => {
    timedOut = true;
    // Teardown starts at the execution deadline and completes before a timeout result returns.
    teardown = authority.terminate();
    void teardown.then(() => resolve(unavailable("engine-timeout")), () => resolve(unavailable("engine-timeout")));
  }, ACCESSIBILITY_LIMITS.engineMs); });
  try { const result = await Promise.race([work(), deadline]); if (teardown) await teardown.catch(() => {}); return timedOut ? unavailable("engine-timeout") : result; }
  catch { return unavailable(changed || !authority.current() || page.isClosed() ? "document-changed" : "engine-unavailable"); }
  finally {
    if (timer) clearTimeout(timer);
    if (teardown) await teardown.catch(() => {});
    if (cdp) {
      if (world !== undefined && !page.isClosed()) await cdp.send("Runtime.evaluate", { contextId: world,
        expression: "globalThis.__rpAudit?.dispose();delete globalThis.__rpAudit;delete globalThis.axe" }).catch(() => {});
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  }
}
