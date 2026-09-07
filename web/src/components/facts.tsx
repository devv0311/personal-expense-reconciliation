import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The zero-clutter inspector layout: a label column and a value column, no boxes.
 *
 * `Design.md` is explicit that a card exists only where grouping communicates something real,
 * so an inspector is a `<dl>` with hairlines rather than a stack of panels. Values that are
 * figures pass `mono` so they stay tabular alongside every other number in the product.
 */
export function Facts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("flex flex-col", className)}>{children}</dl>;
}

export function Fact({
  label,
  children,
  mono = false,
  hint,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule py-2 last:border-b-0">
      <dt className="text-meta text-ink-muted">
        {label}
        {hint !== undefined && <span className="block text-micro text-ink-faint">{hint}</span>}
      </dt>
      <dd className={cn("min-w-0 max-w-full text-body text-ink", mono && "tabular font-mono")}>
        {children}
      </dd>
    </div>
  );
}

/** A value the ledger does not have. Never rendered as `0`, `—` alone, or an empty string. */
export function UnknownValue({ children = "Not recorded" }: { children?: ReactNode }) {
  return <span className="text-ink-faint italic">{children}</span>;
}
