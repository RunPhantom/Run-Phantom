import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-[color:var(--rp-scrim-soft)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:!animate-none",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    title: React.ReactNode;
    description?: React.ReactNode;
    hideClose?: boolean;
  }
>(({ className, title, description, hideClose = false, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-0 z-50 m-auto h-fit max-h-[calc(100svh-32px)] w-[calc(100vw-32px)] max-w-lg overflow-auto rounded-lg border border-rp-line bg-white p-6 shadow-e4 animate-fade-rise motion-reduce:animate-none",
        className
      )}
      {...props}
    >
      <div className={cn("min-w-0", !hideClose && "pr-10")}>
        <DialogPrimitive.Title className="rp-subsection-title">{title}</DialogPrimitive.Title>
        {description && (
          <DialogPrimitive.Description className="mt-1.5 text-[13px] leading-[1.7] text-rp-ink-muted">{description}</DialogPrimitive.Description>
        )}
      </div>
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-3 top-3 flex size-9 items-center justify-center rounded-control text-rp-ink-muted transition-colors duration-250 ease-standard hover:bg-rp-row-hover hover:text-rp-ink">
          <X aria-hidden="true" className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogFooter };
