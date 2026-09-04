"use client";

import { DiscrepancyList } from "@/components/discrepancy-list";
import { Money } from "@/components/money";
import { ReconciliationTotals } from "@/components/reconciliation-totals";
import { ErrorBlock, LoadingBlock } from "@/components/status";
import { formatDateTime, formatPeriod } from "@/lib/dates";
import { useReconciliationRun } from "@/lib/queries";

export function ReconciliationRunDetail({ id }: { id: string }) {
  const runQuery = useReconciliationRun(id);

  if (runQuery.isPending) return <LoadingBlock label="Loading this run…" />;
  if (runQuery.isError) {
    return <ErrorBlock error={runQuery.error} onRetry={() => void runQuery.refetch()} />;
  }

  const run = runQuery.data;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-[20px] font-medium text-ink">
          {formatPeriod(run.periodStart, run.periodEnd)}
        </h1>
        <p className="mt-1 text-[13px] text-ink-muted">Run {formatDateTime(run.runAt)}</p>
      </div>

      <section
        aria-labelledby="totals-heading"
        className="max-w-md rounded-sm border border-rule p-5"
      >
        <h2 id="totals-heading" className="mb-3 text-[15px] font-medium text-ink">
          Totals
        </h2>
        <ReconciliationTotals totals={run.totals} />
      </section>

      <section aria-labelledby="discrepancies-heading">
        <h2 id="discrepancies-heading" className="mb-3 text-[15px] font-medium text-ink">
          Splitwise
        </h2>
        <DiscrepancyList discrepancies={run.discrepancies} />
        {run.splitwiseBalancesSnapshot !== null && run.splitwiseBalancesSnapshot.length > 0 && (
          <div className="mt-4">
            <h3 className="text-[13px] text-ink-muted">Reported at the time of this run</h3>
            <table className="mt-2 w-full max-w-xs text-[14px]">
              <caption className="sr-only">Splitwise balances at the time of this run</caption>
              <tbody>
                {run.splitwiseBalancesSnapshot.map((entry) => (
                  <tr key={entry.splitwiseUserId} className="border-b border-rule last:border-b-0">
                    <th scope="row" className="py-1.5 text-left font-normal text-ink-muted">
                      {entry.splitwiseUserId}
                    </th>
                    <td className="py-1.5 text-right">
                      <Money paise={entry.netBalance} tone="neutral" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
