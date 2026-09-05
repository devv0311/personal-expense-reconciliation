import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Every page composes these explicitly rather than through a generic wrapper, so each state's
 * copy and shape can be specific to what's actually loading/missing/wrong. */

/** Announces `label` to assistive tech once, then hides the skeleton shape from it — a screen
 * reader should hear "loading past runs", not read out a stack of decorative bars. */
export function LoadingStatus({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

/** A skeleton shaped like the table it's about to become: `columns` bars per row, the first
 * narrower (most tables lead with a short label/date column, not a long one). */
export function TableSkeleton({ rows = 4, columns }: { rows?: number; columns: number }) {
  return (
    <div className="flex flex-col gap-4 py-2">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-6">
          {Array.from({ length: columns }, (_, col) => (
            <Skeleton key={col} className={cn("h-3.5", col === 0 ? "w-2/5" : "flex-1")} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** One form-control-shaped bar — two side by side stand in for the person pickers while people
 * load, matching their actual footprint instead of a generic spinner. */
export function FieldSkeleton() {
  return <Skeleton className="h-9 w-[180px]" />;
}

/** Shaped like the one hero figure a screen is built around (a balance headline, a totals
 * figure) — see `web/Design.md` "Typography" for why that figure gets its own size at all. */
export function FigureSkeleton() {
  return <Skeleton className="h-9 w-48" />;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "NETWORK_ERROR") return error.message;
    return `${error.message} (${error.code})`;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert variant="destructive" role="alert">
      <p>{describeError(error)}</p>
      {onRetry !== undefined && (
        <Button variant="link" size="sm" onClick={onRetry} className="mt-2 text-debit">
          Try again
        </Button>
      )}
    </Alert>
  );
}

export function EmptyBlock({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-sm border border-dashed border-rule-strong px-4 py-8 text-center text-body text-ink-muted">
      {children}
    </div>
  );
}
