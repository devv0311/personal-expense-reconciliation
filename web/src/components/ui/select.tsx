import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A styled native `<select>`, deliberately not a headless-listbox rebuild: every use of it in
 * this app is a short, flat, single-select list (a person, a state) — exactly the shape a real
 * `<select>` already handles correctly, including the platform picker UX on a phone that a
 * rebuilt one would have to reinvent. `appearance-none` strips the OS chrome that made the old
 * control look dated; the chevron beside it is drawn back in, once, consistently.
 */
export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        className={cn(
          "h-9 w-full appearance-none rounded-sm border border-rule bg-panel py-1.5 pr-8 pl-2.5 text-body text-ink",
          "hover:border-rule-strong",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        aria-hidden="true"
        width="10"
        height="6"
        viewBox="0 0 10 6"
        fill="none"
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-faint"
      >
        <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}
