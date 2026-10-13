/** Explicit native engine evidence. Page values never provide audit authority. */
import { BrowserInputError, browserArray, browserGeneration, browserId, browserObject, parseBrowserTarget, scrubBrowserSecrets } from "./browser-contract";

export const ACCESSIBILITY_ENGINE = { name: "axe-core", version: "4.11.0",
  bundleSha256: "e9e5863c33a874f09bc01acd9234b7e3c871479f5eef8802fa582544465e6d01" } as const;
export const ACCESSIBILITY_LIMITS = { regions: 4, rules: 4, selectorBytes: 256, domNodes: 2000,
  findings: 100, targetBytes: 256, outputBytes: 65536, engineMs: 5000 } as const;
export const ACCESSIBILITY_RULES = ["button-name", "image-alt", "label", "color-contrast"] as const;
export type AccessibilityRule = typeof ACCESSIBILITY_RULES[number];
export type AccessibilityLoss = "engine-unavailable" | "engine-identity" | "engine-result-invalid" | "region-unavailable"
  | "rule-unavailable" | "review-required" | "no-applicable-nodes" | "closed-shadow-root" | "iframe-excluded"
  | "root-inventory-limit" | "root-inventory-unavailable" | "finding-limit" | "target-redacted" | "target-unavailable"
  | "output-limit" | "population-limit" | "document-changed" | "engine-timeout" | "unsupported-browser";
export interface AccessibilityRequest { generation: number; rules: AccessibilityRule[]; regions: string[] }
export interface AccessibilityIdentity { sessionId: string; generation: number; capturedAt: number }
export type AccessibilityTarget = Array<string | string[]>;
export interface AccessibilityFinding { rule: AccessibilityRule; region: string; impact: "minor" | "moderate" | "serious" | "critical" | null; target: AccessibilityTarget }
export interface AccessibilityRulePopulation { rule: AccessibilityRule; passed: number; violations: number; incomplete: number; inapplicable: boolean; observed: boolean }
export interface AccessibilityEvidence extends AccessibilityIdentity {
  formatVersion: 1; source: "host-run-native-engine"; engine: typeof ACCESSIBILITY_ENGINE;
  requestedRules: AccessibilityRule[]; selectedRegions: string[];
  coverage: "complete" | "partial" | "unavailable"; status: "findings" | "no-findings" | "inconclusive";
  population: { total: number | null; retained: number; dropped: number };
  regions: Array<{ region: string; coverage: "complete" | "partial" | "unavailable"; rules: AccessibilityRulePopulation[] }>;
  findings: AccessibilityFinding[]; loss: AccessibilityLoss[]; limits: typeof ACCESSIBILITY_LIMITS;
}
const rootLoss = ["closed-shadow-root", "iframe-excluded", "root-inventory-limit", "root-inventory-unavailable", "document-changed"] as const;
const categories = ["passes", "violations", "incomplete", "inapplicable"] as const;
const invalid = (): never => { throw new BrowserInputError(400, "Explicit bounded accessibility rules and regions required"); };

export function parseAccessibilityRequest(value: unknown): AccessibilityRequest {
  const body = browserObject(value, ["generation", "rules", "regions"]);
  const generation = browserGeneration(body.generation);
  const rules = browserArray(body.rules, ACCESSIBILITY_LIMITS.rules).map(rule => {
    if (!ACCESSIBILITY_RULES.includes(rule as AccessibilityRule)) invalid();
    return rule as AccessibilityRule;
  });
  const regions = browserArray(body.regions, ACCESSIBILITY_LIMITS.regions).map(region => {
    if (typeof region !== "string" || Buffer.byteLength(region) > ACCESSIBILITY_LIMITS.selectorBytes || region !== region.trim()) invalid();
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
  const request = parseAccessibilityRequest(rawRequest), identity = browserObject(rawIdentity, ["sessionId", "generation", "capturedAt"]);
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
      if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > ACCESSIBILITY_LIMITS.targetBytes || /[\0<>]/.test(raw)) { loss.add("target-unavailable"); return "[TARGET OMITTED]"; }
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
