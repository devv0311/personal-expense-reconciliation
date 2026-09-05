import { type VariantProps, cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Two variants, both load-bearing: `destructive` for a system/network failure, `attention` for
 * a domain finding that needs a look but isn't wrong (a Splitwise mismatch, not a crash) — never
 * the same color, so the two are never mistaken for each other (`web/Design.md` "Color"). */
const alertVariants = cva("rounded-sm border px-4 py-3 text-body", {
  variants: {
    variant: {
      destructive: "border-debit/30 bg-debit-bg text-debit",
      attention: "border-attention/30 bg-attention-bg text-attention",
    },
  },
  defaultVariants: { variant: "destructive" },
});

/** No default `role` here: an `ErrorBlock` passes `role="alert"` (one assertive live region for
 * a real failure); a list of discrepancy findings must not, or a screen reader announces every
 * item in the list as an interruption the moment it renders. */
export function Alert({
  className,
  variant,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-1 text-ink-muted [&_p]:mt-1", className)} {...props} />;
}
