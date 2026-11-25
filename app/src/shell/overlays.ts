import { useSyncExternalStore } from "react";

export type ShellOverlay = "palette" | "shortcuts" | null;

const listeners = new Set<() => void>();
let current: ShellOverlay = null;
let returnFocus: HTMLElement | null = null;
let focusOverride: (() => boolean) | null = null;
let session = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Switching straight from one overlay to another (palette -> shortcut sheet) keeps the
 * focus target captured when the first one opened, so Esc on the second still lands on
 * the original trigger rather than on the unmounted palette input.
 */
export function openOverlay(next: ShellOverlay): void {
  if (current === next) return;
  if (current === null && next !== null) {
    session += 1;
    const active = document.activeElement;
    const insideOverlay = active instanceof Element && active.closest("[data-command-palette], [data-shortcut-sheet]") !== null;
    if (!insideOverlay) returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  current = next;
  for (const listener of listeners) listener();
}

/**
 * Identifies one open-to-close stretch of the palette. An async command compares the
 * value from before its await with the value after, so a dismissed (or closed and
 * reopened) palette does not navigate the user somewhere they have already left.
 */
export function paletteSession(): number | null {
  return current === "palette" ? session : null;
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
  if (current !== null) return;
  const target = returnFocus;
  const override = focusOverride;
  returnFocus = null;
  focusOverride = null;
  if (override?.()) return;
  if (target?.isConnected) target.focus();
}

/**
 * For a command that moves the user somewhere new (the Ask composer): the next overlay
 * close calls `focus` instead of returning to the opener. Radix restores focus in a
 * timeout after unmount, so focusing directly from a command would be overwritten.
 * Return false (target not rendered) to fall back to the opener.
 */
export function focusAfterOverlayClose(focus: () => boolean): void {
  focusOverride = focus;
}

export function useShellOverlay(): ShellOverlay {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
