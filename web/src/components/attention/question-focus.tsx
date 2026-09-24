"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PurposeChoice } from "@/components/attention/purpose-choice";
import { questionHref } from "@/components/attention/question-card";
import { Money } from "@/components/money";
import { ReviewItemInspector } from "@/components/review/inspectors";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import { reviewReasonLabel } from "@/lib/labels";
import type { AttentionFact, AttentionItem } from "@/lib/types";

/**
 * One question, on its own, with everything needed to answer it and nothing else.
 *
 * The list this replaced was correct and unusable at the size a real ledger reaches. Thirty-five
 * questions rendered as thirty-five cards, each with its own category buttons, is a screen a
 * person scrolls rather than a screen a person answers: the decision at the top and the decision
 * at the bottom look identical, and there is no point at which one of them is finished.
 *
 * So the queue is a queue. One question is on screen; answering it or setting it aside brings
 * the next. Three properties hold:
 *
 *  - **Nothing here decides anything on its own.** The category choice is `PurposeChoice`, whose
 *    every confirmation is a `DecisionDialog` stating what it will do (ADR-0049), and the
 *    fallback for everything else is the existing inspector. There is no one-click accept, and
 *    there is not going to be one.
 *  - **Setting one aside writes nothing at all.** *Decide later* moves this question to the back
 *    of *this visit* — it records no decision, no deferral, no note, and it is gone on the next
 *    page load. The wording says so, because a button that looked like it filed something would
 *    be a decision made by accident.
 *  - **Supporting records sit beside the decision, not under it.** On a wide screen the facts
 *    the API chose are the right-hand column; on a phone they follow the choice, because there
 *    the alternative is putting six rows of detail between a person and the one tap that
 *    settles this.
 *
 * A question whose `kind` this UI has never seen still renders: the API wrote a real question
 * for it, and the inspector has its own fallback. A decision nobody can see is the one failure
 * a review surface cannot have.
 */
