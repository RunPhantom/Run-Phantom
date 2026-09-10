import type { CSSProperties } from "react";

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
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      data-runphantom-mark
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "Run Phantom"}
      aria-hidden={decorative ? true : undefined}
    >
      <path
        d="M12 26V12H26M38 52H52V38"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 42C20 42 20 22 30 22C40 22 39 42 52 42"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <circle cx="30" cy="22" r="5" fill="var(--rp-mark-accent, #C7462D)" />
    </svg>
  );
}
