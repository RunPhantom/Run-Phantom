import { useEffect } from "react";
import { listShortcuts, type ShortcutDefinition } from "./commands";

export interface Chord {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export const SEQUENCE_TIMEOUT_MS = 1200;

const KEY_ALIASES: Record<string, string> = { esc: "escape", space: " ", slash: "/", comma: "," };

export function parseKeys(keys: string): Chord[] {
  return keys.trim().split(/\s+/).map(part => {
    const tokens = part.toLowerCase().split("+");
    const raw = tokens.pop() || "+";
    return {
      key: KEY_ALIASES[raw] ?? raw,
      mod: tokens.includes("mod"),
      shift: tokens.includes("shift"),
      alt: tokens.includes("alt"),
    };
  });
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Symbols such as "?" already encode Shift in the produced character, so Shift is not compared for them. */
function shiftIsImplicit(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/.test(key);
}

export function chordMatches(event: KeyLike, chord: Chord, mac: boolean): boolean {
  if (event.key.toLowerCase() !== chord.key) return false;
  const modHeld = mac ? event.metaKey : event.ctrlKey;
  const otherHeld = mac ? event.ctrlKey : event.metaKey;
  if (chord.mod !== modHeld || otherHeld) return false;
  if (chord.alt !== event.altKey) return false;
  if (!shiftIsImplicit(chord.key) && chord.shift !== event.shiftKey) return false;
  return true;
}

/** Human-readable chord text for kbd chips: "⌘K" on macOS, "Ctrl+K" elsewhere, "G R" for sequences. */
/**
 * aria-keyshortcuts value for one chord on this platform: "Meta+K" on macOS, "Control+K"
 * elsewhere. The attribute separates alternatives with spaces and cannot express
 * sequences, so pass a single chord such as "mod+k", not "g r".
 */
export function ariaKeyShortcuts(keys: string, mac = isMacPlatform()): string {
  return parseKeys(keys).slice(0, 1).map(chord => {
    const key = chord.key === " " ? "Space" : chord.key === "escape" ? "Escape" : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key[0]!.toUpperCase() + chord.key.slice(1);
    return [chord.mod ? (mac ? "Meta" : "Control") : "", chord.alt ? "Alt" : "", chord.shift && !shiftIsImplicit(chord.key) ? "Shift" : "", key].filter(Boolean).join("+");
  }).join("");
}

export function formatKeys(keys: string, mac = isMacPlatform()): string {
  return parseKeys(keys).map(chord => {
    const key = chord.key === " " ? "Space" : chord.key === "escape" ? "Esc" : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key[0]!.toUpperCase() + chord.key.slice(1);
    const parts = [chord.mod ? (mac ? "⌘" : "Ctrl+") : "", chord.alt ? (mac ? "⌥" : "Alt+") : "", chord.shift && !shiftIsImplicit(chord.key) ? (mac ? "⇧" : "Shift+") : "", key];
    return parts.join("");
  }).join(" ");
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "time", "week"]);

export function isEditingTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest('[role="textbox"], [role="searchbox"], [contenteditable="true"]') !== null;
}

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog[open]';

/**
 * "none": no dialog. "pass-through": every open dialog is marked data-shortcut-passthrough
 * (the compact Ask pane), so shortcuts with allowInDialogs may still fire. "modal": the
 * dialog owns the keyboard and nothing fires.
 */
export function openDialogState(): "none" | "pass-through" | "modal" {
  const dialogs = document.querySelectorAll(DIALOG_SELECTOR);
  if (dialogs.length === 0) return "none";
  for (const dialog of dialogs) if (!dialog.hasAttribute("data-shortcut-passthrough")) return "modal";
  return "pass-through";
}

export function hasOpenDialog(): boolean {
  return openDialogState() !== "none";
}

export type SequenceResult =
  | { kind: "fire"; shortcut: ShortcutDefinition }
  | { kind: "pending"; pressed: Chord[] }
  | { kind: "none" };

/**
 * Pure matcher for one keydown given the chords already pressed in an unfinished
 * sequence. Exported for unit tests; the dispatcher owns timing and DOM guards.
 */
export function matchShortcut(
  event: KeyLike,
  pending: readonly Chord[],
  shortcuts: readonly ShortcutDefinition[],
  mac: boolean,
  editing: boolean,
  inDialog = false,
): SequenceResult {
  const attempt = (prefix: readonly Chord[]): SequenceResult => {
    let next: Chord | null = null;
    for (const shortcut of shortcuts) {
      if (!shortcut.handler) continue;
      if (editing && !shortcut.allowInInputs) continue;
      if (inDialog && !shortcut.allowInDialogs) continue;
      if (shortcut.when && !shortcut.when()) continue;
      const chords = parseKeys(shortcut.keys);
      if (chords.length <= prefix.length) continue;
      if (!prefix.every((chord, index) => sameChord(chord, chords[index]!))) continue;
      if (!chordMatches(event, chords[prefix.length]!, mac)) continue;
      if (chords.length === prefix.length + 1) return { kind: "fire", shortcut };
      next = chords[prefix.length]!;
    }
    return next ? { kind: "pending", pressed: [...prefix, next] } : { kind: "none" };
  };
  if (pending.length > 0) {
    const continued = attempt(pending);
    if (continued.kind !== "none") return continued;
  }
  return attempt([]);
}

function sameChord(a: Chord, b: Chord): boolean {
  return a.key === b.key && a.mod === b.mod && a.alt === b.alt && (shiftIsImplicit(a.key) || a.shift === b.shift);
}

/** Mount once, in the app layout. Listens on window in the bubble phase so focused widgets handle keys first. */
export function useShortcutDispatcher(): void {
  useEffect(() => {
    const mac = isMacPlatform();
    let pending: Chord[] = [];
    let pendingAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key === "Process") return;
      if (["Shift", "Control", "Meta", "Alt", "CapsLock"].includes(event.key)) return;
      const dialogs = openDialogState();
      if (dialogs === "modal") { pending = []; return; }
      if (pending.length && Date.now() - pendingAt > SEQUENCE_TIMEOUT_MS) pending = [];
      const result = matchShortcut(event, pending, listShortcuts(), mac, isEditingTarget(event.target), dialogs === "pass-through");
      if (result.kind === "fire") {
        pending = [];
        if (event.repeat && !result.shortcut.allowInInputs) return;
        event.preventDefault();
        result.shortcut.handler?.(event);
      } else if (result.kind === "pending") {
        pending = result.pressed;
        pendingAt = Date.now();
      } else {
        pending = [];
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
