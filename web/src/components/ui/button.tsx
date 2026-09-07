import { type VariantProps, cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  // Focus ring comes from the app-wide `:focus-visible` rule in globals.css, same as every
  // native control — no per-component outline utility needed.
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-body font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-ink hover:bg-accent/90",
        outline: "border border-rule bg-panel text-ink hover:bg-accent-bg",
        ghost: "text-ink-muted hover:bg-accent-bg hover:text-ink",
        link: "text-accent underline-offset-2 hover:underline",
      },
      size: {
        default: "min-h-11 px-4 py-2 sm:min-h-10",
        sm: "min-h-11 px-3 py-2 text-meta sm:min-h-8 sm:py-1",
        link: "h-auto p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
