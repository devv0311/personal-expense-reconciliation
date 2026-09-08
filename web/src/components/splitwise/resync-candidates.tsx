"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { ResponsiveTable } from "@/components/responsive-table";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { sentenceCase } from "@/lib/labels";
import { useResyncCandidates, useResyncExpense } from "@/lib/queries";
import type { ResyncCandidate } from "@/lib/types";

/**
 * Rows Splitwise still holds an out-of-date figure for, and the one action that fixes them.
 *
 * This is the only place in the product that writes to Splitwise, and every guard around it is
 * deliberate (ADR-0046, and the re-sync service): a person decides **one row at a time**, the
 * figure pushed is this ledger's current net rather than anything typed here, a reason is
 * required because it changes a number in somebody else's ledger, and refusing changes nothing
 * on either side. Reviewing an audit finding still authorizes none of this.
 *
 * Deleting a row in Splitwise is deliberately not offered at all — nothing in this system can
 * do it, and a button that appeared to would be a lie.
 */
export function ResyncCandidates() {
  const [pushing, setPushing] = useState<ResyncCandidate | null>(null);
  const candidates = useResyncCandidates();
  const resync = useResyncExpense();

  return (
    <Section
      title="Rows Splitwise has out of date"
      headingId="resync"
      description="Where this ledger has moved on since the last push — a refund, a re-allocation — or where an audit found the two disagreeing."
    >
      {candidates.isPending && (
        <LoadingStatus label="Loading rows that have drifted…">
          <TableSkeleton columns={3} rows={2} />
        </LoadingStatus>
      )}
      {candidates.isError && (
        <ErrorBlock error={candidates.error} onRetry={() => void candidates.refetch()} />
      )}
      {candidates.isSuccess && candidates.data.length === 0 && (
        <EmptyBlock>
          Nothing synced to Splitwise has changed here since it was pushed. That is a statement
          about what this ledger has synced, not a claim that Splitwise agrees about everything.
        </EmptyBlock>
      )}
      {candidates.isSuccess && candidates.data.length > 0 && (
        <ResponsiveTable
          caption="Splitwise rows this ledger has moved on from"
          minWidth="560px"
          rows={candidates.data}
          rowKey={(candidate) => candidate.splitwiseExpenseId}
          columns={[
            {
              key: "expense",
              header: "Expense",
              render: (candidate) => (
                <Link
                  href={`/expenses/${candidate.expenseId}`}
                  className="text-accent underline underline-offset-2"
                >
                  {candidate.description ?? "Untitled expense"}
                </Link>
              ),
            },
            {
              key: "status",
              header: "State",
              render: (candidate) => (
                <span className="text-attention">{sentenceCase(candidate.syncStatus)}</span>
              ),
            },
            {
              key: "synced",
              header: "Last pushed",
              secondary: true,
              render: (candidate) => (
                <span className="text-meta text-ink-muted">
                  {formatDateTime(candidate.syncedAt)}
                </span>
              ),
            },
            {
              key: "current",
              header: "Our figure now",
              align: "right",
              render: (candidate) => <Money paise={candidate.currentNetAmount} />,
            },
            {
              key: "action",
              header: "Correct it",
              align: "right",
              render: (candidate) => (
                <Button variant="outline" size="sm" onClick={() => setPushing(candidate)}>
                  Push ours
                </Button>
              ),
            },
          ]}
        />
      )}

      <DecisionDialog
        open={pushing !== null}
        onClose={() => {
          setPushing(null);
          resync.reset();
        }}
        title="Correct this row in Splitwise"
        consequence={
          <>
            This writes to <strong>Splitwise</strong> — the only action in this product that does.
            It pushes this ledger&apos;s current figure
            {pushing === null ? "" : " of "}
            {pushing !== null && <Money paise={pushing.currentNetAmount} />}, replacing what
            Splitwise holds, and records the correction against the same expense here. It does not
            delete anything, and it changes no figure in this ledger.
          </>
        }
        confirmLabel="Push it"
        reasonRequired
        reasonLabel="Why this row is being corrected"
        reasonPlaceholder="They are entitled to an account of why their number changed."
        pending={resync.isPending}
        error={resync.error}
        onConfirm={(reason) => {
          if (pushing === null || reason === undefined) return;
          resync.mutate(
            { expenseId: pushing.expenseId, reason },
            { onSuccess: () => setPushing(null) },
          );
        }}
      />
    </Section>
  );
}
