import { useEffect, useRef, useSyncExternalStore } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

/**
 * Palette commands and keyboard shortcuts are registered here so features can add
 * their own without editing the palette or the dispatcher. Registration is by id:
 * registering an id again replaces the earlier entry.
 */

export type CommandGroup = "Go to" | "Recent runs" | "Actions" | "Help" | (string & {});

export interface CommandContext {
  navigate: NavigateFunction;
  /** Closes the palette; focus returns to where it was before the palette opened. */
  close: () => void;
  /** Polite screen-reader and visible confirmation in the palette footer, e.g. "Copied". */
  announce: (message: string) => void;
}

export interface PaletteCommand {
  id: string;
  label: string;
  group: CommandGroup;
  /** Extra words the fuzzy filter matches against, e.g. synonyms or the route path. */
  keywords?: readonly string[];
  /**
   * Secondary text shown on the right of the row and matched by the filter. Pass a
   * function for text that ages, such as relative times; the palette calls it on render.
   */
  detail?: string | (() => string);
  /** Shortcut chip text, e.g. "G R" or "⌘K". Display only. */
  shortcut?: string;
  icon?: LucideIcon;
  /** Status dot shown before the label (recent runs). */
  status?: "ok" | "error" | "live" | "cancelled" | "unknown";
  /** Lower numbers sort first within a group when there is no query. Defaults to 0. */
  order?: number;
  /** Return false to hide the command right now (for example, when there is no open run). */
  when?: () => boolean;
  /** Keep the palette open after running, for commands that report a result or close themselves. */
  keepOpen?: boolean;
  run: (context: CommandContext) => void | Promise<void>;
}

export interface ShortcutDefinition {
  id: string;
  /**
   * Space-separated chord sequence. Each chord is optional "mod+", "shift+", "alt+"
   * prefixes plus a key from KeyboardEvent.key, lower-cased: "mod+k", "?", "g r", "j", "escape".
   * "mod" is Command on macOS and Control elsewhere. Plain-key chords never fire with
   * Control, Command or Alt held.
   */
  keys: string;
  description: string;
  /** Heading in the shortcut sheet, e.g. "Global", "Runs list", "Run detail". */
  scope: string;
  /** Allow while focus is in a text field. Only modified chords should set this. */
  allowInInputs?: boolean;
  /**
   * Allow while a pass-through dialog (marked data-shortcut-passthrough, e.g. the compact
   * Ask pane) is open. Modal dialogs such as the palette always block every shortcut.
   */
  allowInDialogs?: boolean;
  when?: () => boolean;
  /** Omit to document a shortcut that another component already handles. */
  handler?: (event: KeyboardEvent) => void;
}

type Listener = () => void;

function createStore<T extends { id: string }>() {
  const entries = new Map<string, T>();
  const listeners = new Set<Listener>();
  let snapshot: readonly T[] = [];
  const emit = () => {
    snapshot = [...entries.values()];
    for (const listener of listeners) listener();
  };
  return {
    add: (items: readonly T[]): (() => void) => {
      for (const item of items) entries.set(item.id, item);
      emit();
      return () => {
        let changed = false;
        for (const item of items) {
          if (entries.get(item.id) === item) { entries.delete(item.id); changed = true; }
        }
        if (changed) emit();
      };
    },
    list: () => snapshot,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const commandStore = createStore<PaletteCommand>();
const shortcutStore = createStore<ShortcutDefinition>();

export function registerCommands(commands: readonly PaletteCommand[]): () => void {
  return commandStore.add(commands);
}

export function registerShortcuts(shortcuts: readonly ShortcutDefinition[]): () => void {
  return shortcutStore.add(shortcuts);
}

export function commandDetail(command: PaletteCommand): string {
  return typeof command.detail === "function" ? command.detail() : command.detail ?? "";
}

export function listCommands(): readonly PaletteCommand[] {
  return commandStore.list();
}

export function listShortcuts(): readonly ShortcutDefinition[] {
  return shortcutStore.list();
}

export function useCommands(): readonly PaletteCommand[] {
  return useSyncExternalStore(commandStore.subscribe, commandStore.list, commandStore.list);
}

export function useShortcuts(): readonly ShortcutDefinition[] {
  return useSyncExternalStore(shortcutStore.subscribe, shortcutStore.list, shortcutStore.list);
}

/**
 * Registers commands for the lifetime of the calling component. `commands` may be a
 * fresh array every render: entries are re-registered only when `deps` change, and
 * `run`/`when` always call the latest closure.
 */
export function useRegisterCommands(commands: readonly PaletteCommand[], deps: readonly unknown[]): void {
  const latest = useRef(commands);
  latest.current = commands;
  useEffect(() => registerCommands(latest.current.map(command => ({
    ...command,
    when: command.when && (() => latest.current.find(entry => entry.id === command.id)?.when?.() ?? false),
    run: (context: CommandContext) => (latest.current.find(entry => entry.id === command.id) ?? command).run(context),
  }))), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Same contract as useRegisterCommands, for shortcuts. Handlers always see the latest closure. */
export function useRegisterShortcuts(shortcuts: readonly ShortcutDefinition[], deps: readonly unknown[]): void {
  const latest = useRef(shortcuts);
  latest.current = shortcuts;
  useEffect(() => registerShortcuts(latest.current.map(shortcut => ({
    ...shortcut,
    when: shortcut.when && (() => latest.current.find(entry => entry.id === shortcut.id)?.when?.() ?? false),
    handler: shortcut.handler && ((event: KeyboardEvent) => latest.current.find(entry => entry.id === shortcut.id)?.handler?.(event)),
  }))), deps); // eslint-disable-line react-hooks/exhaustive-deps
}
