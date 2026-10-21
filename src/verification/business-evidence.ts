/** Body conventions are explanatory findings, not an API success contract. */
export interface BodyFinding { path: string; reason: string }
function nonempty(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.values(value).slice(0, 64).some(entry => nonempty(entry, depth + 1));
  return true;
}
export function bodyFailureFindings(body: unknown): BodyFinding[] {
  const findings: BodyFinding[] = [];
  let visited = 0;
  const visit = (value: unknown, path: string, depth: number): void => {
    if (++visited > 128 || depth > 4 || findings.length >= 8 || value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value).slice(0, 64)) {
      const at = path ? `${path}.${key}` : key;
      if (["error", "errors", "errorMessage", "failureReason"].includes(key) && nonempty(entry)) findings.push({ path: at.slice(0, 256), reason: "Nonempty declared error field" });
      else if (["success", "ok", "succeeded"].includes(key) && entry === false) findings.push({ path: at.slice(0, 256), reason: "False success field" });
      if (findings.length >= 8) break;
      visit(entry, at, depth + 1);
    }
  };
  visit(body, "", 0);
  return findings;
}
