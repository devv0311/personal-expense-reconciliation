import Link from "next/link";
import { Money } from "@/components/money";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { cashFlowStateLabel, counterpartyTypeLabel, paymentStateLabel } from "@/lib/labels";
import type { PaymentWorkspaceItem } from "@/lib/types";

/**
 * One movement, rendered the same way wherever a list of movements appears — the workspace,
 * an import batch, a waterfall term's contributing records.
 *
 * The unexplained column is the reason this screen exists, and it is never a bare `₹0.00`:
 * a movement nothing explains shows its whole amount in `debit`, a movement something explains
 * says what explained it, and a confirmed duplicate says that instead of claiming a zero it
 * has not earned (`Design.md`, "never render a verified zero over incomplete evidence").
 */
export function PaymentRows({ payments }: { payments: readonly PaymentWorkspaceItem[] }) {
  return (
    <>
      <Table className="hidden min-w-[720px] sm:table">
        <TableCaption>Cash movements</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Movement</TableHead>
            <TableHead scope="col">Counterparty</TableHead>
            <TableHead scope="col">Interpretation</TableHead>
            <TableHead scope="col" className="text-right">
              Amount
            </TableHead>
            <TableHead scope="col" className="text-right">
              Unexplained
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map((payment) => (
            <TableRow key={payment.id} className="align-top">
              <TableCell>
                <PaymentLink payment={payment} />
                <div className="mt-0.5 text-meta text-ink-muted">
                  {formatDate(payment.occurredAt)} · {payment.accountName}
                </div>
              </TableCell>
              <TableCell>
                <Counterparty payment={payment} />
              </TableCell>
              <TableCell>
                <Interpretation payment={payment} />
              </TableCell>
              <TableCell className="text-right">
                <Money paise={payment.amount} />
                <div className="mt-0.5 text-micro text-ink-faint">
                  {payment.direction === "debit" ? "out" : "in"}
                </div>
              </TableCell>
              <TableCell className="text-right">
                <Unexplained payment={payment} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ul className="flex flex-col gap-3 sm:hidden">
        {payments.map((payment) => (
          <li key={payment.id} className="border-b border-rule pb-3 last:border-b-0">
            <div className="flex items-baseline justify-between gap-3">
              <PaymentLink payment={payment} />
              <span className="text-right whitespace-nowrap">
                <Money paise={payment.amount} />
                <span className="ml-1 text-micro text-ink-faint">
                  {payment.direction === "debit" ? "out" : "in"}
                </span>
              </span>
            </div>
            <div className="mt-1 text-meta text-ink-muted">
              {formatDate(payment.occurredAt)} · {payment.accountName} ·{" "}
              <Counterparty payment={payment} />
            </div>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2 text-meta">
              <Interpretation payment={payment} />
              <Unexplained payment={payment} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function PaymentLink({ payment }: { payment: PaymentWorkspaceItem }) {
  return (
    <Link
      href={`/payments/${payment.id}`}
      className="text-accent underline-offset-2 hover:underline"
    >
      {payment.rawDescription}
    </Link>
  );
}

/** The resolved name when there is one; the type alone when nobody has said who (never a guess). */
function Counterparty({ payment }: { payment: PaymentWorkspaceItem }) {
  if (payment.counterpartyName !== null) {
    return (
      <span>
        {payment.counterpartyName}
        <span className="ml-1 text-micro text-ink-faint">
          {counterpartyTypeLabel(payment.counterpartyType)}
        </span>
      </span>
    );
  }
  return (
    <span className="text-ink-faint italic">{counterpartyTypeLabel(payment.counterpartyType)}</span>
  );
}

/** Both lifecycles at once: a payment has a position in each, and they answer different questions. */
function Interpretation({ payment }: { payment: PaymentWorkspaceItem }) {
  return (
    <span className="text-meta">
      <span className="text-ink">{paymentStateLabel(payment.state)}</span>
      <span className="block text-micro text-ink-faint">
        Cash flow: {cashFlowStateLabel(payment.cashFlowState)}
      </span>
    </span>
  );
}

function Unexplained({ payment }: { payment: PaymentWorkspaceItem }) {
  if (payment.isDuplicateRepresentation) {
    return <span className="text-meta text-ink-faint">Duplicate — counted once already</span>;
  }
  if (payment.unexplainedTotal === "0") {
    return (
      <span className="text-meta text-credit">
        Explained
        <span className="block text-micro text-ink-faint">
          {explanationSummary(payment) ?? "by its cash-flow role"}
        </span>
      </span>
    );
  }
  return <Money paise={payment.unexplainedTotal} tone="debit" />;
}

/** What actually accounts for the money — links, settlements, adjustments — or nothing to say. */
function explanationSummary(payment: PaymentWorkspaceItem): string | null {
  const parts: string[] = [];
  if (payment.expenseLinkCount > 0) {
    parts.push(`${payment.expenseLinkCount} expense${payment.expenseLinkCount === 1 ? "" : "s"}`);
  }
  if (payment.settlementCount > 0) {
    parts.push(`${payment.settlementCount} settlement${payment.settlementCount === 1 ? "" : "s"}`);
  }
  if (payment.adjustmentTotal !== "0") parts.push("a refund");
  return parts.length === 0 ? null : `by ${parts.join(", ")}`;
}
