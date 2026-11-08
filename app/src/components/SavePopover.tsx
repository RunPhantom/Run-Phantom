import { useEffect, useRef, useState } from "react";
import { Check, Folder, FolderPlus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { fieldClassName } from "@/components/ui/input";
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
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] transition-colors duration-250 ease-standard",
        selected ? "bg-rp-wash font-medium text-rp-blue" : "text-rp-ink hover:bg-rp-row-hover",
      )}
      onClick={() => onSelect(value)}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {selected && <Check aria-hidden="true" className="size-3.5 text-rp-blue" />}
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
      className="rp-pop fixed z-[9999] space-y-0.5 rounded-md border border-rp-line bg-rp-surface p-1.5 shadow-e3"
      role="dialog"
      aria-label={isSaved ? "Move saved run to folder" : "Save run to folder"}
      style={{ width: "min(240px, calc(100vw - 32px))" }}
    >
      <div className="rp-eyebrow px-2 pb-1 pt-1">
        {isSaved ? "Move to folder" : "Save to folder"}
      </div>
      <FolderRow
        label="Unfiled"
        value={null}
        selected={normalizedCurrent === null}
        icon={<Folder aria-hidden="true" className="size-3.5 text-rp-ink-muted" />}
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
        <div className="flex gap-1.5 p-1">
          <input autoFocus aria-label="New folder name" className={cn(fieldClassName, "h-8 flex-1 px-2 text-[13px]")}
            placeholder="Folder name..." value={newFolder} onChange={e => setNewFolder(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && newFolder.trim()) { addFolder(newFolder.trim()); onSave(newFolder.trim()); onClose(); } }} />
          <button className={buttonVariants({ variant: "primary", size: "sm" })}
            onClick={() => { if (newFolder.trim()) { addFolder(newFolder.trim()); onSave(newFolder.trim()); onClose(); } }}>
            {isSaved ? "Move" : "Save"}
          </button>
        </div>
      ) : (
        <button className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] text-rp-ink-muted transition-colors duration-250 ease-standard hover:bg-rp-row-hover hover:text-rp-ink"
          onClick={() => setShowNew(true)}>
          <FolderPlus aria-hidden="true" className="size-3.5" /> New folder…
        </button>
      )}
      {onUnsave && (
        <>
          <div className="-mx-1.5 my-1 border-t border-rp-line-muted" />
          <button className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] text-rp-danger transition-colors duration-250 ease-standard hover:bg-rp-danger-soft"
            onClick={() => { onUnsave(); onClose(); }}>
            <Trash2 aria-hidden="true" className="size-3.5" /> Remove from saved
          </button>
        </>
      )}
    </div>
  );
}
