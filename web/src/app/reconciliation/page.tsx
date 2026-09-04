"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Money } from "@/components/money";
import { RunReconciliationForm } from "@/components/run-reconciliation-form";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/status";
import { formatPeriod } from "@/lib/dates";
import { useReconciliationRuns } from "@/lib/queries";

export default function ReconciliationPage() {
  const router = useRouter();
  const runsQuery = useReconciliationRuns(20);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-[20px] font-medium text-ink">Reconciliation</h1>
        <p className="mt-1 max-w-prose text-[14px] text-ink-muted">
          Compares what left your accounts against what the ledger has explained — expenses,
          transfers, investments, and settlements — for a period you choose.
        </p>
      </div>

      <section aria-labelledby="run-heading" className="rounded-sm border border-rule p-5">
        <h2 id="run-heading" className="sr-only">
          Run a reconciliation
        </h2>
        <RunReconciliationForm onRun={(id) => router.push(`/reconciliation/${id}`)} />
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-[15px] font-medium text-ink">
          History
        </h2>
        <div className="mt-3">
          {runsQuery.isPending && <LoadingBlock label="Loading past runs…" />}
          {runsQuery.isError && (
            <ErrorBlock error={runsQuery.error} onRetry={() => void runsQuery.refetch()} />
          )}
          {runsQuery.isSuccess && runsQuery.data.length === 0 && (
            <EmptyBlock>
              No reconciliation has been run yet. Choose a period above and run the first one.
            </EmptyBlock>
          )}
          {runsQuery.isSuccess && runsQuery.data.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-[14px]">
                <caption className="sr-only">Past reconciliation runs, newest first</caption>
                <thead>
                  <tr className="border-b border-rule text-left text-[13px] text-ink-muted">
                    <th scope="col" className="py-2 font-normal">
                      Period
                    </th>
                    <th scope="col" className="py-2 text-right font-normal">
                      Not yet explained
                    </th>
                    <th scope="col" className="py-2 text-right font-normal">
                      Discrepancies
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runsQuery.data.map((run) => (
                    <tr key={run.id} className="border-b border-rule last:border-b-0">
                      <td className="py-2 whitespace-nowrap">
                        <Link
                          href={`/reconciliation/${run.id}`}
                          className="text-accent underline-offset-2 hover:underline"
                        >
                          {formatPeriod(run.periodStart, run.periodEnd)}
                        </Link>
                      </td>
                      <td className="py-2 text-right">
                        <Money
                          paise={run.totals.ledgerUnexplainedTotal}
                          tone={run.totals.ledgerUnexplainedTotal === "0" ? "credit" : "debit"}
                        />
                      </td>
                      <td className="py-2 text-right text-ink-muted">
                        {run.discrepancies.length === 0 ? "—" : run.discrepancies.length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
