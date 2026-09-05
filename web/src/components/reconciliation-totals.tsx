import { Money } from "@/components/money";
import type { ReconciliationTotals as Totals } from "@/lib/types";

/**
 * The identity `invariants.md` #20 defines, laid out the way a ledger states a subtraction
 * chain: each subtracted bucket prefixed with "−", a double rule where a ledger would strike
 * one under a final total, then the result. Every figure here is exactly what the API computed
 * — the "−" is presentational (marking which rows the identity subtracts), never a second
 * negation of the underlying value.
 *
 * The subtraction chain stays quiet and small — supporting arithmetic, not the point of the
 * screen. The final row is the one thing this whole page exists to answer, so it's the only
 * figure on it set at `display` size (`web/Design.md` "One hero number per screen").
 */
export function ReconciliationTotals({ totals }: { totals: Totals }) {
  const isExplained = totals.ledgerUnexplainedTotal === "0";

  return (
    <div className="flex flex-col gap-5">
      <table className="w-full text-body">
        <caption className="sr-only">Reconciliation totals for this period</caption>
        <tbody>
          <Row label="Outflow" paise={totals.ledgerTotalOutflow} />
          <Row label="Transfers" paise={totals.ledgerTransfersTotal} subtract />
          <Row label="Investments" paise={totals.ledgerInvestmentsTotal} subtract />
          <Row label="Settlements" paise={totals.ledgerSettlementsTotal} subtract />
          <Row label="Explained" paise={totals.ledgerExplainedTotal} subtract />
        </tbody>
      </table>

      <div className="border-t-2 border-double border-rule-strong pt-4">
        <p className="text-meta text-ink-muted">Not yet explained</p>
        <Money
          paise={totals.ledgerUnexplainedTotal}
          tone={isExplained ? "credit" : "debit"}
          size="display"
          className="mt-1 block"
        />
        {!isExplained && (
          <p className="mt-2 text-meta text-ink-muted">
            Every payment this period that isn&apos;t a transfer, an investment, a settlement, or an
            explained expense.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  paise,
  subtract = false,
}: {
  label: string;
  paise: string;
  subtract?: boolean;
}) {
  return (
    <tr>
      <th
        scope="row"
        className={`py-1 pr-4 text-left font-normal text-ink-muted ${subtract ? "pl-4" : ""}`}
      >
        {label}
      </th>
      <td className="py-1 text-right text-ink-muted">
        {subtract && <span className="text-ink-faint">− </span>}
        <Money paise={paise} />
      </td>
    </tr>
  );
}
