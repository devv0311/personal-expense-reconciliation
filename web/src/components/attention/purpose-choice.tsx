"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Owes, Preview } from "@/components/people/share-expense";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { EmptyBlock, ErrorBlock } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { isUnansweredRequest, type AllocationDecisionInput } from "@/lib/api";
import {
  DecidedDifferently,
  UncertainResult,
  useAllocationPreview,
  useApproveStatementLine,
  usePeople,
} from "@/lib/queries";
import type { AttentionSuggestion } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * What kind of expense a statement line was, chosen **before** it is approved.
 *
 * The kind decides whether anybody can owe for it, and it is part of what approval fixes — once
 * approved, nothing in this version changes it. So it is asked here, with the consequence beside
 * it, rather than defaulted to "just me" and discovered later: a restaurant bill approved as
 * personal could never be turned into a debt. These are the expense vocabulary's own kinds, in
 * the words a person uses; `personal` stays the default, so the one-tap answer is unchanged.
 */
const KINDS = [
  { id: "personal", label: "Just me", sharedWithOthers: false },
  { id: "shared", label: "Me and other people — split it", sharedWithOthers: true },
  { id: "household_shared_flat", label: "The flat — split with flatmates", sharedWithOthers: true },
  { id: "paid_on_behalf", label: "I paid for somebody else", sharedWithOthers: true },
] as const;
type KindId = (typeof KINDS)[number]["id"];

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
  const [kind, setKind] = useState<KindId>("personal");
  const [pickedPeople, setPickedPeople] = useState<readonly string[] | null>(null);
  // Set once the approval has committed but the split has not: from then on this question is no
  // longer "approve it" but "save the split", whether or not the dialog is closed in between.
  const [approvedAs, setApprovedAs] = useState<KindId | null>(null);
  // Set when an attempt ended without an answer from the ledger: from then on the ledger is read
  // before anything is sent again, even after the dialog is closed and reopened.
  const [unanswered, setUnanswered] = useState(false);
  const decide = useApproveStatementLine();
  const people = usePeople();
  const finishing = approvedAs !== null;
  const effectiveKind = approvedAs ?? kind;
  const sharing =
    suggestion.countsAsPurchase &&
    KINDS.find((entry) => entry.id === effectiveKind)?.sharedWithOthers === true;
  const expenseId = suggestion.expenseId ?? null;
  // Until somebody touches the chips, the person who paid: it was their statement.
  const you = people.data?.find((person) => person.isUser)?.id ?? null;
  const beneficiaries = pickedPeople ?? (you === null ? [] : [you]);
  const split: AllocationDecisionInput | null =
    sharing && pending !== null && expenseId !== null && beneficiaries.length > 0
      ? {
          method: "equal",
          beneficiaries: beneficiaries.map((id) => ({ type: "person" as const, id })),
        }
      : null;
  // The ledger divides it, as if approved as this kind. Nothing here does any arithmetic.
  // Once approved there is nothing hypothetical left to ask: the expense *is* this kind, and the
  // ledger answers about the expense as it stands.
  const preview = useAllocationPreview(
    expenseId ?? "",
    split,
    finishing ? undefined : { relationshipType: kind },
  );
  const previewData = preview.data ?? null;
  const nobodyElse = previewData !== null && previewData.obligations.length === 0;
  const sharingBlocked =
    sharing &&
    (split === null || previewData === null || previewData.refusal !== null || nobodyElse);
  const closeDialog = () => {
    // A failure to save the split after the approval kept the question on screen; closing is
    // when the queue finally learns the expense is approved.
    if (decide.data?.sharingError != null || decide.error instanceof DecidedDifferently) {
      decide.invalidate(expenseId);
    }
    setPending(null);
    if (!finishing) setKind("personal");
    setPickedPeople(null);
    decide.reset();
  };
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
        onClose={closeDialog}
        title="Say what this payment was for"
        consequence={
          <>
            {finishing ? (
              <>
                <span className="font-mono text-meta">{description}</span> is{" "}
                <strong>already approved</strong> as {effectiveKind.replace(/_/g, " ")} — its amount
                and its kind are fixed and are not sent again. Only the split is left to save, and
                that is what creates the debts.{" "}
                {previewData !== null && previewData.refusal === null && (
                  <Owes preview={previewData} />
                )}
              </>
            ) : (
              <>
                This records <strong>{pending}</strong> as what{" "}
                <span className="font-mono text-meta">{description}</span> was for, and counts it
                under that from now on.{" "}
              </>
            )}{" "}
            {finishing ? null : !suggestion.countsAsPurchase ? (
              "This line is interest, a fee or a repayment rather than a purchase — it is filed, not counted as new spending."
            ) : sharing ? (
              <>
                It also approves it as an expense you split, and saves the split — that is what
                creates the debts.{" "}
                {previewData !== null && previewData.refusal === null && (
                  <Owes preview={previewData} />
                )}{" "}
                The amount is the statement&rsquo;s and never changes.
              </>
            ) : (
              "It says nothing about who shared it, and creates no debt to anybody. Whether anyone owes for it is chosen here, before it is approved — not afterwards."
            )}{" "}
            {finishing
              ? null
              : "A later payment worded the same way will be suggested this category, for you to agree with again."}
          </>
        }
        confirmLabel={
          finishing
            ? "Save the split"
            : sharing
              ? "Record it and save the split"
              : "That's what it was"
        }
        confirmDisabled={sharingBlocked}
        reasonLabel="Note for the record"
        pending={decide.isPending}
        error={decide.error}
        onConfirm={(reason) => {
          const inferenceId = suggestion.inferenceId;
          if (pending === null || inferenceId === null) return;
          // Agreeing and correcting are the same recorded decision on the same proposal: one
          // takes it as it stands, the other carries what the person chose instead — the
          // category, and now the kind.
          const unchanged = pending === suggestion.category && kind === "personal";
          const settle = {
            onError: (error: Error) => {
              if (error instanceof UncertainResult || isUnansweredRequest(error)) {
                setUnanswered(true);
              }
            },
            onSuccess: (result: { readonly sharingError: Error | null }) => {
              setUnanswered(
                result.sharingError !== null &&
                  (result.sharingError instanceof UncertainResult ||
                    isUnansweredRequest(result.sharingError)),
              );
              if (result.sharingError === null) {
                setPending(null);
                setKind("personal");
                setPickedPeople(null);
                setApprovedAs(null);
              } else {
                // Committed: from here on only the split can be saved.
                setApprovedAs(effectiveKind);
              }
            },
          };
          if (finishing) {
            decide.mutate(
              {
                inferenceId,
                expenseId,
                decision: "accept" as const,
                alreadyApproved: true,
                recheck: true,
                expectedCategory: pending,
                ...(split === null ? {} : { split }),
                ...(reason === undefined ? {} : { reason }),
              },
              settle,
            );
            return;
          }
          decide.mutate(
            {
              inferenceId,
              expenseId,
              ...(unanswered ? { recheck: true } : {}),
              expectedCategory: pending,
              ...(unchanged
                ? { decision: "accept" as const }
                : {
                    decision: "modify" as const,
                    modifiedOutput: {
                      proposedKind: "expense" as const,
                      relationshipType: kind,
                      category: pending,
                      paidByPersonHint: null,
                    },
                  }),
              ...(split === null ? {} : { split }),
              ...(reason === undefined ? {} : { reason }),
            },
            settle,
          );
        }}
      >
        <div className="flex flex-col gap-4">
          {suggestion.countsAsPurchase && !finishing && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${listId}-kind`}>Who was this for?</Label>
              <Select
                id={`${listId}-kind`}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as KindId);
                  setPickedPeople(null);
                }}
              >
                {KINDS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </Select>
              <p className="text-micro text-ink-faint">
                This is part of what approving fixes: it cannot be changed afterwards, so it is
                asked now.
              </p>
            </div>
          )}

          {sharing && (
            <>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-meta text-ink-muted">Who benefited</legend>
                <ul className="flex flex-wrap gap-2">
                  {(people.data ?? []).map((person) => {
                    const picked = beneficiaries.includes(person.id);
                    return (
                      <li key={person.id}>
                        <button
                          type="button"
                          aria-pressed={picked}
                          onClick={() =>
                            setPickedPeople(
                              picked
                                ? beneficiaries.filter((id) => id !== person.id)
                                : [...beneficiaries, person.id],
                            )
                          }
                          className={cn(
                            "min-h-11 rounded-sm border px-3 py-1.5 text-body transition-colors",
                            picked
                              ? "border-accent bg-accent-bg text-ink"
                              : "border-rule text-ink-muted hover:border-rule-strong hover:text-ink",
                          )}
                        >
                          {person.isUser ? "You" : person.displayName}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
              {expenseId === null ? (
                <EmptyBlock>
                  This payment has no expense behind it yet, so there is nothing to divide. Approve
                  it first, then say who shared it on its own page.
                </EmptyBlock>
              ) : preview.error !== null ? (
                <ErrorBlock error={preview.error} />
              ) : previewData === null ? (
                <EmptyBlock>Working out what it comes to…</EmptyBlock>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-meta text-ink-muted">
                    What this comes to — worked out by the ledger, not by this screen.
                  </p>
                  <Preview preview={previewData} />
                  {nobodyElse && previewData.refusal === null && (
                    <p className="text-meta text-attention">
                      Pick at least one other person. With nobody else named, nobody owes anything
                      and there is nothing to share.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {decide.data?.sharingError != null && (
            <div className="rounded-sm border border-rule p-3" role="alert">
              <p className="text-body text-attention">
                {decide.data.sharingError instanceof UncertainResult &&
                decide.data.sharingError.outcome === "unknown"
                  ? `It was approved as ${effectiveKind.replace(/_/g, " ")}. Whether the split saved is not known yet.`
                  : `It was approved as ${effectiveKind.replace(/_/g, " ")}, but the split did not save.`}
              </p>
              <p className="mt-1 max-w-prose text-meta text-ink-muted">
                {decide.data.sharingError.message}{" "}
                {decide.data.sharingError instanceof UncertainResult &&
                decide.data.sharingError.outcome === "unknown"
                  ? ""
                  : "Nobody owes anything yet. "}
                {expenseId !== null && (
                  <Link
                    href={`/expenses/${expenseId}/share`}
                    className="text-accent underline underline-offset-2"
                  >
                    Say who shared it on its own page
                  </Link>
                )}
              </p>
            </div>
          )}
        </div>
      </DecisionDialog>
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
