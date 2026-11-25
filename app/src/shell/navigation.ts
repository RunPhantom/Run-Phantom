import { Activity, Bookmark, CheckCircle2, ClipboardCheck, Coins, FileCode2, FlaskConical, LayoutDashboard, Search, type LucideIcon } from "lucide-react";

export type NavGroupId = "overview" | "debug" | "improve" | "ship";

export const NAV_GROUPS: readonly { id: NavGroupId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "debug", label: "Debug" },
  { id: "improve", label: "Improve" },
  { id: "ship", label: "Ship" },
];

export interface NavItem {
  id: string;
  /** Exact link text; e2e specs select nav links by this name. */
  label: string;
  path: string;
  icon: LucideIcon;
  group: NavGroupId;
  /** Sequence handled by the global shortcut dispatcher, e.g. "g r". */
  shortcut?: string;
  /** Extra palette search words. */
  keywords?: readonly string[];
}

/** Display order is array order within each group; the mono index numbers follow it. */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: "home", label: "Home", path: "/", icon: LayoutDashboard, group: "overview", shortcut: "g h", keywords: ["overview", "dashboard"] },
  { id: "runs", label: "Runs", path: "/runs", icon: Activity, group: "debug", shortcut: "g r", keywords: ["traces", "list"] },
  { id: "search", label: "Search", path: "/search", icon: Search, group: "debug", shortcut: "g s", keywords: ["find", "filter", "query"] },
  { id: "saved", label: "Saved", path: "/saved", icon: Bookmark, group: "debug", shortcut: "g b", keywords: ["bookmarks", "folders"] },
  { id: "evaluations", label: "Evaluations", path: "/evaluations", icon: FlaskConical, group: "improve", shortcut: "g e", keywords: ["test sets", "datasets", "experiments", "graders"] },
  { id: "review-queues", label: "Review queues", path: "/review-queues", icon: ClipboardCheck, group: "improve", shortcut: "g q", keywords: ["annotate", "label", "human review"] },
  { id: "prompts", label: "Prompts", path: "/prompts", icon: FileCode2, group: "improve", shortcut: "g p", keywords: ["templates", "revisions"] },
  { id: "verification", label: "Verification", path: "/verification", icon: CheckCircle2, group: "ship", shortcut: "g v", keywords: ["browser", "flows", "app checks"] },
  { id: "costs", label: "Cost & usage", path: "/costs", icon: Coins, group: "ship", shortcut: "g c", keywords: ["spend", "tokens", "pricing", "billing"] },
];

export const SETTINGS_NAV = { id: "settings", label: "Settings", path: "/settings", shortcut: "g ,", keywords: ["api keys", "agent endpoints", "preferences"] } as const;

export function isNavPathActive(pathname: string, path: string): boolean {
  if (path === "/") return pathname === "/";
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function sectionLabel(pathname: string): string {
  if (isNavPathActive(pathname, SETTINGS_NAV.path)) return SETTINGS_NAV.label;
  return NAV_ITEMS.find(item => isNavPathActive(pathname, item.path))?.label ?? "Not found";
}
