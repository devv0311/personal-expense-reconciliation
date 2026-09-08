"use client";

import { useState } from "react";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Button } from "@/components/ui/button";
import { useMarkExpenseReadyToSync, useSyncExpenseToSplitwise } from "@/lib/queries";
import type { ExpenseLedgerRow } from "@/lib/types";

/**
 * Pushing one expense's split into Splitwise, in the two steps the lifecycle actually has.
 *
 * `allocated → ready_to_sync` is a decision about **this** ledger — the split is settled enough
 * to share. The push is a separate act that writes into somebody else's. Collapsing them would
 * make marking an expense finished send it, which is exactly the kind of silent outward action
 * this product does not take.
 *
 * Splitwise is a sync target, never an authority: what gets pushed is this ledger's figure, and
 * what comes back is reconciled against rather than trusted (`CLAUDE.md`, principle 9).
 */
export function SplitwiseSyncPanel({ expense }: { expense: ExpenseLedgerRow }) {
  const [step, setStep] = useState<"ready" | "sync" | null>(null);
  const markReady = useMarkExpenseReadyToSync(expense.id);
  const sync = useSyncExpenseToSplitwise(expense.id);

  const canReady = expense.state === "allocated";
  const canSync = expense.state === "ready_to_sync";
  const alreadySynced = expense.state === "synced" || expense.state === "reconciled";

  if (!canReady && !canSync && !alreadySynced) return null;

  return (
    <Section
      title="Splitwise"
      headingId="splitwise-sync"
      description="This ledger is the source of truth; Splitwise is a place its figures are mirrored to."
      actions={
        <div className="flex flex-wrap gap-2">
          {canReady && (
            <Button variant="outline" size="sm" onClick={() => setStep("ready")}>
              Mark ready to sync
            </Button>
          )}
          {canSync && (
            <Button size="sm" onClick={() => setStep("sync")}>
              Sync to Splitwise
            </Button>
          )}
        </div>
      }
    >
      <p className="text-meta text-ink-muted">
        {alreadySynced
          ? "Already pushed. If this expense changes afterwards, the Splitwise audit lists it as a row Splitwise holds out of date — correcting it is a separate, explicit act."
          : canSync
            ? "Ready. Pushing sends this expense's current split to Splitwise, once."
            : "Not ready yet. An allocation has to be approved before there is a split to share."}
      </p>

      <DecisionDialog
        open={step === "ready"}
        onClose={() => setStep(null)}
        title="Mark this expense ready to sync"
        consequence={
          <>
            This records that the split is settled enough to share. It sends nothing anywhere — the
            push is a separate act.
          </>
        }
        confirmLabel="Mark it ready"
        reasonLabel="Note for the audit trail"
        pending={markReady.isPending}
        error={markReady.error}
        onConfirm={(reason) => {
          markReady.mutate(reason === undefined ? {} : { reason }, {
            onSuccess: () => setStep(null),
          });
        }}
      />

      <DecisionDialog
        open={step === "sync"}
        onClose={() => setStep(null)}
        title="Sync this expense to Splitwise"
        consequence={
          <>
            This writes into <strong>Splitwise</strong>: a new entry there, carrying this
            expense&apos;s current shares. Everyone in that group will see it. Nothing in this
            ledger changes, and nothing about Splitwise&apos;s answer is trusted back.
          </>
        }
        confirmLabel="Push it"
        reasonLabel="Note for the audit trail"
        pending={sync.isPending}
        error={sync.error}
        onConfirm={(reason) => {
          sync.mutate(reason === undefined ? {} : { reason }, { onSuccess: () => setStep(null) });
        }}
      />
    </Section>
  );
}
