"use client";

import Link from "next/link";
import { useState } from "react";
import { Confidence, NoteList, ReasonRow, StateWord } from "@/components/annotations";
import { EvidenceMatchCandidates } from "@/components/evidence/match-candidates";
import { EvidenceObservationFacts } from "@/components/evidence/observation";
import { Fact, Facts, UnknownValue } from "@/components/facts";
import { Money } from "@/components/money";
import { PaymentSummary } from "@/components/payment-summary";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Section } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/dates";
import { evidenceTypeLabel, reviewReasonLabel, sentenceCase } from "@/lib/labels";
import {
  useDecideInference,
  useDecidePaymentDuplicate,
  useEnrichEvidence,
  useReclassifyPayment,
} from "@/lib/queries";
import type {
  ClassificationDecisionItem,
  PossibleDuplicateItem,
  RejectedClassificationItem,
  ReviewQueueItem,
  UnmatchedEvidenceItem,
} from "@/lib/types";

/** Dispatches on the kind. Each inspector explains its own item and offers only its own acts. */
export function ReviewItemInspector({ item }: { item: ReviewQueueItem }) {
  switch (item.kind) {
    case "classification_decision":
      return <ClassificationInspector item={item} />;
    case "possible_duplicate":
      return <DuplicateInspector item={item} />;
    case "rejected_classification":
      return <RejectedInspector item={item} />;
    case "unmatched_evidence":
      return <UnmatchedEvidenceInspector item={item} />;
  }
}

/* ------------------------------------------------------------------ classification */

/**
 * A model's proposal, and the two decisions a person can record about it.
 *
 * `modify` exists on the API and is deliberately not offered here: editing a stored proposal
 * means re-authoring a model's structured output, and a half-built editor for that is a way to
 * approve something nobody read. Rejecting and re-recording the fact by hand is the honest path
 * until a real editor exists (`docs/roadmap.md`, Phase 21 scope).
 */
