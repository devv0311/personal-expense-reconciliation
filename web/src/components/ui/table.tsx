import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Every table gets the same horizontal-scroll-on-overflow container for free — pass a
 * `min-w-[...]` in `className` for a dense table the way the callers of this component already
 * did by hand before; narrow tables (e.g. `ReconciliationTotals`) simply never trigger it. */
export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full text-body", className)} {...props} />
    </div>
  );
}

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption className={cn("sr-only", className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={className} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={className} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b border-rule last:border-b-0", className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn("py-2 text-left text-meta font-normal text-ink-muted", className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("py-2.5", className)} {...props} />;
}
