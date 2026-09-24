"use client";

import Link from "next/link";
import { QuestionCard, questionHref } from "@/components/attention/question-card";
import { MatchDecision } from "@/components/connections/match-decision";
import { InstalmentTimeline } from "@/components/instalments/instalment-timeline";
import { Money } from "@/components/money";
import { PageHeader, Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, FigureSkeleton, LoadingStatus } from "@/components/status";
import { buttonVariants } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/dates";
import { paymentNatureLabel, sentenceCase } from "@/lib/labels";
import { useConnection, useInstalments } from "@/lib/queries";
import type {
  ConnectionExpense,
  ConnectionProposal,
  ConnectionResult,
  ConnectionSupportingRecord,
} from "@/lib/types";

/**
 * One real-world financial event, on one screen.
 *
 * The screen this replaces as a front door was called "Payment context" and opened with the
 * words *narration*, *observation*, *derivation* and *evidence match candidate*. All of that is
 * true, all of it is still reachable, and none of it is what somebody arrives wanting to know,
 * which is: what happened, what records say so, what has been connected, and what still needs
 * them. Those are the four questions this answers, in that order.
 *
 * Every figure comes from the one `/api/connections/:paymentId` read. Nothing on this screen
 * adds, subtracts or totals anything — including the thing it would be most tempting to total,
 * the shares, which arrive as the approval wrote them.
 *
 * **The one-event rule is the layout.** The payment and its supporting records are one bordered
 * group under one count, never a list of rows that could be read as several purchases, and the
 * amount at the top is the event's — not the sum of anything below it.
 */
export function Connection({ paymentId }: { paymentId: string }) {
  const query = useConnection(paymentId);

  if (query.isPending) {
    return (
      <LoadingStatus label="Putting this payment's records together">
        <div className="flex flex-col gap-4">
          <FigureSkeleton />
        </div>
      </LoadingStatus>
    );
  }
  if (query.isError) {
    return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />;
  }

  const event = query.data;

  return (
    <div className="flex flex-col gap-8">
      <Headline event={event} />
      {event.openQuestions.length > 0 && <NeedsYouCallout count={event.openQuestions.length} />}
      <Records event={event} />
      {/*
        Only when this payment is actually part of a plan. A plan explains the row the reader is
        looking at, so it belongs beside it rather than on a screen of its own.
      */}
      <PaymentInstalmentPlan paymentId={paymentId} />
      {event.proposals.length > 0 && (
        <Proposals proposals={event.proposals} paymentName={event.title.text} />
      )}
      <WhatItWasFor event={event} />
      {(event.settlements.length > 0 || event.refundOf.length > 0) && <MoneyMoved event={event} />}
      {event.openQuestions.length > 0 && <Questions event={event} />}
      <Details event={event} />
    </div>
  );
}

/* --------------------------------------------------------------------------- headline */

