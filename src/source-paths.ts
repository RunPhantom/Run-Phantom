import path from "node:path";
import { fileURLToPath } from "node:url";

declare const __RUNPHANTOM_SOURCE_ROOT__: string | undefined;

function resolveSourceRoot(): string {
  if (
    typeof __RUNPHANTOM_SOURCE_ROOT__ === "string" &&
    __RUNPHANTOM_SOURCE_ROOT__.length > 0
  ) {
    return __RUNPHANTOM_SOURCE_ROOT__;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export const SOURCE_ROOT = resolveSourceRoot();
export const SOURCE_ENTRY = path.join(SOURCE_ROOT, "src", "index.ts");
export const SOURCE_MIGRATIONS_DIR = path.join(SOURCE_ROOT, "drizzle");
export const SOURCE_SKILLS_DIR = path.join(SOURCE_ROOT, "skills");
export const SOURCE_UI_DIR = path.join(SOURCE_ROOT, "app", "dist");
