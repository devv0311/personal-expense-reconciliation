"use client";

import Link from "next/link";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { ResponsiveTable } from "@/components/responsive-table";
import { formatDate } from "@/lib/dates";
import { useSettlements } from "@/lib/queries";

/**
 * Every repayment on record, newest first.
 *
 * Deliberately a plain list: it says what was recorded and which movement carried it, and
 * computes nothing. What a pair currently owes each other is the balance read, which nets
 * these against the obligations they discharge — a running total here would be a second answer
 * to the one question that read owns.
 */
export function SettlementRegister({ counterpartyPersonId }: { counterpartyPersonId?: string }) {
  const settlements = useSettlements(counterpartyPersonId);

  return (
    <Section
      title="Repayments on record"
      headingId="settlements"
      description="What has actually been paid back, and by which movement. These are already netted into the balance above."
    >
      {settlements.isPending && (
        <LoadingStatus label="Loading repayments…">
          <TableSkeleton columns={3} rows={3} />
        </LoadingStatus>
      )}
      {settlements.isError && (
        <ErrorBlock error={settlements.error} onRetry={() => void settlements.refetch()} />
      )}
      {settlements.isSuccess && settlements.data.settlements.length === 0 && (
        <EmptyBlock>
          Nothing has been recorded as repaid. That is not the same as nothing being owed — it means
          no movement has been marked as settling a balance.
        </EmptyBlock>
      )}
      {settlements.isSuccess && settlements.data.settlements.length > 0 && (
        <ResponsiveTable
          caption="Settlement register"
          minWidth="480px"
          rows={settlements.data.settlements}
          rowKey={(entry) => entry.id}
          columns={[
            {
              key: "when",
              header: "When",
              render: (entry) => (
                <Link
                  href={`/payments/${entry.paymentId}`}
                  className="text-accent underline-offset-2 hover:underline"
                >
                  {formatDate(entry.occurredAt)}
                </Link>
              ),
            },
            {
              key: "who",
              header: "With",
              render: (entry) => (
                <>
                  {entry.counterpartyName}
                  <span className="ml-1.5 text-micro text-ink-faint">
                    {entry.direction === "debit" ? "you paid" : "they paid"}
                  </span>
                </>
              ),
            },
            {
              key: "what",
              header: "Movement",
              render: (entry) => <span className="text-ink-muted">{entry.paymentDescription}</span>,
            },
            {
              key: "amount",
              header: "Amount",
              align: "right",
              render: (entry) => <Money paise={entry.amount} />,
            },
          ]}
        />
      )}
    </Section>
  );
}
