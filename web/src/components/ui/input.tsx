import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-9 rounded-sm border border-rule bg-panel px-2.5 text-body text-ink placeholder:text-ink-faint",
        "hover:border-rule-strong",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // Dates are a number-shaped value — mono keeps them tabular, matching every other
        // figure in the ledger (`web/Design.md` "Typography").
        props.type === "date" && "font-mono text-meta",
        className,
      )}
      {...props}
    />
  );
}
