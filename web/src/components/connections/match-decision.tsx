"use client";

import { useState } from "react";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Button } from "@/components/ui/button";
import { useDecideEvidenceMatch } from "@/lib/queries";

/**
 * Agreeing, or disagreeing, with a suggested connection — where the person is already reading
 * the evidence for it.
 *
 * The decision itself has always been possible; what it required was finding the document in
 * the review queue, opening an inspector built around a signal-by-signal comparison table, and
 * pressing **Attach to this payment** beside a payment identified by eight hexadecimal digits.
 * That screen is unchanged and still the right one for reading the comparison. This is the same
 * write, `services.decideEvidenceMatch`, offered beside the plain sentences that explain the
 * suggestion.
 *
 * **The permanence is on the button, not in a footnote.** Attaching a document is write-once by
 * design (ADR-0034) — a document attached to the wrong payment cannot be re-pointed — so the
 * dialog says so before the confirm, in the words a person would use, and declining is offered
 * as the ordinary other answer rather than a cancel.
 */
export function MatchDecision({
  candidateId,
  recordLabel,
  paymentName,
}: {
  candidateId: string;
  /** What the record is, in the reader's words — "Bill or receipt", "Payment message". */
  recordLabel: string;
  /** The best name the movement has, so the dialog names an event rather than an id. */
  paymentName: string;
}) {
  const [pending, setPending] = useState<"accept" | "dismiss" | null>(null);
  const decide = useDecideEvidenceMatch();

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" onClick={() => setPending("accept")}>
        Yes, they go together
      </Button>
      <Button size="sm" variant="outline" onClick={() => setPending("dismiss")}>
        No, different thing
      </Button>

      <DecisionDialog
        open={pending !== null}
        onClose={() => {
          setPending(null);
          decide.reset();
        }}
        title={pending === "accept" ? "Connect these two records" : "Say these are not related"}
        consequence={
          pending === "accept" ? (
            <>
              This says the {recordLabel.toLowerCase()} and the payment{" "}
              <strong>{paymentName}</strong> are the same real thing, and it is{" "}
              <strong>permanent</strong>: a record can be connected once, and cannot later be moved
              to a different payment. It does not decide what the payment was for, who shared it, or
              what anybody owes.
            </>
          ) : (
            <>
              This records that the {recordLabel.toLowerCase()} is not about{" "}
              <strong>{paymentName}</strong>. Nothing about either one changes, and any other
              suggestion for this record stays open.
            </>
          )
        }
        confirmLabel={pending === "accept" ? "Connect them" : "Not related"}
        confirmVariant={pending === "accept" ? "default" : "outline"}
        reasonLabel="Note for the record"
        pending={decide.isPending}
        error={decide.error}
        onConfirm={(reason) => {
          if (pending === null) return;
          decide.mutate(
            { candidateId, decision: pending, ...(reason === undefined ? {} : { reason }) },
            { onSuccess: () => setPending(null) },
          );
        }}
      />
    </div>
  );
}
