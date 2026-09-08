import { BackLink } from "@/components/back-link";
import { PaymentContext } from "@/components/evidence/payment-context";
import { PaymentDecisions } from "@/components/payments/payment-decisions";

/**
 * One movement: what the ledger knows about it, and the two interpretations a person records
 * against it.
 *
 * The context above is a read — evidence, links, what explains the money. The decisions below
 * are writes, each behind its own dialog stating what it will do.
 */
export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-8">
      <BackLink href="/payments">Payments</BackLink>
      <PaymentContext paymentId={id} />
      <PaymentDecisions paymentId={id} />
    </div>
  );
}
