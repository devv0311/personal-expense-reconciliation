"use client";

import Link from "next/link";
import { Money } from "@/components/money";
import { formatDate } from "@/lib/dates";
import type { InstalmentCharge, InstalmentPlan, InstalmentTimelineEntry } from "@/lib/types";

/**
 * What the statement said about one instalment plan, and — just as prominently — what it did not.
 *
 * [ADR-0062](../../../../docs/decisions/0062-an-instalment-plan-is-a-timeline-of-what-the-statement-said.md).
 *
 * A financed purchase reaches a statement as four unrelated-looking rows on four dates. This puts
 * them in one place and says which instalment each belongs to. Three rules shape how it renders:
 *
 *  - **An expected step looks different from an observed one, and carries no figure.** The API
 *    says which is which; this never infers it from whether an amount happens to be present. A
 *    row of dashes where a reader expects money is the correct rendering of "the statement says
 *    there are six of these and we have seen three".
 *  - **The unknowns are content, not a footnote.** "When the next one is due" is the first thing
 *    somebody wants and the one thing a statement never says. Burying that would leave a reader
 *    assuming the absence is a bug.
 *  - **Nothing here is a decision.** There is no button. A plan is a reading of immutable rows,
 *    and the rows are linked so the reader can go and look.
 */
export function InstalmentTimeline({ plan }: { plan: InstalmentPlan }) {
  return (
    <section aria-labelledby="instalment-plan" className="flex flex-col gap-5">
      <div>
        <h2 id="instalment-plan" className="text-emphasis font-serif font-medium text-ink">
          Paying for this over time
        </h2>
        <p className="mt-1 max-w-prose text-meta text-ink-muted">{progressSentence(plan)}</p>
      </div>

      <ol className="flex flex-col divide-y divide-rule border-y border-rule">
        {plan.positions.map((entry) => (
          <TimelineStep key={entry.number} entry={entry} />
        ))}
      </ol>

      {plan.unpositionedCharges.length > 0 && (
        <div>
          <h3 className="text-meta font-medium text-ink-muted">
            Also charged, without saying which instalment
          </h3>
          <ul className="mt-2 flex flex-col divide-y divide-rule border-y border-rule">
            {plan.unpositionedCharges.map((charge) => (
              <li key={charge.paymentId} className="flex items-baseline justify-between gap-3 py-2">
                <ChargeLabel charge={charge} />
                <Money paise={charge.amount} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-sm border border-rule p-4">
        <h3 className="text-meta font-medium text-ink-muted">What this does not tell you</h3>
        <ul className="mt-2 flex max-w-prose list-disc flex-col gap-1.5 pl-4">
          {plan.unknowns.map((unknown) => (
            <li key={unknown} className="text-meta text-ink-muted">
              {unknown}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * How far along the plan is, in the only terms the statement supports.
 *
 * With no stated tenure this says how many repayments have been seen and stops. It must never
 * say "of six" over a plan whose length nobody printed.
 */
function progressSentence(plan: InstalmentPlan): string {
  const seen = plan.progress.seen;
  const repayments = seen === 1 ? "one repayment" : `${String(seen)} repayments`;
  if (plan.progress.of === null) {
    return `${capitalise(repayments)} on file. The statement does not say how many there are in total.`;
  }
  return `${capitalise(repayments)} on file, of the ${String(plan.progress.of)} the statement says there are.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function TimelineStep({ entry }: { entry: InstalmentTimelineEntry }) {
  const observed = entry.certainty === "observed";
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 py-3">
      <span className="flex min-w-0 items-baseline gap-3">
        <span
          aria-hidden="true"
          className={`flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-micro ${
            observed ? "border-rule-strong text-ink" : "border-rule text-ink-faint"
          }`}
        >
          {entry.number}
        </span>
        <span className="min-w-0">
          <span className={`block text-body ${observed ? "text-ink" : "text-ink-faint"}`}>
            {observed
              ? `Instalment ${String(entry.number)}`
              : `Instalment ${String(entry.number)} — not yet on a statement`}
          </span>
          {observed && entry.charges[0] !== undefined && (
            <span className="mt-0.5 block text-micro text-ink-faint">
              {formatDate(entry.charges[0].occurredAt)}
            </span>
          )}
        </span>
      </span>

      {observed ? (
        <span className="flex shrink-0 flex-wrap items-baseline gap-x-5 gap-y-1">
          <Component label="Repaid" amount={entry.principal} />
          <Component label="Interest" amount={entry.interest} />
          <Component label="Tax" amount={entry.tax} />
        </span>
      ) : (
        // Never a zero and never a guess: the statement stated a count, not an amount.
        <span className="shrink-0 text-meta text-ink-faint italic">
          Nothing on file for this one
        </span>
      )}
    </li>
  );
}

/** One component of an instalment. Absent is rendered as absent, never as ₹0.00. */
function Component({ label, amount }: { label: string; amount: string | null }) {
  return (
    <span className="flex flex-col items-end">
      <span className="text-micro text-ink-faint">{label}</span>
      {amount === null ? (
        <span className="text-meta text-ink-faint">—</span>
      ) : (
        <Money paise={amount} />
      )}
    </span>
  );
}

const COMPONENT_WORDS: Record<InstalmentCharge["component"], string> = {
  principal: "Repayment",
  interest: "Interest",
  tax: "Tax on the interest",
  fee: "Fee",
};

function ChargeLabel({ charge }: { charge: InstalmentCharge }) {
  return (
    <Link
      href={`/connections/${charge.paymentId}`}
      className="min-w-0 truncate text-body text-ink hover:underline"
    >
      {COMPONENT_WORDS[charge.component]}
      <span className="ml-2 text-micro text-ink-faint">{formatDate(charge.occurredAt)}</span>
    </Link>
  );
}
