"use client";

import { useState } from "react";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { classificationOutcomeLabel, classificationSkipLabel } from "@/lib/labels";
import { useClassifyPayments, useNormalizePayments } from "@/lib/queries";
import type {
  ClassificationOutcome,
  ClassifyPaymentsResult,
  NormalizePaymentsResult,
} from "@/lib/types";

/**
 * The two runs that turn imported rows into something a person can decide about.
 *
 * Both are consequential, so both go through `DecisionDialog` rather than a bare button
 * (ADR-0049) — normalization moves every eligible payment's state, and classification records
 * a proposal (and a DERIVED expense) per payment. Neither approves anything: what
 * classification produces is a queue item, which is the whole point of the boundary
 * (`ai-boundary.md`).
 *
 * `importBatchId` scopes a run to one statement. Omitted, both run over everything eligible.
 */
export function PipelineActions({
  importBatchId,
  eligibleLabel,
}: {
  importBatchId?: string;
  eligibleLabel: string;
}) {
  const [open, setOpen] = useState<"normalize" | "classify" | null>(null);
  const [normalized, setNormalized] = useState<NormalizePaymentsResult | null>(null);
  const [classified, setClassified] = useState<ClassifyPaymentsResult | null>(null);
  const normalize = useNormalizePayments();
  const classify = useClassifyPayments();

  const scope = importBatchId === undefined ? "every payment still waiting" : "this batch";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setOpen("normalize")}>
          Run normalization
        </Button>
        <Button variant="outline" onClick={() => setOpen("classify")}>
          Run classification
        </Button>
      </div>

      <DecisionDialog
        open={open === "normalize"}
        onClose={() => setOpen(null)}
        title="Run normalization"
        consequence={
          <>
            This refines the payment channel and resolves merchants for {scope} ({eligibleLabel}),
            moving each from <strong>imported</strong> to <strong>normalized</strong>. It is
            deterministic: a narration that matches no merchant alias is left as{" "}
            <strong>unknown</strong> rather than guessed at. It classifies nothing and explains
            nothing.
          </>
        }
        confirmLabel="Run it"
        pending={normalize.isPending}
        error={normalize.error}
        onConfirm={() => {
          normalize.mutate(importBatchId, {
            onSuccess: (result) => {
              setNormalized(result);
              setClassified(null);
              setOpen(null);
            },
          });
        }}
      />

      <DecisionDialog
        open={open === "classify"}
        onClose={() => setOpen(null)}
        title="Run classification"
        consequence={
          <>
            This asks the configured model what each normalized payment was, and records its answer
            as a <strong>proposal</strong> for {scope}. Nothing is approved and no balance moves:
            each proposal lands in the review queue for you to accept or reject. A payment whose
            answer breaches the contract is reported and skipped, not stored.
          </>
        }
        confirmLabel="Run it"
        pending={classify.isPending}
        error={classify.error}
        onConfirm={() => {
          classify.mutate(importBatchId, {
            onSuccess: (result) => {
              setClassified(result);
              setNormalized(null);
              setOpen(null);
            },
          });
        }}
      />

      {normalized !== null && <NormalizationResult result={normalized} />}
      {classified !== null && <ClassificationResult result={classified} />}
    </div>
  );
}

function NormalizationResult({ result }: { result: NormalizePaymentsResult }) {
  const count = result.normalizedPaymentIds.length;
  if (count === 0) {
    return (
      <Alert variant="attention">
        <AlertTitle>Nothing was eligible</AlertTitle>
        <AlertDescription>
          <p>
            Normalization acts on payments at <strong>imported</strong> only. Everything here has
            already been through it.
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="attention">
      <AlertTitle>
        Normalized {count} payment{count === 1 ? "" : "s"}
      </AlertTitle>
      <AlertDescription>
        <p>
          {result.channelRefinedCount} had their channel refined; {result.merchantResolvedCount}{" "}
          resolved to a merchant. The rest kept an <strong>unknown</strong> counterparty — an exact
          alias miss, not a failure. Teach it the narration in Setup → Merchants.
        </p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Every payment offered, grouped by what happened to it. Nothing is silently dropped: a
 * rejected model answer is reported with its code, because "the model is bad at this" and
 * "we asked for the wrong shape" look identical until you can read the reason.
 */
function ClassificationResult({ result }: { result: ClassifyPaymentsResult }) {
  const byOutcome = new Map<string, number>();
  for (const outcome of result.outcomes) {
    byOutcome.set(outcome.outcome, (byOutcome.get(outcome.outcome) ?? 0) + 1);
  }
  const rejected = result.outcomes.filter(
    (outcome): outcome is Extract<ClassificationOutcome, { outcome: "rejected" }> =>
      outcome.outcome === "rejected",
  );
  const skipped = result.outcomes.filter(
    (outcome): outcome is Extract<ClassificationOutcome, { outcome: "skipped" }> =>
      outcome.outcome === "skipped",
  );

  if (result.outcomes.length === 0) {
    return (
      <Alert variant="attention">
        <AlertTitle>Nothing was waiting</AlertTitle>
        <AlertDescription>
          <p>
            Classification acts on <strong>normalized</strong> payments that have no proposal yet.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="attention">
      <AlertTitle>
        {result.outcomes.length} payment{result.outcomes.length === 1 ? "" : "s"} offered
      </AlertTitle>
      <AlertDescription>
        <ul className="mt-1 flex flex-col gap-1 text-meta">
          {[...byOutcome.entries()].map(([outcome, count]) => (
            <li key={outcome}>
              {classificationOutcomeLabel(outcome)}: {count}
            </li>
          ))}
        </ul>
        {skipped.length > 0 && (
          <p className="mt-2 text-meta">
            Skipped:{" "}
            {[...new Set(skipped.map((entry) => classificationSkipLabel(entry.reason)))].join("; ")}
            .
          </p>
        )}
        {rejected.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1 text-meta">
            {rejected.map((entry) => (
              <li key={entry.paymentId}>
                <span className="font-mono text-micro">{entry.code}</span> — {entry.reason}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-meta">
          Every proposal is waiting in the review queue. None of them is state yet.
        </p>
      </AlertDescription>
    </Alert>
  );
}
