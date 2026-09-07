import { BackLink } from "@/components/back-link";
import { PaymentContext } from "@/components/evidence/payment-context";

export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-6">
      <BackLink href="/review">Review queue</BackLink>
      <PaymentContext paymentId={id} />
    </div>
  );
}
