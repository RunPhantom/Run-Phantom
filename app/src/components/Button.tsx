export function Button({ children, onClick, className = "" }: {
  children: React.ReactNode; onClick?: () => void; className?: string;
}) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-control border border-rp-line bg-white px-2.5 py-1.5 text-xs font-medium text-rp-ink transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash ${className}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
