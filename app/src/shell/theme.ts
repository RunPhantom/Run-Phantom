import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** Read by public/assets/theme-boot.js before first paint; keep the key and values in sync with it. */
export const THEME_STORAGE_KEY = "runphantom:theme";

const PAGE_COLORS: Record<ResolvedTheme, { canvas: string; ink: string }> = {
  light: { canvas: "#F9FAFC", ink: "#0E121B" },
  dark: { canvas: "#0B0D12", ink: "#E8EBF2" },
};

const listeners = new Set<() => void>();
let preference: ThemePreference = readStoredPreference();
let systemQuery: MediaQueryList | null = null;

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "dark" || stored === "system" || stored === "light" ? stored : "light";
  } catch {
    return "light";
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(value: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (value === "system") return prefersDark ? "dark" : "light";
  return value;
}

function applyResolvedTheme(): void {
  const resolved = resolveTheme(preference, systemPrefersDark());
  const root = document.documentElement;
  if (resolved === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  root.style.backgroundColor = PAGE_COLORS[resolved].canvas;
  root.style.color = PAGE_COLORS[resolved].ink;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", PAGE_COLORS[resolved].canvas);
}

function notify(): void {
  applyResolvedTheme();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function installTheme(): void {
  applyResolvedTheme();
  if (systemQuery || typeof window.matchMedia !== "function") return;
  systemQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemQuery.addEventListener("change", () => { if (preference === "system") notify(); });
  window.addEventListener("storage", event => {
    if (event.key !== THEME_STORAGE_KEY) return;
    preference = readStoredPreference();
    notify();
  });
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(preference, systemPrefersDark());
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try { window.localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* storage can be disabled; the choice still applies to this tab */ }
  notify();
}

/** Flips between light and dark from whatever is currently on screen, so "system" never makes the toggle look dead. */
export function toggleTheme(): void {
  setThemePreference(getResolvedTheme() === "dark" ? "light" : "dark");
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getThemePreference, () => "light");
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolvedTheme, () => "light");
}
