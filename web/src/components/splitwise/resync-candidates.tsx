"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { ResponsiveTable } from "@/components/responsive-table";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { sentenceCase } from "@/lib/labels";
import { useResyncCandidates, useResyncExpense, useResyncSettlement } from "@/lib/queries";
import type {
  ResyncCandidate,
  SettlementResyncCandidate,
  SplitwiseRepairKind,
} from "@/lib/types";

/**
 * Rows Splitwise still holds an out-of-date figure for, and the one action that fixes them.
 *
 * This is the only place in the product that writes to Splitwise, and every guard around it is
 * deliberate (ADR-0046, ADR-0055, and the re-sync service): a person decides **one row at a
 * time**, the figure pushed is this ledger's current net rather than anything typed here, a
 * reason is required because it changes a number in somebody else's ledger, and refusing
 * changes nothing on either side. Reviewing an audit finding still authorizes none of this.
 *
 * What the repair does to the other person's ledger — correct the entry they are looking at,
 * remove it, or put back one this ledger withdrew — is named by the API, per row, and only
 * quoted here. A screen that worked it out from the figures would be a second copy of a rule
 * that has to agree with the repair, forever (ADR-0048).
 */
export function ResyncCandidates() {
  const [pushingExpense, setPushingExpense] = useState<ResyncCandidate | null>(null);
  const [pushingSettlement, setPushingSettlement] = useState<SettlementResyncCandidate | null>(
    null,
  );
  const candidates = useResyncCandidates();
  const resync = useResyncExpense();
  const resyncSettlement = useResyncSettlement();

  const data = candidates.data;
  const nothingToRepair =
    data !== undefined && data.candidates.length === 0 && data.settlements.length === 0;

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

      {data !== undefined && !data.capability.canCorrect && (
        <Alert variant="attention">
          <AlertTitle>This connection cannot correct an entry in place.</AlertTitle>
          <AlertDescription>
            <p>
              The configured Splitwise adapter has no way to edit an entry it already created,
              so the repair below will refuse rather than push. It will not fall back to
              creating a second entry: that would leave the other person holding two records
              for one expense, with nothing saying which is current.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {nothingToRepair && (
        <EmptyBlock>
          Nothing synced to Splitwise has changed here since it was pushed. That is a statement
          about what this ledger has synced, not a claim that Splitwise agrees about everything.
        </EmptyBlock>
      )}

      {data !== undefined && data.candidates.length > 0 && (
        <ResponsiveTable
          caption="Splitwise rows this ledger has moved on from"
          minWidth="620px"
          rows={data.candidates}
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
              key: "repair",
              header: "What a push does",
              render: (candidate) => (
                <span className="text-ink-muted">{repairSummary(candidate.plannedRepair)}</span>
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
                <Button variant="outline" size="sm" onClick={() => setPushingExpense(candidate)}>
                  Push ours
                </Button>
              ),
            },
          ]}
        />
      )}

      {data !== undefined && data.settlements.length > 0 && (
        <div className="mt-6">
          <h3 className="text-body font-medium">Settlements Splitwise disagrees about</h3>
          <p className="mt-1 text-meta text-ink-muted">
            A settlement&apos;s amount cannot go stale the way a refunded expense&apos;s can, so
            the only way these come apart is Splitwise&apos;s own side moving.
          </p>
          <div className="mt-3">
            <ResponsiveTable
              caption="Settlements Splitwise holds a different figure for"
              minWidth="560px"
              rows={data.settlements}
              rowKey={(candidate) => candidate.splitwiseSettlementId}
              columns={[
                {
                  key: "counterparty",
                  header: "With",
                  render: (candidate) => candidate.counterpartyName,
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
                  render: (candidate) => <Money paise={candidate.currentAmount} />,
                },
                {
                  key: "action",
                  header: "Correct it",
                  align: "right",
                  render: (candidate) => (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPushingSettlement(candidate)}
                    >
                      Push ours
                    </Button>
                  ),
                },
              ]}
            />
          </div>
        </div>
      )}

      <DecisionDialog
        open={pushingExpense !== null}
        onClose={() => {
          setPushingExpense(null);
          resync.reset();
        }}
        title={dialogTitle(pushingExpense?.plannedRepair)}
        consequence={
          <>
            This writes to <strong>Splitwise</strong> — the only action in this product that
            does. {repairConsequence(pushingExpense?.plannedRepair)}{" "}
            {pushingExpense !== null && pushingExpense.plannedRepair !== "withdrawn" && (
              <>
                The figure it pushes is this ledger&apos;s current one of{" "}
                <Money paise={pushingExpense.currentNetAmount} />.{" "}
              </>
            )}
            It changes no figure in this ledger.
          </>
        }
        confirmLabel={pushingExpense?.plannedRepair === "withdrawn" ? "Remove it" : "Push it"}
        reasonRequired
        reasonLabel="Why this row is being corrected"
        reasonPlaceholder="They are entitled to an account of why their number changed."
        pending={resync.isPending}
        error={resync.error}
        onConfirm={(reason) => {
          if (pushingExpense === null || reason === undefined) return;
          resync.mutate(
            { expenseId: pushingExpense.expenseId, reason },
            { onSuccess: () => setPushingExpense(null) },
          );
        }}
      />

      <DecisionDialog
        open={pushingSettlement !== null}
        onClose={() => {
          setPushingSettlement(null);
          resyncSettlement.reset();
        }}
        title="Correct this settlement in Splitwise"
        consequence={
          <>
            This writes to <strong>Splitwise</strong>. It corrects the settlement entry already
            there — same entry, same id — so that it reads{" "}
            {pushingSettlement !== null && <Money paise={pushingSettlement.currentAmount} />} in
            the direction this ledger recorded. It discharges nothing new here, and records no
            second settlement.
          </>
        }
        confirmLabel="Push it"
        reasonRequired
        reasonLabel="Why this settlement is being corrected"
        reasonPlaceholder="They are entitled to an account of why their number changed."
        pending={resyncSettlement.isPending}
        error={resyncSettlement.error}
        onConfirm={(reason) => {
          if (pushingSettlement === null || reason === undefined) return;
          resyncSettlement.mutate(
            { settlementId: pushingSettlement.settlementId, reason },
            { onSuccess: () => setPushingSettlement(null) },
          );
        }}
      />
    </Section>
  );
}

/** The one-line version, for the table cell. */
function repairSummary(repair: SplitwiseRepairKind): string {
  switch (repair) {
    case "withdrawn":
      return "Removes their entry";
    case "recreated":
      return "Puts the entry back";
    default:
      return "Corrects their entry";
  }
}

function dialogTitle(repair: SplitwiseRepairKind | undefined): string {
  switch (repair) {
    case "withdrawn":
      return "Remove this entry from Splitwise";
    case "recreated":
      return "Put this entry back in Splitwise";
    default:
      return "Correct this row in Splitwise";
  }
}

/** The full sentence, for the dialog. Each one says what the other person will see. */
function repairConsequence(repair: SplitwiseRepairKind | undefined): string {
  switch (repair) {
    case "withdrawn":
      return (
        "This expense now nets to zero, which Splitwise cannot hold, so the entry is deleted " +
        "rather than left standing at a figure this ledger no longer asserts. Nothing else in " +
        "their ledger is touched."
      );
    case "recreated":
      return (
        "This ledger withdrew the entry when the expense netted to zero, and there is nothing " +
        "in Splitwise to correct, so this creates it again."
      );
    default:
      return (
        "It corrects the entry they are already looking at — same entry, same id — rather than " +
        "adding a second one beside it."
      );
  }
}
