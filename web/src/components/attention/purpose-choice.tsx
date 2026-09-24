"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useDecideInference } from "@/lib/queries";
import type { AttentionSuggestion } from "@/lib/types";

/**
 * What this payment looks like it was for — and the one tap that makes it true.
 *
 * The system reads a statement line's own wording and says, in a sentence, what it thinks and
 * why. That is a **suggestion**: it sits on the screen until somebody agrees with it, and
 * agreeing goes through the same recorded decision as any other proposal. Nothing here writes
 * a category on its own, and no wording on this component names a classifier, a model, a
 * confidence score or a rule.
 *
 * Three things it is careful about:
 *
 *  - **It says how sure it is, in words.** "Looks like" and "This might be" are not decoration:
 *    a hint stated confidently is how somebody is talked into a wrong total.
 *  - **It warns first when the line is not a purchase.** A statement's tax lines, instalment
 *    interest and repayments are not things anybody bought; agreeing with a category on one of
 *    them is how the same money reaches a total twice, so the caution comes before the buttons.
 *  - **Every choice is visible without hovering or expanding anything.** The recommendation,
 *    the alternatives worth offering and why each one is offered are all on the card;
 *    **Choose another category** opens the full list in place. A reason that only appears on
 *    hover is a reason a phone never shows at all.
 */
export function PurposeChoice({
  suggestion,
  description,
}: {
  suggestion: AttentionSuggestion;
  /** The line's own words, quoted in the dialog so a decision names what it is deciding. */
  description: string;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [showFullList, setShowFullList] = useState(false);
  const [chosen, setChosen] = useState("");
  const decide = useDecideInference();
  // Unique per card: this component renders once per question, and a fixed id would point
  // every label on the page at the first card's control.
  const listId = useId();

  // With nothing proposed yet there is nothing to agree with: the reading is shown as an
  // explanation, and the way to get a decision is to analyse the records.
  const canConfirm = suggestion.inferenceId !== null;

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-sm border border-rule bg-panel p-4">
      {!suggestion.countsAsPurchase && (
        <p className="text-meta text-attention">
          This line is not a purchase of its own — filing it as one would count the same money
          twice.
        </p>
      )}

      <div>
        <p className="text-body text-ink">
          {suggestion.category === null ? (
            "Nothing in the wording says what this was for."
          ) : (
            <>
              {sureness(suggestion.confidence)}{" "}
              <strong className="font-medium">{suggestion.category}</strong>
            </>
          )}
        </p>
        <ul className="mt-1 flex max-w-prose flex-col gap-0.5">
          {suggestion.why.map((line) => (
            <li key={line} className="text-meta text-ink-muted">
              {line}
            </li>
          ))}
        </ul>
        {/*
          When one of the person's own approved patterns chose this category, say so and link to
          where it can be changed. A rule that quietly reordered a suggestion with nothing on
          screen naming it would be the invisible learning ADR-0064 replaced.
        */}
        {suggestion.appliedRule != null && (
          <p className="mt-2 max-w-prose text-meta text-ink-muted">
            This came from your own rule{" "}
            <strong className="font-medium">{suggestion.appliedRule.ruleName}</strong>.{" "}
            <Link href="/automation" className="text-accent underline underline-offset-2">
              Change or switch it off
            </Link>
          </p>
        )}
      </div>

      {canConfirm && (
        <div className="flex w-full flex-col gap-3">
          {/*
            The recommendation is full height, unlike every other control on this card. This is
            the one tap the whole screen exists for; the alternatives and the full list beneath
            it are the ways *not* to take it, and they stay `sm` so the recommendation is
            unmistakable without the card being loud.
          */}
          {suggestion.category !== null && (
            <Button className="self-start" onClick={() => setPending(suggestion.category)}>
              Yes, {suggestion.category.toLowerCase()}
            </Button>
          )}

          {suggestion.alternatives.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-micro text-ink-faint">Or file it as:</p>
              <ul className="flex flex-col gap-1.5">
                {suggestion.alternatives.map((alternative) => (
                  <li
                    key={alternative.category}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPending(alternative.category)}
                    >
                      {alternative.category}
                    </Button>
                    {/*
                      Visible, not a `title`. A tooltip is unreachable on a phone and invisible
                      to anybody not holding a mouse, so the reason an alternative is offered
                      would simply not exist for them.
                    */}
                    <span className="min-w-0 text-meta text-ink-muted">{alternative.why}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Button
            size="sm"
            variant="outline"
            className="self-start"
            aria-expanded={showFullList}
            aria-controls={showFullList ? listId : undefined}
            onClick={() => setShowFullList((open) => !open)}
          >
            Choose another category
          </Button>
        </div>
      )}

      {!canConfirm && (
        <p className="max-w-prose text-meta text-ink-muted">
          Nothing is suggested for this payment yet — its wording did not say enough. You can still
          say what it was on the payment&rsquo;s own page.
        </p>
      )}

      {canConfirm && showFullList && (
        <div id={listId} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${listId}-select`}>What was it for?</Label>
            <Select
              id={`${listId}-select`}
              className="w-56"
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
            >
              <option value="">Choose a category…</option>
              {suggestion.everyCategory.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" disabled={chosen === ""} onClick={() => setPending(chosen)}>
            Use this
          </Button>
        </div>
      )}

      <DecisionDialog
        open={pending !== null}
        onClose={() => {
          setPending(null);
          decide.reset();
        }}
        title="Say what this payment was for"
        consequence={
          <>
            This records <strong>{pending}</strong> as what{" "}
            <span className="font-mono text-meta">{description}</span> was for, and counts it under
            that from now on.{" "}
            {suggestion.countsAsPurchase
              ? "It says nothing about who shared it, and creates no debt to anybody."
              : "This line is interest, a fee or a repayment rather than a purchase — it is filed, not counted as new spending."}{" "}
            A later payment worded the same way will be suggested this category, for you to agree
            with again.
          </>
        }
        confirmLabel="That's what it was"
        reasonLabel="Note for the record"
        pending={decide.isPending}
        error={decide.error}
        onConfirm={(reason) => {
          const inferenceId = suggestion.inferenceId;
          if (pending === null || inferenceId === null) return;
          // Agreeing and correcting are the same recorded decision on the same proposal: one
          // takes it as it stands, the other carries the category the person chose instead.
          const unchanged = pending === suggestion.category;
          decide.mutate(
            {
              inferenceId,
              ...(unchanged
                ? { decision: "accept" as const }
                : {
                    decision: "modify" as const,
                    modifiedOutput: {
                      proposedKind: "expense" as const,
                      relationshipType: "personal",
                      category: pending,
                      paidByPersonHint: null,
                    },
                  }),
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: () => setPending(null) },
          );
        }}
      />
    </div>
  );
}

/**
 * How sure this is, said the way a person would say it.
 *
 * Never a percentage and never the word "confidence": the point of the phrase is that somebody
 * reads it and calibrates, and a number invites them to trust the arithmetic behind it instead.
 */
function sureness(confidence: AttentionSuggestion["confidence"]): string {
  switch (confidence) {
    case "high":
      return "This looks like";
    case "medium":
      return "This is probably";
    case "low":
      return "This might be";
    default:
      return "One possibility is";
  }
}
