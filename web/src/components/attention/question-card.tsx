"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/money";
import { PurposeChoice } from "@/components/attention/purpose-choice";
import { ReviewItemInspector } from "@/components/review/inspectors";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import type { AttentionFact, AttentionItem } from "@/lib/types";

/**
 * One question, the facts needed to answer it, and the way to answer it.
 *
 * Three rules hold here, and they are the difference between this and a wrapper around the
 * review queue:
 *
 *  - **The question leads.** Not the kind, not the amount, not a reason code — the sentence a
 *    person can actually answer. The kind is still carried, and still reaches Details.
 *  - **Only the facts needed to decide.** The API chose them; this renders them. The model, the
 *    prompt version and the stored proposal are not among them, and reach the reader only
 *    inside the inspector they open deliberately.
 *  - **Nothing is decided from this card.** *Answer this* reveals the existing inspector, whose
 *    every consequential button is a `DecisionDialog` that states what it will do (ADR-0049).
 *    There is no accept button here, and there is not going to be one.
 *
 * A question whose `kind` this UI has never seen still renders: the API wrote a real question
 * for it, and the inspector has its own fallback. A decision nobody can see is the one failure
 * a review surface cannot have.
 */
export function QuestionCard({
  item,
  openHref,
  headingLevel = 3,
}: {
  item: AttentionItem;
  openHref: string | null;
  /**
   * Which heading this question is, in the document it lands in.
   *
   * On the event screen these sit under "What still needs you", so `h3` is the level below it.
   * On **Needs attention** the page title is the only heading above them, and an `h3` there
   * skips a level — which axe reports and a screen reader navigating by heading trips over.
   */
  headingLevel?: 2 | 3;
}) {
  const [answering, setAnswering] = useState(false);
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <li className="border-b border-rule py-5 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <Heading className="text-emphasis font-medium text-ink">{item.question}</Heading>
          <p className="mt-1 max-w-prose text-meta text-ink-muted">{item.why}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          {item.amount.known && item.amount.value !== null ? (
            <Money paise={item.amount.value} />
          ) : (
            // Never `₹0.00` for an amount nobody has established (`web/CLAUDE.md`, rule 2).
            <span className="text-meta text-ink-faint italic">Amount not known</span>
          )}
          <span className="text-micro text-ink-faint">{formatDate(item.occurredAt)}</span>
        </div>
      </div>

      {/*
        `min-w-0` on the row, not decoration: a grid item's default `min-width: auto` sizes the
        track to its longest unbreakable string, so a long narration pushed the whole page wider
        than the phone it was on and the `truncate` below could never take effect.
      */}
      {/*
        The answer comes before the detail that supports it. A question about what a payment was
        for is answerable from what the system already read off the line, so the choice sits
        directly under the question — above the supporting facts, not below them, because on a
        phone every row of detail in front of it is another scroll between a person and the one
        tap that settles this.
      */}
      {item.suggestion !== null && (
        <PurposeChoice suggestion={item.suggestion} description={recordWords(item)} />
      )}
      <dl className="mt-4 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {item.facts.map((fact) => (
          <div key={fact.label} className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="shrink-0 text-micro text-ink-faint">{fact.label}</dt>
            <dd className="min-w-0 truncate text-meta text-ink">
              <FactValue fact={fact} />
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {item.item !== null && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={answering}
            onClick={() => setAnswering((open) => !open)}
          >
            {answering ? "Hide" : "Answer this"}
          </Button>
        )}
        {openHref !== null && (
          <Link href={openHref} className={buttonVariants({ variant: "link", size: "sm" })}>
            {openLabel(item)}
          </Link>
        )}
      </div>

      {answering && item.item !== null && (
        <div className="mt-5 border-t border-rule pt-5">
          <ReviewItemInspector item={item.item} />
        </div>
      )}
    </li>
  );
}

/** The line's own words, as the facts already carry them. */
function recordWords(item: AttentionItem): string {
  const fact = item.facts.find((candidate) => candidate.label === "What the record says");
  return typeof fact?.value === "string" ? fact.value : "this payment";
}

/** Where the link goes, said in terms of the thing it opens. */
function openLabel(item: AttentionItem): string {
  switch (item.subject.kind) {
    case "expense":
      return "Say who shared it";
    case "evidence":
      return "Open the record";
    default:
      return "See the whole event";
  }
}

/** A typed fact, rendered by its kind. Formatting only — nothing here computes anything. */
function FactValue({ fact }: { fact: AttentionFact }) {
  if (fact.value === null || fact.kind === "unknown") {
    return <span className="text-ink-faint italic">Not known yet</span>;
  }
  if (fact.kind === "money") return <Money paise={fact.value} />;
  if (fact.kind === "date")
    return <span className="tabular font-mono">{formatDate(fact.value)}</span>;
  return <>{fact.value}</>;
}

/** Where a question is answered, in the product's own routes. `null` when nowhere specific. */
export function questionHref(item: AttentionItem): string | null {
  switch (item.subject.kind) {
    case "payment":
    case "payment_pair":
      return `/connections/${item.subject.paymentId}`;
    case "evidence":
      return `/evidence/${item.subject.evidenceId}`;
    case "expense":
      // The share flow, not the ledger's expense screen: the question is "who shared this?",
      // and the answer is a person picking people, not choosing an allocation method.
      return `/expenses/${item.subject.expenseId}/share`;
  }
}
