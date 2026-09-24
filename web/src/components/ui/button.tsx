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
      /*
        `default` is 48px (`h-12`), which is the comfortable-tap bar the 2026-09-19 design pass
        set — these are the buttons that complete a decision about money, and they should not
        feel like a toolbar. `sm` is 40px: still well over the 24px WCAG 2.5.8 minimum, and it
        is what an inline secondary action ("Show these 12", "Choose another category") uses so
        a row of them does not shout over the primary action beside it.
      */
      size: {
        default: "h-12 px-5",
        sm: "h-10 px-3.5 text-meta",
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
