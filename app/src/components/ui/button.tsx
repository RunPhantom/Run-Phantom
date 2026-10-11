import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border border-transparent bg-[color:var(--rp-accent)] text-white hover:bg-[color:var(--rp-accent-hover)] active:bg-[color:var(--rp-accent-active)]",
        ghost: "text-[color:var(--rp-ink-soft)] hover:bg-[color:var(--rp-ink-wash)] hover:text-[color:var(--rp-ink-strong)]",
        outline: "border border-[color:var(--rp-border-strong)] bg-[color:var(--rp-surface)] text-[color:var(--rp-ink-soft)] hover:bg-[color:var(--rp-ink-wash)] hover:text-[color:var(--rp-ink-strong)]",
      },
      size: {
        default: "h-9 px-3 py-1",
        sm: "h-8 rounded-md px-2 text-xs",
        lg: "h-11 rounded-md px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