/** What happened — the one hero figure on this screen, and what kind of event it was. */
function Headline({ event }: { event: ConnectionResult }) {
  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title={event.title.text}
        description={`${paymentNatureLabel(event.nature)} · ${formatDate(event.occurredAt)} · ${event.accountName}${
          event.title.source === "narration" ? " · named by your bank, not by you" : ""
        }`}
      />
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div className="flex flex-col gap-1">
          <span className="text-meta text-ink-muted">
            {event.direction === "debit" ? "You paid" : "You received"}
          </span>
          <Money
            paise={event.amount}
            tone={event.direction === "debit" ? "neutral" : "credit"}
            size="display"
          />
        </div>
        <div className="flex flex-col gap-1 pb-1">
          {event.countsAsSpending ? (
            <>
              <span className="text-meta text-ink-muted">Counted as spending</span>
              <Money paise={event.spendingContribution} />
            </>
          ) : (
            <>
              <span className="text-meta text-ink-muted">Not counted as spending</span>
              <span className="max-w-prose text-micro text-ink-faint">{event.whyNotSpending}</span>
            </>
          )}
        </div>
        <div className="flex flex-col gap-1 pb-1">
          <span className="text-meta text-ink-muted">Still unaccounted for</span>
          {event.unaccountedFor.known && event.unaccountedFor.amount !== null ? (
            // `fullyAccountedFor` is the API's judgement, not a comparison made here: a zero is
            // good news or bad news depending on whether anybody finished looking.
            <Money
              paise={event.unaccountedFor.amount}
              tone={event.fullyAccountedFor ? "credit" : "debit"}
            />
          ) : (
            <span className="max-w-prose text-micro text-ink-faint">
              {event.unaccountedFor.unknownReason ?? "Not known"}
            </span>
          )}
          {event.fullyAccountedFor && (
            <span className="text-micro text-ink-faint">everything here is accounted for</span>
          )}
        </div>
      </div>
      {event.duplicate.isDuplicate && event.duplicate.ofPaymentId !== null && (
        <p className="max-w-prose text-meta text-attention">
          This is the same money as another record, so nothing here is counted.{" "}
          <Link
            href={`/connections/${event.duplicate.ofPaymentId}`}
            className="text-accent underline underline-offset-2"
          >
            See the one that counts
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function NeedsYouCallout({ count }: { count: number }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-sm border border-rule bg-panel p-4">
      <p className="text-emphasis font-medium text-ink">
        {count === 1 ? "One thing here needs you" : `${count} things here need you`}
      </p>
      <a href="#needs-you" className={buttonVariants({ variant: "outline", size: "sm" })}>
        Go to the questions
      </a>
    </div>
  );
}

/* ---------------------------------------------------------------------------- records */

/**
 * The one-event rule, drawn.
 *
 * A payment, and beneath it every record that describes the same purchase, inside one border
 * and under one count. The alternative — three rows of equal weight — is exactly the reading
 * this product exists to prevent: three records are not three purchases.
 */
function Records({ event }: { event: ConnectionResult }) {
  const supporting = event.supportingRecords;
  return (
    <Section
      title="Records for this"
      headingId="connection-records"
      description={
        supporting.length === 0
          ? "One record so far. A bill, a receipt or a screenshot is what says what it was for."
          : `One payment, and ${supporting.length} record${supporting.length === 1 ? "" : "s"} describing the same thing.`
      }
    >
      <ul className="flex flex-col divide-y divide-rule rounded-sm border border-rule">
        <li className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 p-4">
          <span className="flex min-w-0 flex-col">
            <span className="text-meta text-ink-muted">Payment</span>
            <span className="truncate text-body text-ink">{event.narration}</span>
          </span>
          <span className="flex shrink-0 items-baseline gap-3">
            <span className="text-micro text-ink-faint">{formatDate(event.occurredAt)}</span>
            <Money paise={event.amount} />
          </span>
        </li>
        {supporting.map((record) => (
          <SupportingRow key={record.evidenceId} record={record} />
        ))}
      </ul>
      {supporting.length === 0 && (
        <p className="mt-3 max-w-prose text-meta text-ink-muted">
          Nothing else on file describes this payment yet.{" "}
          <Link href="/add" className="text-accent underline underline-offset-2">
            Add a bill, a receipt or a screenshot
          </Link>{" "}
          and the system will propose the connection.
        </p>
      )}
    </Section>
  );
}

function SupportingRow({ record }: { record: ConnectionSupportingRecord }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 p-4 pl-8">
      <span className="flex min-w-0 flex-col">
        <span className="text-meta text-ink-muted">{record.label}</span>
        <Link
          href={`/evidence/${record.evidenceId}`}
          className="truncate text-body text-accent underline underline-offset-2"
        >
          {record.reading?.name ?? "Open this record"}
        </Link>
      </span>
      <span className="flex shrink-0 items-baseline gap-3">
        <span className="text-micro text-ink-faint">{formatDate(record.capturedAt)}</span>
        {record.reading?.amount !== undefined && record.reading?.amount !== null ? (
          <Money paise={record.reading.amount} />
        ) : (
          <span className="text-micro text-ink-faint italic">Not read yet</span>
        )}
      </span>
    </li>
  );
}

/* -------------------------------------------------------------------------- proposals */

/**
 * What the system thinks might belong here, and why. Offers, never connections.
 *
 * The answer is given here, beside the reasons, rather than on a screen somewhere else: a
 * person reading why two records look like one thing is exactly the person who can say whether
 * they are. The write is `services.decideEvidenceMatch` — the same one the review inspector
 * calls, behind the same kind of dialog — so there is no second path to a link and no
 * one-click accept (ADR-0034, ADR-0049).
 */
function Proposals({
  proposals,
  paymentName,
}: {
  proposals: readonly ConnectionProposal[];
  paymentName: string;
}) {
  const waiting = proposals.filter((proposal) => proposal.status === "proposed").length;
  return (
    <Section
      title="Possible matches"
      headingId="connection-proposals"
      // "Nothing is attached until you say so" is true of an offer and false of one already
      // answered, and this list keeps both. Saying the wrong one over a decided row invites
      // somebody to look for a button that is not there.
      description={
        waiting === 0
          ? "Records this payment was compared against. Every one of these has already been answered."
          : "Records that look like they are about this payment. Nothing is attached until you say so."
      }
    >
      <ul className="flex flex-col divide-y divide-rule border-y border-rule">
        {proposals.map((proposal) => (
          <li key={proposal.candidateId} className="flex flex-col gap-2 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <Link
                href={`/evidence/${proposal.evidenceId}`}
                className="text-body text-accent underline underline-offset-2"
              >
                {proposal.label}
              </Link>
              <span className="text-micro text-ink-faint">
                {proposal.status === "proposed"
                  ? "Waiting on you"
                  : `${sentenceCase(proposal.status)}${proposal.decidedAt === null ? "" : ` · ${formatDate(proposal.decidedAt)}`}`}
              </span>
            </div>
            {proposal.whyRelated.length > 0 && (
              <div>
                <p className="text-micro text-ink-faint">Why this looks related</p>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {proposal.whyRelated.map((reason) => (
                    <li key={reason} className="text-meta text-ink-muted">
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {proposal.whyUnsure.length > 0 && (
              <div>
                <p className="text-micro text-ink-faint">Why it might not be</p>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {proposal.whyUnsure.map((reason) => (
                    <li key={reason} className="text-meta text-attention">
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {proposal.status === "proposed" && (
              <div className="mt-1">
                <MatchDecision
                  candidateId={proposal.candidateId}
                  recordLabel={proposal.label}
                  paymentName={paymentName}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ------------------------------------------------------------------ what it was for */

function WhatItWasFor({ event }: { event: ConnectionResult }) {
  if (event.expenses.length === 0) {
    return (
      <Section
        title="What it was for"
        headingId="connection-purpose"
        description={event.countsAsSpending ? undefined : (event.whyNotSpending ?? undefined)}
      >
        {/*
          The reason is already the section's description when there is one, so repeating it
          inside the block said the same sentence twice and offered nothing to do about it.
          What belongs here is the way out: the record that would answer the question.
        */}
        <EmptyBlock>
          <div className="flex flex-col items-start gap-3">
            <p className="text-body text-ink">Nothing on record says what this was for yet.</p>
            <p className="max-w-prose text-meta text-ink-muted">
              A bill, a receipt or the payment message usually says it. Add one and this will
              suggest the connection itself.
            </p>
            <Link href="/add" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Add a bill or receipt
            </Link>
          </div>
        </EmptyBlock>
      </Section>
    );
  }

  return (
    <Section
      title="What it was for"
      headingId="connection-purpose"
      description="What the money bought, who fronted it, and who benefited."
    >
      <ul className="flex flex-col gap-6">
        {event.expenses.map((expense) => (
          <ExpenseBlock key={expense.expenseId} expense={expense} />
        ))}
      </ul>
    </Section>
  );
}

function ExpenseBlock({ expense }: { expense: ConnectionExpense }) {
  return (
    <li className="flex flex-col gap-3 border-t border-rule pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <Link
          href={`/expenses/${expense.expenseId}`}
          className="min-w-0 truncate text-body text-accent underline underline-offset-2"
        >
          {expense.whatItWas ?? "Not described yet"}
        </Link>
        <span className="flex shrink-0 items-baseline gap-3">
          {expense.category !== null && (
            <span className="text-micro text-ink-faint">{expense.category}</span>
          )}
          <Money paise={expense.netAmount} />
        </span>
      </div>

      <p className="text-meta text-ink-muted">
        {expense.paidBy.isYou ? "You paid" : `Paid by ${expense.paidBy.name}`}
        {expense.grossAmount !== expense.netAmount && (
          <span className="text-ink-faint">
            {" "}
            · originally <Money paise={expense.grossAmount} className="text-meta" />, before money
            came back
          </span>
        )}
      </p>

      {expense.shares === null ? (
        <p className="max-w-prose text-meta text-attention">
          {expense.sharesUnknownReason}{" "}
          <Link
            href={`/expenses/${expense.expenseId}/share`}
            className="text-accent underline underline-offset-2"
          >
            Say who shared it
          </Link>
          .
        </p>
      ) : (
        <div>
          <p className="text-micro text-ink-faint">Shared with</p>
          <ul className="mt-1 flex flex-col divide-y divide-rule border-y border-rule">
            {expense.shares.map((share) => (
              <li
                key={`${share.beneficiaryKind}:${share.name}`}
                className="flex flex-wrap items-baseline justify-between gap-3 py-2"
              >
                <span className="min-w-0 truncate text-body text-ink">
                  {share.isYou ? "You" : share.name}
                  {share.members !== null && share.members.length > 0 && (
                    <span className="ml-2 text-micro text-ink-faint">
                      {share.members.map((member) => member.name).join(", ")}
                    </span>
                  )}
                </span>
                <Money paise={share.amount} />
              </li>
            ))}
          </ul>
          {expense.obligationNote !== null && (
            // The API's sentence. Working it out here would mean asserting a debt for a
            // `personal` or `gift` expense, which divides without creating one at all.
            <p className="mt-2 max-w-prose text-micro text-ink-faint">{expense.obligationNote}</p>
          )}
        </div>
      )}

      {expense.refunds.length > 0 && (
        <div>
          <p className="text-micro text-ink-faint">Money that came back</p>
          <ul className="mt-1 flex flex-col gap-1">
            {expense.refunds.map((refund) => (
              <li
                key={refund.adjustmentId}
                className="flex flex-wrap items-baseline justify-between gap-3 text-meta text-ink-muted"
              >
                <span>
                  {refund.label} · {formatDate(refund.occurredAt)}
                </span>
                <Money paise={refund.amount} tone="credit" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------- settled / refunded */

function MoneyMoved({ event }: { event: ConnectionResult }) {
  return (
    <Section
      title="What this settled"
      headingId="connection-settled"
      description="Money that paid off a debt, or came back against something already bought. Neither is new spending."
    >
      <ul className="flex flex-col divide-y divide-rule border-y border-rule">
        {event.settlements.map((settlement) => (
          <li
            key={settlement.settlementId}
            className="flex flex-wrap items-baseline justify-between gap-3 py-2"
          >
            <span className="min-w-0 truncate text-body text-ink">{settlement.label}</span>
            <Money paise={settlement.amount} />
          </li>
        ))}
        {event.refundOf.map((refund) => (
          <li
            key={refund.adjustmentId}
            className="flex flex-wrap items-baseline justify-between gap-3 py-2"
          >
            <span className="min-w-0 truncate text-body text-ink">
              {refund.label}
              {refund.whatItWas !== null && (
                <span className="text-ink-muted"> · {refund.whatItWas}</span>
              )}
            </span>
            <Money paise={refund.amount} tone="credit" />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ------------------------------------------------------------------------- questions */

function Questions({ event }: { event: ConnectionResult }) {
  return (
    <section aria-labelledby="needs-you" id="needs-you">
      <div className="mb-3">
        <h2 id="needs-you" className="text-emphasis font-medium text-ink">
          What still needs you
        </h2>
        <p className="mt-1 max-w-prose text-meta text-ink-muted">
          Nothing here changes anything until you choose. Every answer is recorded with your reason.
        </p>
      </div>
      <ul className="flex flex-col border-y border-rule">
        {event.openQuestions.map((question) => (
          <QuestionCard key={question.id} item={question} openHref={questionHref(question)} />
        ))}
      </ul>
    </section>
  );
}

/* --------------------------------------------------------------------------- details */

/**
 * The immutable source and the stored states, behind a disclosure.
 *
 * Kept, not hidden. This is the same trail the specialist screens show, and everything a person
 * needs to audit a figure is one click from the figure — it is simply not the first thing the
 * screen says, because none of it answers "what happened?".
 */
function Details({ event }: { event: ConnectionResult }) {
  return (
    <details className="rounded-sm border border-rule p-4">
      <summary className="cursor-pointer text-meta text-ink-muted">
        Details and history — the original record, exactly as it arrived
      </summary>
      <div className="mt-4 flex flex-col gap-4">
        <div>
          <p className="text-micro text-ink-faint">What the bank wrote, unchanged</p>
          <p className="mt-1 rounded-sm border border-rule bg-panel p-3 font-mono text-body break-all text-ink">
            {event.narration}
          </p>
        </div>

        {event.disagreements.length > 0 && (
          <div>
            <p className="text-micro text-ink-faint">Where the records disagree</p>
            <ul className="mt-1 flex flex-col gap-2">
              {event.disagreements.map((disagreement) => (
                <li key={disagreement.about} className="text-meta text-ink-muted">
                  <span className="text-ink">{sentenceCase(disagreement.about)}:</span>{" "}
                  {disagreement.detail}
                  <span className="mt-0.5 block font-mono text-micro">
                    {disagreement.values.join("  ·  ")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <dl className="flex flex-col">
          <DetailRow label="Recorded at" value={formatDateTime(event.occurredAt)} />
          <DetailRow label="Account" value={event.accountName} />
          <DetailRow label="Channel" value={sentenceCase(event.details.channel)} />
          <DetailRow label="Reference" value={event.details.reference} mono />
          <DetailRow
            label="Counterparty type"
            value={sentenceCase(event.details.counterpartyType)}
          />
          <DetailRow label="Payment state" value={sentenceCase(event.details.paymentState)} />
          <DetailRow
            label="Cash-flow category"
            value={
              event.details.cashFlowCategory === null
                ? null
                : sentenceCase(event.details.cashFlowCategory)
            }
          />
          <DetailRow label="Cash-flow state" value={sentenceCase(event.details.cashFlowState)} />
          <DetailRow label="Import batch" value={event.details.importBatchId} mono />
        </dl>

        <div className="flex flex-wrap gap-3">
          <Link
            href={`/payments/${event.paymentId}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Open the payment workspace
          </Link>
        </div>
      </div>
    </details>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule py-2 last:border-b-0">
      <dt className="text-meta text-ink-muted">{label}</dt>
      <dd className={mono ? "tabular font-mono text-body text-ink" : "text-body text-ink"}>
        {value ?? <span className="text-ink-faint italic">Not recorded</span>}
      </dd>
    </div>
  );
}

/**
 * The instalment plan this payment belongs to, when it belongs to one.
 *
 * Renders nothing at all otherwise — including while loading and on failure. A plan is context
 * for a row, not the answer to a question somebody asked, so a skeleton or an error block here
 * would put a reader's attention on the absence of something they did not request. The rows
 * themselves are already on screen above, from a read that did succeed.
 */
function PaymentInstalmentPlan({ paymentId }: { paymentId: string }) {
  const instalments = useInstalments();
  if (!instalments.isSuccess) return null;

  const plan = instalments.data.plans.find(
    (candidate) =>
      candidate.positions.some((entry) =>
        entry.charges.some((charge) => charge.paymentId === paymentId),
      ) || candidate.unpositionedCharges.some((charge) => charge.paymentId === paymentId),
  );
  if (plan === undefined) return null;

  return <InstalmentTimeline plan={plan} />;
}