export function QuestionFocus({
  item,
  position,
  remaining,
  setAsideCount,
  focusOnMount,
  onDecideLater,
}: {
  item: AttentionItem;
  /** Which question this is, 1-based, of the ones not set aside. A count, never money. */
  position: number;
  remaining: number;
  setAsideCount: number;
  /**
   * Whether this question replaced another one, rather than being the first thing the reader
   * arrived at.
   *
   * The caller decides, because the caller is the only one that can: this component is mounted
   * under a `key` of the question's id, so a replacement is a **fresh mount** and an internal
   * "have I rendered before?" ref is always `true` here. Focusing unconditionally would be
   * worse than not focusing at all — arriving on the page would yank the cursor off the skip
   * link and into the middle of the document.
   */
  focusOnMount: boolean;
  onDecideLater: () => void;
}) {
  const [showInspector, setShowInspector] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus follows the question. Without it, answering or setting one aside swaps the content
  // under a keyboard user's cursor and leaves them at the top of the document with no
  // announcement that anything changed — the screen-reader equivalent of the page silently
  // scrolling away.
  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
    // Mount only: `focusOnMount` describes how this instance came to exist, and this component
    // is remounted for every question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const href = questionHref(item);

  return (
    <section aria-labelledby="focus-question" className="flex flex-col gap-6">
      <p className="text-meta text-ink-muted">
        <span className="font-mono">
          {position} of {remaining}
        </span>
        {setAsideCount > 0 && (
          <span className="text-ink-faint">
            {" · "}
            {setAsideCount} set aside for now
          </span>
        )}
      </p>

      <div className="rounded-sm border border-rule-strong bg-panel p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
          <div className="min-w-0">
            <h2
              id="focus-question"
              ref={heading}
              tabIndex={-1}
              className="text-h1 font-serif font-medium tracking-tight text-balance text-ink"
            >
              {item.question}
            </h2>
            <p className="mt-2 max-w-prose text-body text-ink-muted">{item.why}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {item.amount.known && item.amount.value !== null ? (
              <Money paise={item.amount.value} size="figure" />
            ) : (
              // Never `₹0.00` for an amount nobody has established (`web/CLAUDE.md`, rule 2).
              <span className="text-body text-ink-faint italic">Amount not known</span>
            )}
            <span className="text-micro text-ink-faint">{formatDate(item.occurredAt)}</span>
          </div>
        </div>

        {/*
          The decision on the left, what it is about on the right. `lg` rather than `sm`: at
          tablet width two columns would leave the category buttons in a channel too narrow to
          read their own reasons, which is the thing this layout exists to keep visible.
        */}
        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="min-w-0">
            {item.suggestion !== null ? (
              <PurposeChoice suggestion={item.suggestion} description={recordWords(item)} />
            ) : (
              <NoSuggestion item={item} href={href} />
            )}
          </div>

          <div className="min-w-0">
            <h3 className="text-meta font-medium text-ink-muted">Supporting records</h3>
            <dl className="mt-3 flex flex-col divide-y divide-rule border-y border-rule">
              {item.facts.map((fact) => (
                <div key={fact.label} className="flex min-w-0 items-baseline gap-3 py-2.5">
                  <dt className="w-32 shrink-0 text-micro text-ink-faint">{fact.label}</dt>
                  <dd className="min-w-0 flex-1 text-meta break-words text-ink">
                    <FactValue fact={fact} />
                  </dd>
                </div>
              ))}
            </dl>
            {readableReasons(item).length > 0 && (
              <>
                <h3 className="mt-5 text-meta font-medium text-ink-muted">Why this came up</h3>
                <ul className="mt-2 flex flex-col gap-1">
                  {readableReasons(item).map((reason) => (
                    <li key={reason} className="text-meta text-ink-muted">
                      {reviewReasonLabel(reason)}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {href !== null && (
              <Link
                href={href}
                className="mt-4 inline-block text-meta text-accent underline underline-offset-2"
              >
                See everything about this
              </Link>
            )}
          </div>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-rule pt-6">
          <Button variant="outline" onClick={onDecideLater}>
            Decide later
          </Button>
          <p className="max-w-prose text-meta text-ink-faint">
            Sets this one aside for the rest of this visit. It records nothing, changes nothing, and
            will be back next time you open this page.
          </p>
        </div>

        {/*
          Everything the queue's own inspector can do, one disclosure away rather than gone. For
          a question with no suggestion it is the only way to answer, so it is offered plainly;
          for one with a suggestion it is the way to do something the three buttons above do not
          cover.
        */}
        {item.item !== null && (
          <div className="mt-6 border-t border-rule pt-6">
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showInspector}
              onClick={() => setShowInspector((open) => !open)}
            >
              {showInspector ? "Hide the other ways to answer this" : "Other ways to answer this"}
            </Button>
            {showInspector && (
              <div className="mt-5">
                <ReviewItemInspector item={item.item} />
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** A question the ledger could not read a suggestion for — say so, and point at the answer. */
function NoSuggestion({ item, href }: { item: AttentionItem; href: string | null }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-sm border border-rule p-5">
      <p className="max-w-prose text-body text-ink">
        There is no shortcut for this one — it needs a look at the records themselves.
      </p>
      {href !== null && (
        <Link href={href} className={buttonVariants({ size: "sm" })}>
          {openLabel(item)}
        </Link>
      )}
    </div>
  );
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

/**
 * Reasons worth printing, which is not all of them.
 *
 * Two filters, both from the language rules for a primary screen. **A confidence score never
 * reaches this screen as a score** — `PurposeChoice` says "This is probably" and "This might
 * be", which is a phrase somebody calibrates against; "Low confidence" beside it is the same
 * fact stated as a measurement, and inviting a reader to trust the arithmetic behind it is the
 * thing that wording exists to avoid. And **a reason the suggestion already gives in its own
 * words is not repeated**: the specific evidence ("The description says …") is on the choice
 * itself, so a question carrying a reading needs nothing generic here at all.
 *
 * What survives is the reason a question with no suggestion is being asked — "Resembles another
 * payment", "More than one payment could match" — which is real information and has no other
 * home on this screen.
 */
const CONFIDENCE_SHAPED_REASONS: ReadonlySet<string> = new Set(["low_confidence"]);

function readableReasons(item: AttentionItem): readonly string[] {
  if (item.suggestion !== null) return [];
  return item.reasons.filter((reason) => !CONFIDENCE_SHAPED_REASONS.has(reason));
}

/** The line's own words, as the facts already carry them. */
function recordWords(item: AttentionItem): string {
  const fact = item.facts.find((candidate) => candidate.label === "What the record says");
  return typeof fact?.value === "string" ? fact.value : "this payment";
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
