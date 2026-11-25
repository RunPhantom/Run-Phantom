import { useMemo, useState } from "react";
import { Monitor, Moon, Search, Sun } from "lucide-react";
import { openCommandPalette } from "./overlays";
import { formatKeys, isMacPlatform } from "./keyboard";
import { setThemePreference, useThemePreference, type ThemePreference } from "./theme";

const THEME_CYCLE: Record<ThemePreference, ThemePreference> = { light: "dark", dark: "system", system: "light" };
const THEME_LABEL: Record<ThemePreference, string> = { light: "Light", dark: "Dark", system: "System" };
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor } as const;

const headerControl = "flex size-11 shrink-0 items-center justify-center rounded-control border border-rp-line bg-rp-surface text-rp-ink-muted transition-[background-color,border-color,color] duration-fast ease-out hover:border-rp-wash-border hover:bg-rp-wash hover:text-rp-ink lg:size-9";

export function CommandPaletteTrigger() {
  const mac = useMemo(isMacPlatform, []);
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      data-command-palette-trigger
      className={`${headerControl} gap-2 md:w-[300px] md:justify-start md:px-3 lg:h-9 lg:w-[300px]`}
    >
      <Search aria-hidden="true" className="size-4 shrink-0 text-rp-ink-subtle" />
      <span className="sr-only text-[13px] text-rp-ink-subtle md:not-sr-only md:min-w-0 md:flex-1 md:truncate md:text-left">Search runs, steps, commands</span>
      <kbd aria-hidden="true" className="rp-kbd hidden md:inline-flex">{formatKeys("mod+k", mac)}</kbd>
    </button>
  );
}

export function ThemeToggle() {
  const preference = useThemePreference();
  const [announcement, setAnnouncement] = useState("");
  const next = THEME_CYCLE[preference];
  const Icon = THEME_ICON[preference];
  return (
    <>
      <button
        type="button"
        data-theme-toggle
        aria-label={`Theme: ${THEME_LABEL[preference]}`}
        title={`Theme: ${THEME_LABEL[preference]}. Switch to ${THEME_LABEL[next]}.`}
        onClick={() => {
          setThemePreference(next);
          setAnnouncement(`${THEME_LABEL[next]} theme`);
        }}
        className={`${headerControl} hidden sm:flex`}
      >
        <Icon aria-hidden="true" className="size-4" />
      </button>
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
    </>
  );
}
