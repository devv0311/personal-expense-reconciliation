"use client";

import { useState } from "react";
import { ErrorBlock } from "@/components/status";
import { currentMonthPeriod, fromDateInputValue } from "@/lib/dates";
import { useRunReconciliation } from "@/lib/queries";

export function RunReconciliationForm({
  onRun,
}: {
  onRun?: (reconciliationRunId: string) => void;
}) {
  const defaults = currentMonthPeriod();
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);
  const mutation = useRunReconciliation();

  return (
    <form
      className="flex flex-wrap items-end gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate(
          { periodStart: fromDateInputValue(start), periodEnd: fromDateInputValue(end) },
          { onSuccess: (result) => onRun?.(result.reconciliationRunId) },
        );
      }}
    >
      <label className="flex flex-col gap-1 text-[13px] text-ink-muted">
        From
        <input
          type="date"
          value={start}
          max={end}
          onChange={(event) => setStart(event.target.value)}
          className="rounded-sm border border-rule bg-panel px-2 py-1.5 font-mono text-[13px] text-ink"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-ink-muted">
        To (exclusive)
        <input
          type="date"
          value={end}
          min={start}
          onChange={(event) => setEnd(event.target.value)}
          className="rounded-sm border border-rule bg-panel px-2 py-1.5 font-mono text-[13px] text-ink"
          required
        />
      </label>
      <button
        type="submit"
        disabled={mutation.isPending}
        className="rounded-sm bg-accent px-4 py-1.5 text-[14px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {mutation.isPending ? "Running…" : "Run reconciliation"}
      </button>
      {mutation.isError && (
        <div className="w-full">
          <ErrorBlock error={mutation.error} />
        </div>
      )}
    </form>
  );
}
