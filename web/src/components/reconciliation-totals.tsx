import { Money } from "@/components/money";
import type { ReconciliationTotals as Totals } from "@/lib/types";

/**
 * The identity `invariants.md` #20 defines, laid out the way a ledger states a subtraction
 * chain: each subtracted bucket prefixed with "−", a double rule where a ledger would strike
 * one under a final total, then the result. Every figure here is exactly what the API computed
 * — the "−" is presentational (marking which rows the identity subtracts), never a second
 * negation of the underlying value.
 */
export function ReconciliationTotals({ totals }: { totals: Totals }) {
  return (
    <table className="w-full text-[14px]">
      <caption className="sr-only">Reconciliation totals for this period</caption>
      <tbody>
        <Row label="Outflow" paise={totals.ledgerTotalOutflow} />
        <Row label="Transfers" paise={totals.ledgerTransfersTotal} subtract />
        <Row label="Investments" paise={totals.ledgerInvestmentsTotal} subtract />
        <Row label="Settlements" paise={totals.ledgerSettlementsTotal} subtract />
        <Row label="Explained" paise={totals.ledgerExplainedTotal} subtract />
        <tr aria-hidden="true">
          <td colSpan={2} className="pt-2">
            <div className="border-t-2 border-double border-rule-strong" />
          </td>
        </tr>
        <Row
          label="Not yet explained"
          paise={totals.ledgerUnexplainedTotal}
          tone={totals.ledgerUnexplainedTotal === "0" ? "credit" : "debit"}
          emphasize
        />
      </tbody>
    </table>
  );
}

function Row({
  label,
  paise,
  subtract = false,
  tone = "neutral",
  emphasize = false,
}: {
  label: string;
  paise: string;
  subtract?: boolean;
  tone?: "debit" | "credit" | "neutral";
  emphasize?: boolean;
}) {
  return (
    <tr>
      <th
        scope="row"
        className={`py-1 pr-4 text-left font-normal ${
          subtract ? "pl-4 text-ink-muted" : "text-ink"
        } ${emphasize ? "pt-2 font-medium text-ink" : ""}`}
      >
        {label}
      </th>
      <td className={`py-1 text-right ${emphasize ? "pt-2 text-[15px] font-medium" : ""}`}>
        {subtract && <span className="text-ink-faint">− </span>}
        <Money paise={paise} tone={tone} />
      </td>
    </tr>
  );
}
