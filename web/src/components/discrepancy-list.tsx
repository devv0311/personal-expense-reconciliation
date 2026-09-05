import { Alert } from "@/components/ui/alert";
import { Money } from "@/components/money";
import type { PersonSummary, ReconciliationDiscrepancy } from "@/lib/types";

const KIND_LABELS: Record<string, string> = {
  splitwise_balance_mismatch: "Splitwise balance disagrees",
  splitwise_fetch_failed: "Couldn't check Splitwise",
};

/**
 * `kind` is intentionally a loose `string` on the backend (`domain-model.md`'s own comment:
 * "other discrepancy kinds carry free-form detail until [a later phase] needs them typed") — an
 * unrecognised kind still renders, using its own `detail` text, rather than being hidden.
 *
 * Rendered in `attention` amber, never `debit` red: a Splitwise mismatch is a finding to look
 * at, not proof something is wrong the way an unexplained rupee is — conflating the two would
 * teach the eye to distrust every red figure in the ledger (`web/Design.md` "Color").
 */
export function DiscrepancyList({
  discrepancies,
  people,
}: {
  discrepancies: readonly ReconciliationDiscrepancy[];
  people?: readonly PersonSummary[];
}) {
  if (discrepancies.length === 0) {
    return <p className="text-body text-credit">No discrepancies — the ledger matches.</p>;
  }

  const nameFor = (personId: string | undefined): string | undefined =>
    personId === undefined ? undefined : people?.find((p) => p.id === personId)?.displayName;

  return (
    <ul className="flex flex-col gap-3">
      {discrepancies.map((discrepancy, index) => (
        <li key={index}>
          <Alert variant="attention" className="text-body">
            <p className="font-medium text-attention">
              {KIND_LABELS[discrepancy.kind] ?? discrepancy.kind}
            </p>
            <p className="mt-1 text-ink-muted">{discrepancy.detail}</p>
            {(nameFor(discrepancy.personAId) ?? nameFor(discrepancy.personBId)) !== undefined && (
              <p className="mt-1 text-ink-muted">
                Between {nameFor(discrepancy.personAId) ?? discrepancy.personAId} and{" "}
                {nameFor(discrepancy.personBId) ?? discrepancy.personBId}
              </p>
            )}
            {discrepancy.externalNetBalance !== undefined && (
              <p className="mt-1 text-ink-muted">
                Splitwise reports <Money paise={discrepancy.externalNetBalance} />
              </p>
            )}
          </Alert>
        </li>
      ))}
    </ul>
  );
}
