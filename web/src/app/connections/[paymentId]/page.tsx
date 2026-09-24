import { BackLink } from "@/components/back-link";
import { Connection } from "@/components/connections/connection";
import { PaymentHistory } from "@/components/history/payment-history";

/**
 * One financial event: what happened, what records say so, what has been connected, and what
 * still needs a person.
 *
 * `/payments/[id]` is still there, still the specialist workspace, and still linked from the
 * Details disclosure below — this is the outcome-first way in, not a replacement for it. The
 * append-only trail is at the foot, where it has always been.
 */
export default async function ConnectionPage({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const { paymentId } = await params;
  return (
    <div className="flex flex-col gap-8">
      <BackLink href="/needs-attention">Needs attention</BackLink>
      <Connection paymentId={paymentId} />
      <PaymentHistory paymentId={paymentId} />
    </div>
  );
}
