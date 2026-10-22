import path from "node:path";
import { hookDigest, isHex, refuse, type HookSourceClaims } from "./protocol";
import type { InstallationBinding } from "./store";

export const CATALOG_VERSION = "runphantom.claude-catalog/v1";
export const CATALOG_CONTEXT_VERSION = "runphantom.claude-catalog/v2";
export type CatalogVersion = typeof CATALOG_VERSION | typeof CATALOG_CONTEXT_VERSION;
export interface SourceRegistration { registrationId: string; registeredWorkspace: string; transcriptRoot: string; projectDirectory: string; homeDirectory: string; }
export const sourceRootKey = (registration: Omit<SourceRegistration, "registrationId">): string => hookDigest(JSON.stringify(["runphantom.claude.root/v1", registration.registeredWorkspace, registration.transcriptRoot, registration.projectDirectory]));
export const registrationForBinding = (binding: InstallationBinding): SourceRegistration => ({ registrationId: sourceRootKey(binding), registeredWorkspace: binding.registeredWorkspace, transcriptRoot: binding.transcriptRoot, projectDirectory: binding.projectDirectory, homeDirectory: binding.homeDirectory });
export const claimsForRegistration = (registration: Omit<SourceRegistration, "registrationId">): HookSourceClaims => ({ workspaceClaim: hookDigest(JSON.stringify(["runphantom.claude.workspace-claim/v1", registration.registeredWorkspace])), projectClaim: hookDigest(JSON.stringify(["runphantom.claude.project-claim/v1", registration.projectDirectory])) });
const inside = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
export function validateRegistration(registration: SourceRegistration): SourceRegistration {
  if (!registration || typeof registration !== "object" || Object.keys(registration).sort().join(",") !== "homeDirectory,projectDirectory,registeredWorkspace,registrationId,transcriptRoot") refuse("unknown_scope", 409);
  for (const value of [registration.registeredWorkspace, registration.transcriptRoot, registration.projectDirectory, registration.homeDirectory]) if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0") || Buffer.byteLength(value) > 4096) refuse("unknown_scope", 409);
  const relative = path.relative(registration.transcriptRoot, registration.projectDirectory);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || relative.includes(path.sep) || !isHex(registration.registrationId, 64) || registration.registrationId !== sourceRootKey(registration)) refuse("unknown_scope", 409);
  return { registrationId: registration.registrationId, registeredWorkspace: registration.registeredWorkspace, transcriptRoot: registration.transcriptRoot, projectDirectory: registration.projectDirectory, homeDirectory: registration.homeDirectory };
}
export function validateCatalog(binding: InstallationBinding, input: SourceRegistration[] = [registrationForBinding(binding)]): SourceRegistration[] {
  if (!Array.isArray(input) || !input.length || input.length > 64) refuse("quota", 507);
  const unique = new Map<string, SourceRegistration>();
  for (const value of input) {
    const registration = validateRegistration(value), duplicate = unique.get(registration.registrationId);
    if (duplicate) { if (JSON.stringify(duplicate) !== JSON.stringify(registration)) refuse("unknown_scope", 409); continue; }
    for (const prior of unique.values()) if (prior.registeredWorkspace === registration.registeredWorkspace || inside(prior.projectDirectory, registration.projectDirectory) || inside(registration.projectDirectory, prior.projectDirectory)) refuse("unknown_scope", 409);
    unique.set(registration.registrationId, registration);
  }
  const registrations = [...unique.values()].sort((a, b) => a.registrationId.localeCompare(b.registrationId));
  if (!registrations.some(value => JSON.stringify(value) === JSON.stringify(registrationForBinding(binding))) || binding.scope === "local" && registrations.length !== 1) refuse("unknown_scope", 409);
  return registrations;
}
export function encodeInstallationCatalog(binding: InstallationBinding, registrations: SourceRegistration[], version: CatalogVersion = CATALOG_VERSION): string {
  const data = JSON.stringify({ version, binding, registrations }); if (Buffer.byteLength(data) > 16384) refuse("quota", 507); return data;
}
export function selectRegistration(registrations: SourceRegistration[], claims: HookSourceClaims): SourceRegistration {
  if (!claims || Object.keys(claims).sort().join(",") !== "projectClaim,workspaceClaim" || !isHex(claims.workspaceClaim, 64) || !isHex(claims.projectClaim, 64)) refuse("unknown_scope", 409);
  const matches = registrations.filter(value => { const expected = claimsForRegistration(value); return expected.workspaceClaim === claims.workspaceClaim && expected.projectClaim === claims.projectClaim; });
  if (matches.length !== 1) refuse("unknown_scope", 409); return matches[0];
}
