import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const primarySolid = "rp-primary-control border border-rp-blue bg-rp-blue text-white hover:border-rp-blue-hover hover:bg-rp-blue-hover active:border-rp-blue-active active:bg-rp-blue-active";
const secondaryHairline = "border border-rp-line bg-white text-rp-ink hover:border-rp-wash-border hover:bg-rp-wash";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium transition-[background-color,border-color,color] duration-250 ease-standard focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: primarySolid,
        primary: primarySolid,
        secondary: secondaryHairline,
        outline: secondaryHairline,
        ghost: "border border-transparent text-rp-ink-soft hover:bg-rp-row-hover hover:text-rp-ink",
        destructive: "rp-primary-control border border-rp-danger bg-rp-danger text-white hover:border-rp-danger-hover hover:bg-rp-danger-hover",
        "destructive-outline": "border border-rp-line bg-white text-rp-danger hover:border-rp-danger-border hover:bg-rp-danger-soft",
        link: "h-auto border-0 px-0 text-rp-blue underline-offset-4 hover:text-rp-blue-hover hover:underline",
      },
      size: {
        default: "h-9 px-4 text-[13px] leading-5",
        sm: "h-8 px-3 text-xs",
        lg: "h-11 px-5 text-sm",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    compoundVariants: [
      { variant: "link", className: "h-auto px-0" },
    ],
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
  loading?: boolean;
}

function Spinner() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="animate-spin motion-reduce:animate-none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size, className }));
    if (asChild) {
      return <Slot className={classes} ref={ref} {...props}>{children}</Slot>;
    }
    return (
      <button
        className={classes}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && <Spinner />}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
