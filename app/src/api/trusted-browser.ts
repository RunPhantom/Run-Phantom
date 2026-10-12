import { apiJson, jsonInit } from "./request";
import type { BrowserAction, BrowserActionResult, BrowserObservation, BrowserOpen, BrowserSummary, BrowserArtifact } from "../../../src/verification/browser-types";
import type { Predicate, VerificationReport } from "./verification";
export type { BrowserAction, BrowserActionResult, BrowserSummary, BrowserArtifact };
export type BrowserProviderStatus = { available: boolean; attached: boolean; providerVersion?: string; reason?: string; engines: string[]; qualification: "launch-required"; networkProfile: "bounded-http-v1"; compatibility: "initial-only" };
export type AttachedListing = { session: BrowserSummary; revision: string; pages: Array<{ pageId: string; origin: string }>; capped: boolean };
const root = "/api/verification/browser";
const session = (id: string) => `${root}/sessions/${encodeURIComponent(id)}`;
export const trustedBrowserApi = {
  status: () => apiJson<BrowserProviderStatus>(`${root}/status`),
  sessions: () => apiJson<BrowserSummary[]>(`${root}/sessions`),
  open: (body: BrowserOpen) => apiJson<BrowserSummary>(`${root}/sessions`, jsonInit("POST", body)),
  attached: () => apiJson<AttachedListing>(`${root}/attached-pages`, jsonInit("POST", {})),
  select: (listing: AttachedListing, pageId: string) => apiJson<BrowserSummary>(`${session(listing.session.id)}/select`, jsonInit("POST", { generation: listing.session.generation, revision: listing.revision, pageId })),
  observe: (id: string) => apiJson<BrowserObservation>(`${session(id)}/events`),
  action: (id: string, generation: number, action: BrowserAction) => apiJson<{ action: BrowserActionResult; observation: BrowserObservation }>(`${session(id)}/action`, jsonInit("POST", { generation, action })),
  check: (id: string, generation: number, predicate: Predicate, action?: BrowserAction) => apiJson<{ action?: BrowserActionResult; report: VerificationReport }>(`${session(id)}/check`, jsonInit("POST", { generation, predicate, ...(action ? { action } : {}) })),
  capture: (id: string, generation: number, raw: boolean) => apiJson<BrowserArtifact>(`${session(id)}/capture`, jsonInit("POST", { generation, raw, ...(raw ? { rawConsent: true } : {}) })),
  close: (id: string, generation: number) => apiJson<{ session: BrowserSummary; artifacts: BrowserArtifact[] }>(`${session(id)}/cancel`, jsonInit("POST", { generation })),
  artifacts: () => apiJson<BrowserArtifact[]>(`${root}/artifacts`),
  deleteArtifact: (id: string) => apiJson<{ ok: true }>(`${root}/artifacts/${encodeURIComponent(id)}`, jsonInit("DELETE")),
  artifactUrl: (id: string, raw = false) => `${root}/artifacts/${encodeURIComponent(id)}/content${raw ? "?rawConsent=true" : ""}`,
};
