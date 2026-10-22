/** Inert browser DTOs shared with the UI; no host runtime or execution code. */
import type { Coverage, RuntimeEvent } from "./protocol";

export type BrowserEngine = "chromium" | "firefox" | "webkit";
export interface BrowserCompatibility {
  qualification: "initial-only";
  sameOrigin: "cookie-free" | "cookie-free-or-controlled-cookies";
  foreign: "conditional-cookie-free-get-head" | "unavailable";
  webSocket: "denied" | "unqualified";
  redirects: "unavailable";
}
export type BrowserTarget = { kind: "css"; selector: string } | { kind: "role"; role: string; name?: string; exact: true }
  | { kind: "label"; label: string; exact: true } | { kind: "test-id"; testId: string };
export type BrowserAction = { type: "click" | "hover" | "focus"; target: BrowserTarget }
  | { type: "fill"; target: BrowserTarget; value: string }
  | { type: "press"; target: BrowserTarget; key: string }
  | { type: "select"; target: BrowserTarget; value: string }
  | { type: "drag"; target: BrowserTarget; to: BrowserTarget };
export interface BrowserOpen { engine: BrowserEngine; url: string; runId?: string; recordVideo: boolean; rawConsent?: true }
export interface ExecutionContext {
  formatVersion: 1; backend: "trusted-browser"; engine: BrowserEngine; providerVersion: string;
  ownership: "owned" | "attached"; generation: number; inputMode: "trusted-browser" | "none" | "unknown";
  dispatch: "not-dispatched" | "completed" | "unknown"; actionId?: string; artifactIds?: string[];
}
export interface BrowserSummary {
  id: string; origin: string | null; runId: string | null; ownership: "owned" | "attached";
  engine: BrowserEngine; providerVersion: string; engineVersion: string; generation: number;
  state: "opening" | "selecting" | "ready" | "busy" | "closed" | "unavailable";
  coverage: Coverage; history: "from-open" | "from-selection"; loss: boolean; pending: number;
  reason?: string; video: "off" | "recording" | "stopped";
  networkProfile: "bounded-http-v1"; compatibility: BrowserCompatibility;
}
export interface BrowserActionResult {
  actionId: string; generationBefore: number; generationAfter: number;
  dispatch: ExecutionContext["dispatch"]; inputMode: ExecutionContext["inputMode"]; reason?: string;
}
export interface BrowserObservation { session: BrowserSummary; events: RuntimeEvent[]; cursor: number; complete: boolean; dropped: number }

export interface BrowserArtifact {
  id: string; kind: "screenshot" | "video"; mime: "image/png" | "video/webm"; bytes: number; sha256: string;
  capturedAt: number; raw: boolean; maskScope: "none" | "inputs-editable-private-known-secrets";
  engine: BrowserEngine; ownership: "owned" | "attached"; generation: number; width?: number; height?: number;
}
