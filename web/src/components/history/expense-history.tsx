"use client";

import { AuditTrail } from "@/components/history/audit-trail";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { formatDateTime } from "@/lib/dates";
import { allocationMethodLabel } from "@/lib/labels";
import { useExpenseHistory, usePeople } from "@/lib/queries";
import type { AllocationVersion } from "@/lib/types";

/**
 * One expense's whole story: every allocation it has ever had, then the chronological log.
 *
 * Superseded versions are the point (audit row 26). An allocation is never edited — approving a
 * new one supersedes the old, and the old is kept forever precisely so "what did this look like
 * before the refund?" stays answerable. What the old split *would* be today is a different
 * question, and answering it here would relabel it as history.
 *
 * The settlements folded into the trail are the payer's, not this expense's: a settlement
 * discharges a balance between two people and never one particular expense (ADR-0007). Saying
 * otherwise on a timeline would invent a link the ledger deliberately does not model.
 */
export function ExpenseHistory({ expenseId }: { expenseId: string }) {
  const history = useExpenseHistory(expenseId);
  const people = usePeople();

  const nameFor = (line: AllocationVersion["lines"][number]): string => {
    if (line.beneficiaryName !== null) return line.beneficiaryName;
    const match = people.data?.find((person) => person.id === line.beneficiaryId);
    return match?.displayName ?? "Someone no longer in the roster";
  };

  if (history.isPending) {
    return (
      <Section title="History" headingId="expense-history">
        <LoadingStatus label="Loading this expense's history…">
          <TableSkeleton columns={3} rows={3} />
        </LoadingStatus>
      </Section>
    );
  }
  if (history.isError) {
    return (
      <Section title="History" headingId="expense-history">
        <ErrorBlock error={history.error} onRetry={() => void history.refetch()} />
      </Section>
    );
  }

  const { allocationVersions, events } = history.data;

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="Every split this has had"
        headingId="expense-allocation-history"
        description="Oldest first. A new allocation supersedes the one before it rather than replacing it, so what each person owed at the time stays readable."
      >
        {allocationVersions.length === 0 ? (
          <EmptyBlock>No allocation has ever been approved for this expense.</EmptyBlock>
        ) : (
          <ol className="flex flex-col gap-4">
            {allocationVersions.map((version) => (
              <li key={version.allocationId} className="border-b border-rule pb-4 last:border-b-0">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="text-body text-ink">
                    {allocationMethodLabel(version.method)}
                    {version.supersededAt === null ? (
                      <span className="ml-2 text-micro text-credit">current</span>
                    ) : (
                      <span className="ml-2 text-micro text-ink-faint">
                        superseded {formatDateTime(version.supersededAt)}
                      </span>
                    )}
                  </span>
                  <span className="text-meta text-ink-muted">
                    approved {formatDateTime(version.decidedAt)} by {version.decidedBy}
                  </span>
                </div>
                <ul className="mt-2 flex flex-col gap-1">
                  {version.lines.map((line, index) => (
                    <li
                      key={`${line.beneficiaryId}-${line.expenseItemId ?? "whole"}-${index}`}
                      className="flex items-baseline justify-between gap-4 text-meta"
                    >
                      <span className="text-ink">{nameFor(line)}</span>
                      <Money paise={line.amount} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section
        title="Everything that happened"
        headingId="expense-audit-trail"
        description="The expense, its adjustments, its allocations and its documents, in one sequence. Quoted from the append-only log."
      >
        <AuditTrail events={events} />
      </Section>
    </div>
  );
}
