/** Inert audit data only; safe for frontend types and exported evidence. */
export type AccessibilityRule = "button-name" | "image-alt" | "label" | "color-contrast";
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
  formatVersion: 1; source: "host-run-native-engine";
  engine: { name: "axe-core"; version: "4.11.0"; bundleSha256: string };
  requestedRules: AccessibilityRule[]; selectedRegions: string[];
  coverage: "complete" | "partial" | "unavailable"; status: "findings" | "no-findings" | "inconclusive";
  population: { total: number | null; retained: number; dropped: number };
  regions: Array<{ region: string; coverage: "complete" | "partial" | "unavailable"; rules: AccessibilityRulePopulation[] }>;
  findings: AccessibilityFinding[]; loss: AccessibilityLoss[];
  limits: { regions: number; rules: number; selectorBytes: number; domNodes: number; findings: number; targetBytes: number; outputBytes: number; engineMs: number };
}
