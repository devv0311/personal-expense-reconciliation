import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** A shimmer block shaped by the caller's `className` to match the final layout — never a
 * generic spinner. Already still under `prefers-reduced-motion` via globals.css's global rule,
 * which forces every animation's duration to ~0. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-sm bg-rule/60", className)}
      {...props}
    />
  );
}
