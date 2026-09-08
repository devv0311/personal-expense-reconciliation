"use client";

import Link from "next/link";
import { DiscrepancyList } from "@/components/discrepancy-list";
import { Money } from "@/components/money";
import { PageHeader, Section } from "@/components/page-header";
import { AccountWaterfalls } from "@/components/reconciliation/account-waterfall";
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
import { usePeople, useReconciliationRun } from "@/lib/queries";

/**
 * One reconciliation run, in the order a reader needs it:
 *
 * 1. **The outflow identity** (ADR-0016) — how much of what left the accounts the ledger has
 *    explained. One hero figure, `ledgerUnexplainedTotal`.
 * 2. **The cash identity** (ADR-0017) — whether each account's statement actually closes.
 * 3. **Splitwise** — what the external ledger said at the time, and where it disagreed.
 *
 * The two identities are deliberately independent and neither is derived from the other, so
 * they get their own sections rather than being blended into one score. A run can explain every
 * rupee of outflow and still fail to close a statement, and both facts matter.
 */
export function ReconciliationRunDetail({ id }: { id: string }) {
  const runQuery = useReconciliationRun(id);
  const people = usePeople();

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
    <div className="flex flex-col gap-10">
      <PageHeader
        title={formatPeriod(run.periodStart, run.periodEnd)}
        description={`Run ${formatDateTime(run.runAt)}`}
      />

      <section aria-labelledby="totals-heading" className="max-w-md">
        <h2 id="totals-heading" className="sr-only">
          Totals
        </h2>
        <ReconciliationTotals totals={run.totals} />
        <p className="mt-4 text-meta text-ink-muted">
          Drill through:{" "}
          <Link href="/review" className="text-accent underline-offset-2 hover:underline">
            payments with no explanation
          </Link>
          {" · "}
          <Link href="/expenses" className="text-accent underline-offset-2 hover:underline">
            the expense ledger
          </Link>
        </p>
      </section>

      <Section
        title="Does each account close?"
        headingId="cash-heading"
        description="A second, independent identity: the statement's opening balance, every movement on it gross and counted once, and the closing balance it should have reached."
      >
        <AccountWaterfalls
          reconciliationRunId={id}
          periodStart={run.periodStart}
          periodEnd={run.periodEnd}
        />
      </Section>

      <Section
        title="Splitwise"
        headingId="discrepancies-heading"
        description="What the external ledger reported when this run happened, and where it disagreed with this one."
        actions={
          <Link
            href="/splitwise"
            className="text-meta text-accent underline-offset-2 hover:underline"
          >
            Audit findings
          </Link>
        }
      >
        <DiscrepancyList discrepancies={run.discrepancies} people={people.data} />
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
      </Section>
    </div>
  );
}
