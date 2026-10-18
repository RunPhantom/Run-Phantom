import type { Database } from "bun:sqlite";
import { parseBoundedHookJson } from "./shared";

/** Management registers settings paths. Hook payloads cannot choose their retained producer label. */
export function hookVendorForSettings(file: string): "claude" | "cursor" {
  return /[\\/]\.cursor[\\/]hooks\.json$/.test(file) ? "cursor" : "claude";
}
export function hookVendorForSource(db: Database, registration: string): "claude" | "cursor" {
  const rows = db.query("SELECT data FROM coding_hook_installations WHERE source_root_key=? OR CASE WHEN json_valid(data) THEN EXISTS(SELECT 1 FROM json_each(data,'$.registrations') WHERE json_extract(value,'$.registrationId')=?) ELSE 0 END LIMIT 65").all(registration, registration) as { data: string | null }[];
  if (rows.length > 64) throw new Error("Hook installation quota");
  const vendors = new Set<"claude" | "cursor">();
  for (const row of rows) {
    const parsed = parseBoundedHookJson(row.data, 16384);
    if (parsed.status !== "accepted" || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) throw new Error("Corrupt hook installation");
    const binding = parsed.value.binding;
    if (!binding || typeof binding !== "object" || Array.isArray(binding) || typeof binding.settingsPath !== "string") throw new Error("Corrupt hook installation");
    vendors.add(hookVendorForSettings(binding.settingsPath));
  }
  if (vendors.size > 1) throw new Error("Ambiguous hook producer");
  return vendors.has("cursor") ? "cursor" : "claude";
}
