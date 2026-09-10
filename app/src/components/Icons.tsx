export function Chevron({ open, size = 10 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
      style={{ transition: "transform .15s", transform: open ? "rotate(90deg)" : "" }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function Check() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--rp-success)"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function Spinner({ style }: { style?: React.CSSProperties } = {}) {
  return (
    <span className="inline-grid grid-cols-3 gap-[1.5px] size-[12px]" style={style}>
      {[0,1,2,3,4,5,6,7,8].map(i => (
        <span key={i} className="rounded-[1px]"
          style={{
            background: "currentColor",
            animation: "grid-dot-pulse 1.2s ease-in-out infinite",
            animationDelay: `${(i % 3) * 0.1 + Math.floor(i / 3) * 0.1}s`,
          }} />
      ))}
    </span>
  );
}

export function AlertCircle() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--rp-danger)"
      strokeWidth={2.5} strokeLinecap="round">
      <circle cx={12} cy={12} r={10} />
      <line x1={12} y1={8} x2={12} y2={12} />
      <line x1={12} y1={16} x2={12.01} y2={16} />
    </svg>
  );
}

export function Dots() {
  return (
    <span className="inline-flex gap-1 ml-1">
      {[0, 1, 2].map(i => (
        <span key={i} className="size-1.5 rounded-full"
          style={{ background: "var(--rp-ink-muted)", animation: "bounce-dot 1.4s infinite ease-in-out", animationDelay: `${i * 0.16}s` }} />
      ))}
    </span>
  );
}
