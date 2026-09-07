"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { RunReconciliationForm } from "@/components/run-reconciliation-form";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatPeriod } from "@/lib/dates";
import { useReconciliationRuns } from "@/lib/queries";

export default function ReconciliationPage() {
  const router = useRouter();
  const runsQuery = useReconciliationRuns(20);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Reconciliation"
        description="Two independent checks over one period: how much of what left your accounts the ledger has explained, and whether each account's statement actually closes. Neither is derived from the other."
      />

      <section aria-labelledby="run-heading">
        <h2 id="run-heading" className="sr-only">
          Run a reconciliation
        </h2>
        <RunReconciliationForm onRun={(id) => router.push(`/reconciliation/${id}`)} />
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="mb-3 text-emphasis font-medium text-ink">
          History
        </h2>
        {runsQuery.isPending && (
          <LoadingStatus label="Loading past runs…">
            <TableSkeleton columns={3} />
          </LoadingStatus>
        )}
        {runsQuery.isError && (
          <ErrorBlock error={runsQuery.error} onRetry={() => void runsQuery.refetch()} />
        )}
        {runsQuery.isSuccess && runsQuery.data.length === 0 && (
          <EmptyBlock>
            No reconciliation has been run yet. Choose a period above and run the first one.
          </EmptyBlock>
        )}
        {runsQuery.isSuccess && runsQuery.data.length > 0 && (
          <>
            <Table className="hidden min-w-[480px] sm:table">
              <TableCaption>Past reconciliation runs, newest first</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Period</TableHead>
                  <TableHead scope="col" className="text-right">
                    Not yet explained
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Discrepancies
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runsQuery.data.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="whitespace-nowrap">
                      <Link
                        href={`/reconciliation/${run.id}`}
                        className="text-accent underline-offset-2 hover:underline"
                      >
                        {formatPeriod(run.periodStart, run.periodEnd)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        paise={run.totals.ledgerUnexplainedTotal}
                        tone={run.totals.ledgerUnexplainedTotal === "0" ? "credit" : "debit"}
                      />
                    </TableCell>
                    <TableCell className="text-right text-ink-muted">
                      {run.discrepancies.length === 0 ? "—" : run.discrepancies.length}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <ul className="flex flex-col gap-2 sm:hidden">
              {runsQuery.data.map((run) => (
                <li key={run.id} className="border-b border-rule py-3 last:border-b-0">
                  <Link
                    href={`/reconciliation/${run.id}`}
                    className="text-accent underline-offset-2 hover:underline"
                  >
                    {formatPeriod(run.periodStart, run.periodEnd)}
                  </Link>
                  <dl className="mt-1.5 flex justify-between text-meta text-ink-muted">
                    <div className="flex gap-1.5">
                      <dt>Not yet explained</dt>
                      <dd>
                        <Money
                          paise={run.totals.ledgerUnexplainedTotal}
                          tone={run.totals.ledgerUnexplainedTotal === "0" ? "credit" : "debit"}
                        />
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt>Discrepancies</dt>
                      <dd>{run.discrepancies.length === 0 ? "—" : run.discrepancies.length}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
