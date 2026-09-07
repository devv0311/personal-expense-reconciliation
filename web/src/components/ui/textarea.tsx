import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A styled native `<textarea>` — the reason field every recorded decision carries.
 *
 * Same reasoning as `Select`/`Input`: nothing about a multi-line text field needs behavior HTML
 * does not already provide, so it is styled rather than rebuilt (`Design.md`, "Forms").
 */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-20 w-full rounded-sm border border-rule bg-panel px-2.5 py-2 text-body text-ink placeholder:text-ink-faint",
        "hover:border-rule-strong",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
