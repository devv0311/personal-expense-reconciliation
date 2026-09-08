"use client";

import { AuditTrail } from "@/components/history/audit-trail";
import { Section } from "@/components/page-header";
import { ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { usePaymentHistory } from "@/lib/queries";

/**
 * Every decision recorded against one movement.
 *
 * This is what makes an interpretation answerable: a counterparty set, a cash-flow role
 * proposed and approved, a link accepted, a duplicate confirmed — each with its actor, its
 * reason and what it changed. Nothing in this repository can write to the log and nothing can
 * amend it (`invariants.md` #22), which is what makes reading it worth anything.
 */
export function PaymentHistory({ paymentId }: { paymentId: string }) {
  const history = usePaymentHistory(paymentId);

  return (
    <Section
      title="Everything recorded about it"
      headingId="payment-history"
      description="Who decided what, when, and why. Append-only: no screen in this product can amend a line of it."
    >
      {history.isPending && (
        <LoadingStatus label="Loading this movement's history…">
          <TableSkeleton columns={2} rows={3} />
        </LoadingStatus>
      )}
      {history.isError && (
        <ErrorBlock error={history.error} onRetry={() => void history.refetch()} />
      )}
      {history.isSuccess && <AuditTrail events={history.data.events} />}
    </Section>
  );
}
