import type { CSSProperties } from "react";

// The ring, arrowhead and trail paint with currentColor so a caller can recolour the
// mark through `style.color` (the failed-tool state in MessagePane does this). A
// Tailwind text-colour class loses to the default inline colour below.
const TRAIL = [
  { x: 12.1, y: 20.75, size: 2.4, opacity: 0.8 },
  { x: 15.62, y: 21.36, size: 2.2, opacity: 0.62 },
  { x: 18.96, y: 20.25, size: 2, opacity: 0.46 },
  { x: 21.3, y: 17.72, size: 1.8, opacity: 0.34 },
];

export function RunPhantomMark({
  size = 18,
  className,
  style,
  decorative = false,
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
  decorative?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ color: "var(--rp-mark-accent, #A94304)", ...style }}
      data-runphantom-mark
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "Run Phantom"}
      aria-hidden={decorative ? true : undefined}
    >
      <path
        d="M15.05 1.95Q16 1.6 16.95 1.95L26.75 6.2Q27.85 6.65 27.85 7.85V19.2Q27.85 22.6 17.1 29.9Q16 30.6 14.9 29.9Q4.15 22.6 4.15 19.2V7.85Q4.15 6.65 5.25 6.2Z"
        fill="var(--rp-mark-shield, #EEE7DE)"
        stroke="var(--rp-mark-shield-edge, #D8D0C7)"
        strokeWidth="0.5"
        strokeLinejoin="round"
      />
      <path d="M10.42 19.66A6.9 6.9 0 0 1 20.96 10.81" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path
        d="M22.87 8.97L22.8 14.4L19.06 12.65Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.6"
        strokeLinejoin="round"
      />
      {TRAIL.map(({ x, y, size: side, opacity }) => (
        <rect key={x} x={x} y={y} width={side} height={side} rx="0.3" fill="currentColor" fillOpacity={opacity} />
      ))}
    </svg>
  );
}
