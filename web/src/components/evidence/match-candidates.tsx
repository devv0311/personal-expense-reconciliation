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
          No payment has been suggested for this record. That is a real answer rather than a failure
          — choose <strong>Look for matches</strong> if nothing has looked yet.
        </EmptyBlock>
      ) : (
        <>
          {open.length > 1 && (
            <p className="text-meta text-attention">
              More than one payment could be the right one, and nothing on the record tells them
              apart. This will not guess between them — only you can say which it is.
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
              <h4 className="mb-2 text-meta text-ink-muted">Already answered</h4>
              <ul className="flex flex-col">
                {decided.map((candidate) => (
                  <li
                    key={candidate.candidateId}
                    className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-2 last:border-b-0 text-meta"
                  >
                    <Link
                      href={`/payments/${candidate.paymentId}`}
                      className="font-mono text-accent underline underline-offset-2"
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
          pending?.decision === "accept" ? "Connect these two records" : "Say these are not related"
        }
        consequence={
          pending?.decision === "accept" ? (
            <>
              This says the record and that payment are the same real thing, and it is{" "}
              <strong>permanent</strong>: a record can be connected once, and cannot later be moved
              to a different payment. Anything read off the record comes with it, and the other
              suggestions for this record are answered at the same time.
            </>
          ) : (
            <>
              This records that the two are not about the same thing. Any other suggestion for this
              record stays open, and nothing about the payment changes.
            </>
          )
        }
        confirmLabel={pending?.decision === "accept" ? "Connect them" : "Not related"}
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
        {/*
          The two ids, kept because a permanent act should name exactly what it acts on — but
          said as a reference line under the sentence, never as the sentence itself.
        */}
        <p className="text-micro text-ink-faint">
          Record <span className="font-mono">{evidenceId.slice(0, 8)}</span>, payment{" "}
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
  const agreed = signals.filter((signal) => signal.verdict === "matched");
  const disagreed = signals.filter((signal) => signal.verdict === "conflicted");
  return (
    <li className="border-t border-rule pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <Link
          href={`/connections/${candidate.paymentId}`}
          className="text-body text-accent underline underline-offset-2"
        >
          This payment
        </Link>
        <span className="flex flex-wrap items-baseline gap-3">
          <span className="text-meta text-ink-muted">{matchStrengthLabel(candidate.strength)}</span>
          <Confidence level={candidate.confidence} />
        </span>
      </div>

      {/*
        What agrees and what does not, before the table that proves it. The comparison is the
        evidence for the suggestion and somebody checking a doubtful one needs every column of
        it — but it is not how a person decides, and leading with it asked them to read a matrix
        before they could read a sentence.
      */}
      {(agreed.length > 0 || disagreed.length > 0) && (
        <dl className="mt-2 flex flex-col gap-1">
          {agreed.length > 0 && (
            <div className="flex flex-wrap items-baseline gap-2">
              <dt className="text-micro text-ink-faint">What matches</dt>
              <dd className="text-meta text-ink">
                {agreed.map((signal) => matchSignalLabel(signal.signal).toLowerCase()).join(", ")}
              </dd>
            </div>
          )}
          {disagreed.length > 0 && (
            <div className="flex flex-wrap items-baseline gap-2">
              <dt className="text-micro text-ink-faint">What does not</dt>
              <dd className="text-meta text-attention">
                {disagreed
                  .map((signal) => matchSignalLabel(signal.signal).toLowerCase())
                  .join(", ")}
              </dd>
            </div>
          )}
        </dl>
      )}

      <ReasonRow reasons={candidate.reviewReasons} label={matchReviewReasonLabel} />

      {signals.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-meta text-ink-muted">
            Compare them side by side
          </summary>
          <div className="mt-2">
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
                      <span className="mt-0.5 block text-micro text-ink-faint">
                        {signal.detail}
                      </span>
                    </>
                  ),
                },
                {
                  key: "evidence",
                  header: "The record says",
                  render: (signal) => (
                    <span className="font-mono text-meta break-all">
                      {signal.evidenceValue ?? "—"}
                    </span>
                  ),
                },
                {
                  key: "payment",
                  header: "The payment says",
                  render: (signal) => (
                    <span className="font-mono text-meta break-all">
                      {signal.paymentValue ?? "—"}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </details>
      )}

      <div className="mt-3 flex flex-wrap gap-3">
        <Button size="sm" onClick={() => onDecide("accept")}>
          Yes, they go together
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDecide("dismiss")}>
          No, different thing
        </Button>
      </div>
    </li>
  );
}
