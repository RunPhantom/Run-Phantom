import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-control bg-rp-line-muted motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Skeleton };