function ClassificationInspector({ item }: { item: ClassificationDecisionItem }) {
  const [decision, setDecision] = useState<"accept" | "reject" | null>(null);
  const mutation = useDecideInference();

  return (
    <div className="flex flex-col gap-6">
      <Section title="The payment" headingId="inspector-payment">
        <PaymentSummary payment={item.payment} />
      </Section>

      <Section
        title="What the model proposed"
        headingId="inspector-proposal"
        description="A proposal, not state. Nothing here is authoritative until you accept it."
      >
        <Facts>
          <Fact label="Kind">
            {item.proposedKind === null ? (
              <UnknownValue>Unreadable — the stored proposal no longer parses</UnknownValue>
            ) : (
              sentenceCase(item.proposedKind)
            )}
          </Fact>
          <Fact label="Confidence">
            <Confidence level={item.confidence} />
          </Fact>
          <Fact label="Proposed" mono>
            {formatDateTime(item.proposedAt)}
          </Fact>
          <Fact label="Model">
            {item.model.name ?? <UnknownValue>Not recorded</UnknownValue>}
            {item.model.provider !== null && (
              <span className="ml-2 text-meta text-ink-muted">{item.model.provider}</span>
            )}
          </Fact>
          {item.model.promptVersion !== null && (
            <Fact label="Prompt version" mono>
              {item.model.promptVersion}
            </Fact>
          )}
        </Facts>

        {item.proposal !== null && (
          <div className="mt-4">
            <p className="mb-1 text-meta text-ink-muted">The proposal as stored</p>
            <pre className="overflow-x-auto rounded-sm border border-rule bg-panel p-3 font-mono text-micro whitespace-pre-wrap text-ink-muted">
              {JSON.stringify(item.proposal, null, 2)}
            </pre>
          </div>
        )}
      </Section>

      {item.expense !== null && (
        <Section title="The expense behind it" headingId="inspector-expense">
          <Facts>
            <Fact label="Description">
              <Link
                href={`/expenses/${item.expense.expenseId}`}
                className="text-accent underline-offset-2 hover:underline"
              >
                {item.expense.description ?? "Untitled expense"}
              </Link>
            </Fact>
            <Fact label="State">
              <StateWord value={item.expense.state} />
            </Fact>
            <Fact label="Relationship">{sentenceCase(item.expense.relationshipType)}</Fact>
          </Facts>
        </Section>
      )}

      <div className="flex flex-wrap gap-3 border-t border-rule pt-4">
        <Button onClick={() => setDecision("accept")}>Accept this proposal</Button>
        <Button variant="outline" onClick={() => setDecision("reject")}>
          Reject
        </Button>
      </div>

      <DecisionDialog
        open={decision !== null}
        onClose={() => {
          setDecision(null);
          mutation.reset();
        }}
        title={decision === "accept" ? "Accept this proposal" : "Reject this proposal"}
        consequence={
          decision === "accept" ? (
            <>
              Accepting records your approval and lets this proposal become authoritative state — an
              expense with its own allocation to decide, or a settlement discharging a debt. The
              payment amount and narration are unchanged either way.
            </>
          ) : (
            <>
              Rejecting declines the proposal. The payment stays in the ledger as money with no
              explanation, and shows up here again as an unexplained payment until something
              accounts for it.
            </>
          )
        }
        confirmLabel={decision === "accept" ? "Accept" : "Reject"}
        confirmVariant={decision === "accept" ? "default" : "outline"}
        pending={mutation.isPending}
        error={mutation.error}
        onConfirm={(reason) => {
          if (decision === null) return;
          mutation.mutate(
            {
              inferenceId: item.inferenceId,
              decision,
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: () => setDecision(null) },
          );
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------- duplicates */

/** Two payments that resemble each other. Confirming discards one — so it says so, in words. */
function DuplicateInspector({ item }: { item: PossibleDuplicateItem }) {
  const [decision, setDecision] = useState<"confirm" | "dismiss" | null>(null);
  const mutation = useDecidePaymentDuplicate();

  return (
    <div className="flex flex-col gap-6">
      <NoteList
        items={[
          {
            title: "Two live payments resemble each other",
            detail:
              "Nothing has been discarded. Confirming marks the later one a duplicate of the " +
              "earlier; dismissing records that they are two real movements.",
          },
        ]}
      />

      <Section title="The later payment" headingId="inspector-later">
        <PaymentSummary
          payment={item.payment}
          caption="The one a reviewer would normally discard"
        />
      </Section>
      <Section title="The earlier payment" headingId="inspector-earlier">
        <PaymentSummary payment={item.candidate} caption="The one that would survive" />
      </Section>

      <div className="flex flex-wrap gap-3 border-t border-rule pt-4">
        <Button variant="outline" onClick={() => setDecision("confirm")}>
          Confirm duplicate
        </Button>
        <Button variant="outline" onClick={() => setDecision("dismiss")}>
          Not a duplicate
        </Button>
      </div>

      <DecisionDialog
        open={decision !== null}
        onClose={() => {
          setDecision(null);
          mutation.reset();
        }}
        title={decision === "confirm" ? "Confirm this is a duplicate" : "Record that these differ"}
        consequence={
          decision === "confirm" ? (
            <>
              This discards the later payment so the same money is not counted twice. The earlier
              one stays. The discarded row is not deleted — it is marked, with your reason, and
              stays readable in the audit trail.
            </>
          ) : (
            <>
              This records that the two are separate real movements. Nothing is discarded, and the
              pair stops being offered here.
            </>
          )
        }
        confirmLabel={decision === "confirm" ? "Confirm duplicate" : "Keep both"}
        confirmVariant="outline"
        reasonRequired={decision === "confirm"}
        reasonPlaceholder={
          decision === "confirm" ? "e.g. same UTR, imported from two statements" : undefined
        }
        pending={mutation.isPending}
        error={mutation.error}
        onConfirm={(reason) => {
          if (decision === null) return;
          mutation.mutate(
            {
              paymentId: item.payment.paymentId,
              duplicateOfPaymentId: item.candidate.paymentId,
              decision,
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: () => setDecision(null) },
          );
        }}
      />
    </div>
  );
}

/* ----------------------------------------------------------- rejected classification */

/** Money with no explanation. There is nothing to approve here — only somewhere to go next. */
/**
 * A payment whose proposal was declined, and the two ways forward from there.
 *
 * **Ask again** re-runs the model (ADR-0030); the declined decision stays on the record, and
 * what comes back is another proposal, not an approval. **Classify it yourself** is the
 * payment workspace, where a person states the counterparty and the cash-flow role directly.
 * Before this, a declined proposal was a dead end with a visible amount and no way to act on
 * it (audit row 09).
 */
function RejectedInspector({ item }: { item: RejectedClassificationItem }) {
  const [asking, setAsking] = useState(false);
  const reclassify = useReclassifyPayment();

  return (
    <div className="flex flex-col gap-6">
      <NoteList
        items={[
          {
            title: "This payment has no explanation",
            detail:
              "A proposal for it was declined. Until something accounts for it, this amount is " +
              "part of what a reconciliation reports as not yet explained.",
          },
        ]}
      />

      <Section title="The payment" headingId="inspector-payment">
        <PaymentSummary payment={item.payment} />
      </Section>

      <Section
        title="What to do about it"
        headingId="inspector-recovery"
        description="A declined proposal is not a decision about what this payment was — only about what it was not."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setAsking(true)}>
              Ask the model again
            </Button>
            <Link
              href={`/payments/${item.payment.paymentId}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Classify it yourself
            </Link>
          </div>
        }
      >
        <p className="max-w-prose text-meta text-ink-muted">
          Asking again records a fresh proposal for this queue; it approves nothing and does not
          erase the declined one. Classifying it yourself states the counterparty and the cash-flow
          role directly, which is the honest path when the model has already been wrong about it
          once.
        </p>
      </Section>

      <DecisionDialog
        open={asking}
        onClose={() => {
          setAsking(false);
          reclassify.reset();
        }}
        title="Ask the model again"
        consequence={
          <>
            This sends the payment to the model for a second opinion and records whatever comes back
            as a <strong>new proposal</strong> in this queue. It approves nothing, and the declined
            decision stays on the record.
          </>
        }
        confirmLabel="Ask again"
        reasonLabel="Why it is worth asking again"
        pending={reclassify.isPending}
        error={reclassify.error}
        onConfirm={(reason) => {
          reclassify.mutate(
            { paymentId: item.payment.paymentId, ...(reason === undefined ? {} : { reason }) },
            { onSuccess: () => setAsking(false) },
          );
        }}
      />

      <Section title="The declined decision" headingId="inspector-decision">
        <Facts>
          <Fact label="Decided">
            {item.decidedAt === null ? (
              <UnknownValue />
            ) : (
              <span className="tabular font-mono">{formatDateTime(item.decidedAt)}</span>
            )}
          </Fact>
          <Fact label="Decided by">{item.decidedBy ?? <UnknownValue />}</Fact>
          {item.expenseId !== null && (
            <Fact label="Expense produced">
              <Link
                href={`/expenses/${item.expenseId}`}
                className="text-accent underline-offset-2 hover:underline"
              >
                {item.expenseState === null ? "Open expense" : sentenceCase(item.expenseState)}
              </Link>
            </Fact>
          )}
        </Facts>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------- unmatched evidence */

/**
 * A stored document attached to nothing — the context re-attachment surface.
 *
 * Two lists, kept apart because they answer different questions: `candidateMatches` is the
 * receipt-total shortcut that works with no enrichment run at all (ADR-0037), while
 * `matchCandidates` is what the six-signal matcher recorded, each with its verdicts (ADR-0044).
 * Accepting one of the latter is the only path from an offer to a link.
 */
function UnmatchedEvidenceInspector({ item }: { item: UnmatchedEvidenceItem }) {
  const enrich = useEnrichEvidence();

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="The document"
        headingId="inspector-evidence"
        actions={
          <Link
            href={`/evidence/${item.evidenceId}`}
            className="text-meta text-accent underline-offset-2 hover:underline"
          >
            Open full inspector
          </Link>
        }
      >
        <Facts>
          <Fact label="Type">{evidenceTypeLabel(item.evidenceType)}</Fact>
          <Fact label="Captured" mono>
            {formatDateTime(item.capturedAt)}
          </Fact>
          <Fact label="Ingested" mono>
            {formatDateTime(item.ingestedAt)}
          </Fact>
          <Fact label="Receipt total" mono>
            {item.receiptTotal === null ? (
              <UnknownValue>Nothing has read this document yet</UnknownValue>
            ) : (
              <Money paise={item.receiptTotal} />
            )}
          </Fact>
        </Facts>
      </Section>

      {item.observation !== null && (
        <Section
          title="What was read off it"
          headingId="inspector-observation"
          description="A structured reading beside the immutable source, never replacing it."
        >
          <EvidenceObservationFacts observation={item.observation} />
        </Section>
      )}

      <Section
        title="Payments this could be about"
        headingId="inspector-candidates"
        description="Offers with their signal provenance. Accepting one is the only way to attach this document."
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={enrich.isPending}
            onClick={() => enrich.mutate(item.evidenceId)}
          >
            {enrich.isPending ? "Looking…" : "Find candidates"}
          </Button>
        }
      >
        <EvidenceMatchCandidates
          evidenceId={item.evidenceId}
          candidates={item.matchCandidates}
          enrichError={enrich.error}
        />
      </Section>

      {item.candidateMatches.length > 0 && (
        <Section
          title="Payments whose amount matches this receipt exactly"
          headingId="inspector-exact"
          description="An amount-only shortcut. It is not an offer to link, and it never was."
        >
          <ul className="flex flex-col">
            {item.candidateMatches.map((candidate) => (
              <li
                key={candidate.paymentId}
                className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-2 last:border-b-0"
              >
                <Link
                  href={`/payments/${candidate.paymentId}`}
                  className="font-mono text-meta text-accent underline-offset-2 hover:underline"
                >
                  {candidate.description}
                </Link>
                <span className="text-meta text-ink-muted">
                  {formatDate(candidate.occurredAt)} · <Money paise={candidate.amount} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="border-t border-rule pt-4">
        <ReasonRow reasons={item.reasons} label={reviewReasonLabel} />
      </div>
    </div>
  );
}
