"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="period-start">From</Label>
        <Input
          id="period-start"
          type="date"
          value={start}
          max={end}
          onChange={(event) => setStart(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="period-end">To (exclusive)</Label>
        <Input
          id="period-end"
          type="date"
          value={end}
          min={start}
          onChange={(event) => setEnd(event.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? "Running…" : "Run reconciliation"}
      </Button>
      {mutation.isError && (
        <div className="w-full">
          <ErrorBlock error={mutation.error} />
        </div>
      )}
    </form>
  );
}
