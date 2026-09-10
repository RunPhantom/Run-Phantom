import { useEffect, useRef, useState } from "react";
import { Check, Folder, FolderPlus, Trash2 } from "lucide-react";
import { C } from "../utils/colors";
import { addFolder, getFolderColor, useSavedRuns } from "../api/saved-runs";

function FolderRow({ label, value, selected, icon, onSelect }: {
  label: string;
  value: string | null;
  selected: boolean;
  icon: React.ReactNode;
  onSelect: (folder: string | null) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className="w-full text-left px-2 py-1.5 rounded text-[11px] flex items-center gap-1.5 transition-colors rp-hover-wash"
      style={{
        color: selected ? C.fg5 : C.fg3,
        background: selected ? "var(--rp-ink-a06)" : "transparent",
      }}
      onClick={() => onSelect(value)}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {selected && <Check className="size-3" style={{ color: C.green }} />}
    </button>
  );
}

export function SavePopover({ onSave, onClose, anchorRef, currentFolder, onUnsave }: {
  onSave: (folder?: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** When provided, the popover highlights the run's current folder (null/undefined = Unfiled) and switches its header to "Move to folder". */
  currentFolder?: string | null;
  /** When provided, renders a destructive "Remove from saved" row at the bottom. */
  onUnsave?: () => void;
}) {
  const { folders } = useSavedRuns();
  const [newFolder, setNewFolder] = useState("");
  const [showNew, setShowNew] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const isSaved = currentFolder !== undefined;
  const normalizedCurrent = currentFolder ?? null;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
      window.requestAnimationFrame(() => anchorRef.current?.focus());
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose, anchorRef]);

  const selectFolder = (folder: string | null) => {
    onSave(folder ?? undefined);
    onClose();
  };

  return (
    <div
      ref={(el) => {
        popRef.current = el;
        if (!el || !anchorRef.current) return;
        const btn = anchorRef.current.getBoundingClientRect();
        el.style.top = `${btn.bottom + 4}px`;
        el.style.right = `${window.innerWidth - btn.right}px`;
      }}
      className="fixed z-[9999] rounded-lg p-2.5 shadow-xl space-y-1"
      role="dialog"
      aria-label={isSaved ? "Move saved run to folder" : "Save run to folder"}
      style={{ background: C.surface, border: `1px solid ${C.border}`, boxShadow: "var(--rp-e3)", width: "min(220px, calc(100vw - 32px))" }}
    >
      <div className="text-[10px] px-2 py-1" style={{ color: C.fg0 }}>
        {isSaved ? "Move to folder" : "Save to folder"}
      </div>
      <FolderRow
        label="Unfiled"
        value={null}
        selected={normalizedCurrent === null}
        icon={<Folder className="size-3" style={{ color: C.fg0 }} />}
        onSelect={selectFolder}
      />
      {folders.map(f => (
        <FolderRow
          key={f}
          label={f}
          value={f}
          selected={normalizedCurrent === f}
          icon={<div className="size-2 rounded-full shrink-0 ml-0.5" style={{ background: getFolderColor(f) }} />}
          onSelect={selectFolder}
        />
      ))}
      {showNew ? (
        <div className="flex gap-1">
          <input autoFocus aria-label="New folder name" className="flex-1 min-w-0 px-2 py-1 rounded text-[11px] outline-none" style={{ background: "var(--rp-ink-a06)", color: C.fg3, border: "1px solid var(--rp-ink-a10)" }}
            placeholder="Folder name..." value={newFolder} onChange={e => setNewFolder(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && newFolder.trim()) { addFolder(newFolder.trim()); onSave(newFolder.trim()); onClose(); } }} />
          <button className="px-2 py-1 rounded text-[10px] font-medium" style={{ background: "var(--rp-ink-a08)", color: C.fg3 }}
            onClick={() => { if (newFolder.trim()) { addFolder(newFolder.trim()); onSave(newFolder.trim()); onClose(); } }}>
            {isSaved ? "Move" : "Save"}
          </button>
        </div>
      ) : (
        <button className="w-full text-left px-2 py-1.5 rounded text-[11px] flex items-center gap-1.5 transition-colors hover:bg-[color:var(--rp-ink-wash)]" style={{ color: C.fg0 }}
          onClick={() => setShowNew(true)}>
          <FolderPlus className="size-3" /> New folder…
        </button>
      )}
      {onUnsave && (
        <>
          <div className="my-1 -mx-1.5 border-t" style={{ borderColor: "var(--rp-ink-a08)" }} />
          <button className="w-full text-left px-2 py-1.5 rounded text-[11px] flex items-center gap-1.5 transition-colors"
            style={{ color: C.red }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--rp-danger) 10%, white 90%)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            onClick={() => { onUnsave(); onClose(); }}>
            <Trash2 className="size-3" /> Remove from saved
          </button>
        </>
      )}
    </div>
  );
}
