import { useSyncExternalStore } from "react";

export type ShellOverlay = "palette" | "shortcuts" | null;

const listeners = new Set<() => void>();
let current: ShellOverlay = null;
let returnFocus: HTMLElement | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function openOverlay(next: ShellOverlay): void {
  if (current === next) return;
  if (current === null && next !== null) {
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  current = next;
  for (const listener of listeners) listener();
}

export function openCommandPalette(): void { openOverlay("palette"); }
export function openShortcutSheet(): void { openOverlay("shortcuts"); }
export function closeOverlay(): void { openOverlay(null); }

/**
 * Radix returns focus to a Dialog.Trigger, and these overlays open from shortcuts and
 * several buttons instead, so they hand focus back to whatever held it when they opened.
 */
export function restoreOverlayFocus(event: Event): void {
  event.preventDefault();
  const target = returnFocus;
  returnFocus = null;
  if (target?.isConnected) target.focus();
}

export function useShellOverlay(): ShellOverlay {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
