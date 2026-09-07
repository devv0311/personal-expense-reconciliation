"use client";

import Link from "next/link";
import { useState } from "react";
import { Confidence, ReasonRow, SignalVerdict } from "@/components/annotations";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { ResponsiveTable } from "@/components/responsive-table";
import { EmptyBlock, ErrorBlock } from "@/components/status";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import {
  matchReviewReasonLabel,
  matchSignalLabel,
  matchStatusLabel,
  matchStrengthLabel,
} from "@/lib/labels";
import { useDecideEvidenceMatch } from "@/lib/queries";
import type { EvidenceMatchCandidateView } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Every recorded evidence↔payment offer, with each signal's verdict and both compared values.
 *
 * **Nothing here auto-links.** A candidate's `strength` describes its evidence; it is never a
 * permission, and `requiresReview` is `true` on every row by construction (ADR-0034/0037/0044).
 * Accepting is the only path to `evidence.linked_payment_id`, it is write-once, and the dialog
 * says both of those things before the button.
 */
export function EvidenceMatchCandidates({
  evidenceId,
  candidates,
  enrichError,
}: {
  evidenceId: string;
  candidates: readonly EvidenceMatchCandidateView[];
  enrichError?: unknown;
}) {
  const [pending, setPending] = useState<{
    candidate: EvidenceMatchCandidateView;
    decision: "accept" | "dismiss";
  } | null>(null);
  const mutation = useDecideEvidenceMatch();

  const open = candidates.filter((candidate) => candidate.status === "proposed");
  const decided = candidates.filter((candidate) => candidate.status !== "proposed");

  return (
    <div className="flex flex-col gap-4">
      {enrichError !== null && enrichError !== undefined && <ErrorBlock error={enrichError} />}

      {candidates.length === 0 ? (
        <EmptyBlock>
          No payment has been offered for this document. That is a real answer, not a failure — run
          &ldquo;Find candidates&rdquo; if nothing has looked yet.
        </EmptyBlock>
      ) : (
        <>
          {open.length > 1 && (
            <p className="text-meta text-attention">
              More than one payment is eligible. The evidence does not distinguish them, so this
              system will not either — a person has to.
            </p>
          )}
          <ul className="flex flex-col gap-5">
            {open.map((candidate) => (
              <CandidateCard
                key={candidate.candidateId}
                candidate={candidate}
                onDecide={(decision) => setPending({ candidate, decision })}
              />
            ))}
          </ul>
          {decided.length > 0 && (
            <div>
              <h4 className="mb-2 text-meta text-ink-muted">Already decided</h4>
              <ul className="flex flex-col">
                {decided.map((candidate) => (
                  <li
                    key={candidate.candidateId}
                    className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-2 last:border-b-0 text-meta"
                  >
                    <Link
                      href={`/payments/${candidate.paymentId}`}
                      className="font-mono text-accent underline-offset-2 hover:underline"
                    >
                      {candidate.paymentId.slice(0, 8)}
                    </Link>
                    <span
                      className={cn(
                        candidate.status === "accepted" ? "text-credit" : "text-ink-muted",
                      )}
                    >
                      {matchStatusLabel(candidate.status)}
                      {candidate.decidedBy !== null && ` · ${candidate.decidedBy}`}
                      {candidate.decidedAt !== null && ` · ${formatDateTime(candidate.decidedAt)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <DecisionDialog
        open={pending !== null}
        onClose={() => {
          setPending(null);
          mutation.reset();
        }}
        title={
          pending?.decision === "accept" ? "Attach this document" : "Record that it does not belong"
        }
        consequence={
          pending?.decision === "accept" ? (
            <>
              Attaching this document to that payment is <strong>permanent</strong>: evidence
              linkage is write-once, so it cannot later be re-pointed at a different payment.
              Everything extracted from the document inherits the link, and the other offers for
              this document are answered at the same time.
            </>
          ) : (
            <>
              This records that the document does not belong to that payment. The other offers stay
              open, and nothing about the payment changes.
            </>
          )
        }
        confirmLabel={pending?.decision === "accept" ? "Attach permanently" : "Dismiss"}
        confirmVariant={pending?.decision === "accept" ? "default" : "outline"}
        pending={mutation.isPending}
        error={mutation.error}
        onConfirm={(reason) => {
          if (pending === null) return;
          mutation.mutate(
            {
              candidateId: pending.candidate.candidateId,
              decision: pending.decision,
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: () => setPending(null) },
          );
        }}
      >
        <p className="text-meta text-ink-muted">
          Evidence <span className="font-mono">{evidenceId.slice(0, 8)}</span> →{" "}
          <span className="font-mono">{pending?.candidate.paymentId.slice(0, 8)}</span>
        </p>
      </DecisionDialog>
    </div>
  );
}

function CandidateCard({
  candidate,
  onDecide,
}: {
  candidate: EvidenceMatchCandidateView;
  onDecide: (decision: "accept" | "dismiss") => void;
}) {
  const signals = candidate.signals ?? [];
  return (
    <li className="border-t border-rule pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <Link
          href={`/payments/${candidate.paymentId}`}
          className="font-mono text-body text-accent underline-offset-2 hover:underline"
        >
          Payment {candidate.paymentId.slice(0, 8)}
        </Link>
        <span className="flex flex-wrap items-baseline gap-3">
          <span className="text-meta text-ink-muted">{matchStrengthLabel(candidate.strength)}</span>
          <Confidence level={candidate.confidence} />
        </span>
      </div>

      <ReasonRow reasons={candidate.reviewReasons} label={matchReviewReasonLabel} />

      {signals.length > 0 && (
        <div className="mt-3">
          <ResponsiveTable
            caption="Signal-by-signal comparison for this candidate"
            minWidth="420px"
            rows={signals}
            rowKey={(signal) => signal.signal}
            columns={[
              {
                key: "signal",
                header: "Signal",
                render: (signal) => (
                  <span className="whitespace-nowrap">{matchSignalLabel(signal.signal)}</span>
                ),
              },
              {
                key: "verdict",
                header: "Verdict",
                render: (signal) => (
                  <>
                    <SignalVerdict verdict={signal.verdict} />
                    <span className="mt-0.5 block text-micro text-ink-faint">{signal.detail}</span>
                  </>
                ),
              },
              {
                key: "evidence",
                header: "Evidence says",
                render: (signal) => (
                  <span className="font-mono text-meta break-all">
                    {signal.evidenceValue ?? "—"}
                  </span>
                ),
              },
              {
                key: "payment",
                header: "Payment says",
                render: (signal) => (
                  <span className="font-mono text-meta break-all">
                    {signal.paymentValue ?? "—"}
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-3">
        <Button size="sm" onClick={() => onDecide("accept")}>
          Attach to this payment
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDecide("dismiss")}>
          Not this one
        </Button>
      </div>
    </li>
  );
}
