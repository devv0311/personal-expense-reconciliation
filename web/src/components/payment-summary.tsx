import Link from "next/link";
import { Money } from "@/components/money";
import { Fact, Facts } from "@/components/facts";
import { formatDateTime } from "@/lib/dates";
import { sentenceCase } from "@/lib/labels";
import type { ReviewPaymentView } from "@/lib/types";

/**
 * One payment, as every review surface shows it.
 *
 * `rawDescription` is rendered verbatim and labelled "Narration" — it is what the bank wrote,
 * and this app never replaces it with an interpretation (`invariants.md` #2/#4). What the
 * attached evidence says about it lives one click away, on the payment's own context screen.
 *
 * The amount is toned `neutral`: a debit is not bad news and a credit is not good news. Only a
 * verdict about the money — unexplained, settled — earns a color (`Design.md`, "Color").
 */
export function PaymentSummary({
  payment,
  caption,
}: {
  payment: ReviewPaymentView;
  caption?: string;
}) {
  return (
    <div>
      {caption !== undefined && <p className="mb-1 text-micro text-ink-faint">{caption}</p>}
      <Facts>
        <Fact label="Amount" mono>
          <Money paise={payment.amount} />
          <span className="ml-2 text-meta text-ink-muted">{sentenceCase(payment.direction)}</span>
        </Fact>
        <Fact label="Narration" hint="Exactly as the bank wrote it">
          <span className="font-mono text-meta break-all">{payment.description}</span>
        </Fact>
        <Fact label="Occurred" mono>
          {formatDateTime(payment.occurredAt)}
        </Fact>
        <Fact label="Counterparty">{sentenceCase(payment.counterpartyType)}</Fact>
        <Fact label="State">{sentenceCase(payment.state)}</Fact>
        <Fact label="Re-attached context">
          <Link
            href={`/payments/${payment.paymentId}`}
            className="text-accent underline underline-offset-2"
          >
            What the evidence says
          </Link>
        </Fact>
      </Facts>
    </div>
  );
}
