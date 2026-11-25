import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Contrast, Keyboard, Link2, PanelLeft, PlayCircle, Settings, type LucideIcon } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { replayDemoTraces } from "../api/demo-traces";
import { useRuns } from "../hooks/use-runs";
import { ago, runAgentName, runDisplayName, runStatus, type RunStatus } from "../utils/helpers";
import { runPath } from "../utils/navigation";
import type { Run } from "../utils/types";
import { NAV_ITEMS, SETTINGS_NAV } from "./navigation";
import { useRegisterCommands, useRegisterShortcuts, type PaletteCommand, type PaletteStatus, type ShortcutDefinition } from "./commands";
import { openCommandPalette, openShortcutSheet, paletteSession } from "./overlays";
import { setThemePreference, toggleTheme } from "./theme";
import { readOtlpEndpoint } from "./otlp";

const RECENT_RUN_LIMIT = 8;

let sampleLoad: Promise<string[]> | null = null;

function recentRuns(runs: readonly Run[] | undefined): Run[] {
  return [...(runs ?? [])].sort((a, b) => b.last_updated_at - a.last_updated_at).slice(0, RECENT_RUN_LIMIT);
}

const PALETTE_TONE: Record<RunStatus, PaletteStatus["tone"]> = {
  live: "live",
  quiet: "unknown",
  complete: "ok",
  completed_with_errors: "warning",
  interrupted: "warning",
  failed: "error",
  cancelled: "cancelled",
  unknown: "unknown",
};

function statusOf(run: Run): PaletteStatus {
  const summary = runStatus(run);
  return { tone: PALETTE_TONE[summary.status], label: summary.label };
}

/** Registers the shell's own palette commands and global shortcuts. Render inside SidebarProvider. */
export function ShellCommands() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toggleSidebar } = useSidebar();
  const runs = useRuns();

  const recent = recentRuns(runs.data);
  const recentKey = recent.map(run => `${run.id}:${run.last_updated_at}:${run.error_count ?? 0}:${run.display_name ?? ""}`).join("|");

  const goTo = useMemo<PaletteCommand[]>(() => NAV_ITEMS.map((item, index) => ({
    id: `go:${item.id}`,
    group: "Go to",
    label: item.label,
    keywords: [item.path, ...(item.keywords ?? [])],
    icon: item.icon,
    shortcut: item.shortcut,
    order: index,
    run: ({ navigate: go }) => go(item.path),
  })), []);
  useRegisterCommands(goTo, [goTo]);

  const latest = (run: Run): Run => queryClient.getQueryData<Run[]>(["runs"])?.find(row => row.id === run.id) ?? run;
  const recentCommands: PaletteCommand[] = recent.map((run, index) => {
    const agent = runAgentName(run);
    const name = runDisplayName(run);
    return {
      id: `run:${run.id}`,
      group: "Recent runs",
      label: name,
      detail: () => [agent && agent !== name ? agent : null, ago(latest(run).last_updated_at)].filter(Boolean).join(" · "),
      keywords: [run.id, ...(agent ? [agent] : []), ...(run.model ? [run.model] : [])],
      status: () => statusOf(latest(run)),
      order: index,
      run: ({ navigate: go }) => go(runPath(run.id)),
    };
  });
  useRegisterCommands(recentCommands, [recentKey]);

  const action = (command: Omit<PaletteCommand, "group"> & { icon: LucideIcon }): PaletteCommand => ({ group: "Actions", ...command });
  useRegisterCommands([
    action({
      id: "action:load-samples",
      label: "Load sample runs",
      keywords: ["demo", "traces", "example", "seed"],
      icon: PlayCircle,
      order: 0,
      keepOpen: true,
      run: async ({ navigate: go, announce, close }) => {
        if (sampleLoad) { announce("Already loading sample runs…"); return; }
        announce("Loading sample runs…");
        const openedIn = paletteSession();
        sampleLoad = replayDemoTraces();
        try {
          const ids = await sampleLoad;
          await queryClient.invalidateQueries({ queryKey: ["runs"], exact: true });
          if (paletteSession() !== openedIn) return;
          close();
          go(ids[0] ? runPath(ids[0]) : "/runs");
        } finally {
          sampleLoad = null;
        }
      },
    }),
    action({ id: "action:toggle-theme", label: "Toggle theme", keywords: ["dark", "light", "appearance", "colour", "color"], icon: Contrast, order: 1, run: toggleTheme }),
    action({ id: "action:system-theme", label: "Match system theme", keywords: ["appearance", "auto", "os"], icon: Contrast, order: 2, run: () => setThemePreference("system") }),
    action({ id: "action:open-settings", label: "Open settings", keywords: [SETTINGS_NAV.path, ...SETTINGS_NAV.keywords], icon: Settings, shortcut: SETTINGS_NAV.shortcut, order: 3, run: ({ navigate: go }) => go(SETTINGS_NAV.path) }),
    action({
      id: "action:copy-otlp",
      label: "Copy OTLP endpoint",
      keywords: ["opentelemetry", "otel", "traces url", "exporter", "connect"],
      icon: Link2,
      order: 4,
      keepOpen: true,
      run: async ({ announce }) => {
        const endpoint = await readOtlpEndpoint();
        try {
          await navigator.clipboard.writeText(endpoint);
          announce(`Copied ${endpoint}`);
        } catch {
          announce(`Copy blocked by the browser. Endpoint: ${endpoint}`);
        }
      },
    }),
    action({ id: "action:toggle-sidebar", label: "Toggle sidebar", keywords: ["navigation", "collapse", "expand"], icon: PanelLeft, shortcut: "mod+b", order: 5, run: toggleSidebar }),
    { id: "help:shortcuts", group: "Help", label: "Keyboard shortcuts", keywords: ["keys", "hotkeys", "help"], icon: Keyboard, shortcut: "?", keepOpen: true, run: () => openShortcutSheet() },
  ], [toggleSidebar]);

  const shortcuts = useMemo<ShortcutDefinition[]>(() => [
    { id: "palette", keys: "mod+k", scope: "Global", description: "Open the command palette", allowInInputs: true, handler: () => openCommandPalette() },
    { id: "shortcut-sheet", keys: "?", scope: "Global", description: "Show keyboard shortcuts", handler: () => openShortcutSheet() },
    { id: "sidebar", keys: "mod+b", scope: "Global", description: "Collapse or expand the sidebar" },
    { id: "focus-filter", keys: "/", scope: "Global", description: "Focus the search or filter field on Runs and Search" },
    ...NAV_ITEMS.filter(item => item.shortcut).map<ShortcutDefinition>(item => ({
      id: `go:${item.id}`,
      keys: item.shortcut!,
      scope: "Go to",
      description: item.label,
      handler: () => { void navigate(item.path); },
    })),
    { id: "go:settings", keys: SETTINGS_NAV.shortcut, scope: "Go to", description: SETTINGS_NAV.label, handler: () => { void navigate(SETTINGS_NAV.path); } },
  ], [navigate]);
  useRegisterShortcuts(shortcuts, [shortcuts]);

  return null;
}
