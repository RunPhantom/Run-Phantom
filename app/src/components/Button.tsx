import { C } from "../utils/colors";

export function Button({ children, onClick, className = "" }: {
  children: React.ReactNode; onClick?: () => void; className?: string;
}) {
  return (
    <button
      className={`text-[11px] font-mono font-medium px-2.5 py-1.5 rounded transition-colors ${className}`}
      style={{ color: C.fg4, background: "var(--rp-surface-raised)", border: "1px solid var(--rp-border)" }}
      onMouseEnter={e => { e.currentTarget.style.background = "var(--rp-surface-selected)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "var(--rp-surface-raised)"; }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
