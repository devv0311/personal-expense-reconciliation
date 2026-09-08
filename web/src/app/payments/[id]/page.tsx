import { BackLink } from "@/components/back-link";
import { PaymentContext } from "@/components/evidence/payment-context";
import { PaymentHistory } from "@/components/history/payment-history";
import { PaymentDecisions } from "@/components/payments/payment-decisions";

/**
 * One movement: what the ledger knows about it, and the two interpretations a person records
 * against it.
 *
 * The context at the top is a read — evidence, links, what explains the money. The decisions
 * below it are writes, each behind its own dialog stating what it will do. The trail at the
 * end is the append-only log: who decided what, when, and why.
 */
export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-8">
      <BackLink href="/payments">Payments</BackLink>
      <PaymentContext paymentId={id} />
      <PaymentDecisions paymentId={id} />
      <PaymentHistory paymentId={id} />
    </div>
  );
}
