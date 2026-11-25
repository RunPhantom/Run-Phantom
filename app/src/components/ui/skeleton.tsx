import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("rp-skeleton rounded-control motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Skeleton };
