import { ApiError } from "@/lib/api";

/** Every page composes these three explicitly rather than through a generic wrapper, so each
 * state's copy can be specific to what's actually loading/missing/wrong. */

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div role="status" className="py-10 text-[14px] text-ink-muted">
      {label}
    </div>
  );
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
    <div className="rounded-sm border border-debit/30 bg-debit-bg px-4 py-3 text-[14px] text-debit">
      <p>{describeError(error)}</p>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-[13px] font-medium underline underline-offset-2"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyBlock({ children }: { children: React.ReactNode }) {
  return <div className="py-10 text-[14px] text-ink-muted">{children}</div>;
}
