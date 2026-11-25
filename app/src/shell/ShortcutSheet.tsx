import { useMemo } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useShortcuts, type ShortcutDefinition } from "./commands";
import { closeOverlay, restoreOverlayFocus, useShellOverlay } from "./overlays";
import { formatKeys, isMacPlatform } from "./keyboard";

const SCOPE_ORDER = ["Global", "Go to"];

function scopeRank(scope: string): number {
  const index = SCOPE_ORDER.indexOf(scope);
  return index === -1 ? SCOPE_ORDER.length : index;
}

function Keys({ keys, mac }: { keys: string; mac: boolean }) {
  const chords = formatKeys(keys, mac).split(" ");
  return (
    <span className="flex shrink-0 items-center gap-1">
      {chords.map((chord, index) => (
        <span key={index} className="flex items-center gap-1">
          {index > 0 && <span className="text-[11px] text-rp-ink-subtle">then</span>}
          <kbd className="rp-kbd">{chord}</kbd>
        </span>
      ))}
    </span>
  );
}

export function ShortcutSheet() {
  const open = useShellOverlay() === "shortcuts";
  const shortcuts = useShortcuts();
  const mac = useMemo(isMacPlatform, []);
  const scopes = useMemo(() => {
    const grouped = new Map<string, ShortcutDefinition[]>();
    for (const shortcut of shortcuts) {
      const list = grouped.get(shortcut.scope) ?? [];
      list.push(shortcut);
      grouped.set(shortcut.scope, list);
    }
    return [...grouped.entries()].sort(([a], [b]) => scopeRank(a) - scopeRank(b) || a.localeCompare(b));
  }, [shortcuts]);

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) closeOverlay(); }}>
      {open && (
        <DialogContent
          title="Keyboard shortcuts"
          description="Single-key shortcuts pause while you type in a field."
          className="max-w-2xl"
          onCloseAutoFocus={restoreOverlayFocus}
        >
          <div className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {scopes.map(([scope, list]) => (
              <section key={scope} aria-labelledby={`rp-shortcuts-${scope.replace(/\W+/g, "-")}`}>
                <h3 id={`rp-shortcuts-${scope.replace(/\W+/g, "-")}`} className="rp-eyebrow mb-2 text-rp-ink-subtle">{scope}</h3>
                <dl className="divide-y divide-rp-line-muted">
                  {list.map(shortcut => (
                    <div key={shortcut.id} className="flex min-h-9 items-center justify-between gap-4 py-1.5">
                      <dt className="text-[13px] text-rp-ink">{shortcut.description}</dt>
                      <dd><Keys keys={shortcut.keys} mac={mac} /></dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
