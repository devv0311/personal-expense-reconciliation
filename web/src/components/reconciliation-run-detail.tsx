"use client";

import { DiscrepancyList } from "@/components/discrepancy-list";
import { Money } from "@/components/money";
import { ReconciliationTotals } from "@/components/reconciliation-totals";
import { ErrorBlock, FigureSkeleton, LoadingStatus, TableSkeleton } from "@/components/status";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatPeriod } from "@/lib/dates";
import { useReconciliationRun } from "@/lib/queries";

export function ReconciliationRunDetail({ id }: { id: string }) {
  const runQuery = useReconciliationRun(id);

  if (runQuery.isPending) {
    return (
      <LoadingStatus label="Loading this run…">
        <div className="flex flex-col gap-8">
          <FigureSkeleton />
          <TableSkeleton rows={2} columns={3} />
        </div>
      </LoadingStatus>
    );
  }
  if (runQuery.isError) {
    return <ErrorBlock error={runQuery.error} onRetry={() => void runQuery.refetch()} />;
  }

  const run = runQuery.data;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-h1 font-medium text-ink">
          {formatPeriod(run.periodStart, run.periodEnd)}
        </h1>
        <p className="mt-1 text-meta text-ink-muted">Run {formatDateTime(run.runAt)}</p>
      </div>

      <section aria-labelledby="totals-heading" className="max-w-md">
        <h2 id="totals-heading" className="sr-only">
          Totals
        </h2>
        <ReconciliationTotals totals={run.totals} />
      </section>

      <section aria-labelledby="discrepancies-heading">
        <h2 id="discrepancies-heading" className="mb-3 text-emphasis font-medium text-ink">
          Splitwise
        </h2>
        <DiscrepancyList discrepancies={run.discrepancies} />
        {run.splitwiseBalancesSnapshot !== null && run.splitwiseBalancesSnapshot.length > 0 && (
          <div className="mt-4">
            <h3 className="text-meta text-ink-muted">Reported at the time of this run</h3>
            <Table className="mt-2 max-w-xs">
              <TableCaption>Splitwise balances at the time of this run</TableCaption>
              <TableBody>
                {run.splitwiseBalancesSnapshot.map((entry) => (
                  <TableRow key={entry.splitwiseUserId}>
                    <TableHead scope="row" className="py-1.5">
                      {entry.splitwiseUserId}
                    </TableHead>
                    <TableCell className="text-right">
                      <Money paise={entry.netBalance} tone="neutral" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
