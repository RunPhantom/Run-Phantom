export const C = {
  bg:        "var(--rp-canvas)",
  surface:   "var(--rp-surface)",
  elevated:  "var(--rp-surface-raised)",
  border:    "var(--rp-border)",
  borderLight: "var(--rp-border-strong)",

  fg0:       "var(--rp-ink-muted)",
  fg1:       "var(--rp-ink-soft)",
  fg2:       "var(--rp-ink)",
  fg3:       "var(--rp-ink-strong)",
  fg4:       "var(--rp-ink-strong)",
  fg5:       "var(--rp-ink-strong)",

  accent:    "var(--rp-accent)",
  green:     "var(--rp-success)",
  red:       "var(--rp-danger)",
  purple:    "var(--rp-trace)",
  orange:    "var(--rp-warning)",
  cyan:      "var(--rp-info)",
  user:      "var(--rp-user-surface)",

  selected:  "var(--rp-selected)",
  selectedBorder: "var(--rp-selected-border)",
} as const;

const SPAN_COLORS = [
  "oklch(45% 0.12 152)", "oklch(48% 0.13 76)",
  "oklch(47% 0.18 31)", "oklch(44% 0.12 224)",
  "oklch(45% 0.16 259)", "oklch(43% 0.06 305)",
  "oklch(50% 0.12 91)", "oklch(43% 0.10 185)",
  "oklch(46% 0.14 282)", "oklch(45% 0.12 135)",
  "oklch(46% 0.10 48)", "oklch(44% 0.12 208)",
];

export function spanColor(name: string, map: Map<string, string>): string {
  if (!map.has(name)) {
    map.set(name, SPAN_COLORS[map.size % SPAN_COLORS.length]);
  }
  return map.get(name)!;
}
