"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Money } from "@/components/money";
import { PageHeader, Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { EmptyBlock, ErrorBlock, FigureSkeleton, LoadingStatus } from "@/components/status";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AllocationDecisionInput } from "@/lib/api";
import { formatDate } from "@/lib/dates";
import { parseRupeeInput } from "@/lib/money";
import { useAllocationPreview, useApproveAllocation, useExpense, usePeople } from "@/lib/queries";
import type { AllocationPreviewResult } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Saying who shared an expense, in the words a person uses for it.
 *
 * The editor on `/expenses/[id]` is still there and still does everything — it opens by asking
 * which of `equal`, `exact`, `percentage`, `custom`, `item_based` or `quantity_based` applies,
 * which is the right control for somebody who already knows what those mean and an impossible
 * first question for anybody else.
 *
 * Here the first question is *who*, splitting it evenly is the default, and dividing it another
 * way is a disclosure. Two rules hold throughout:
 *
 *  - **Every amount on this screen was computed by the ledger.** The preview comes from
 *    `POST /api/expenses/:id/allocation/preview`, which runs the same `buildLines` the approval
 *    runs. Nothing here divides anything (`web/CLAUDE.md` rule 1), so the preview cannot
 *    disagree with what saving does.
 *  - **Saving is a `DecisionDialog`**, and it states the consequence in the direction the
 *    ledger actually says — who owes whom, given who fronted the money (ADR-0006).
 */
export function ShareExpense({ expenseId }: { expenseId: string }) {
  const expense = useExpense(expenseId);
  const people = usePeople();
  const approve = useApproveAllocation(expenseId);

  const [picked, setPicked] = useState<readonly string[] | null>(null);
  const [mode, setMode] = useState<"evenly" | "exact">("evenly");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);

  // Until somebody touches the list, it is the person who paid: they benefited from their own
  // purchase unless told otherwise, so the common case — "just me" — is already correct.
  // Derived rather than seeded by an effect, so there is no moment where it is briefly empty.
  const chosen = useMemo(
    () => picked ?? (expense.data === undefined ? [] : [expense.data.paidByPersonId]),
    [picked, expense.data],
  );

  const decision = useMemo<AllocationDecisionInput | null>(() => {
    if (chosen.length === 0) return null;
    if (mode === "evenly") {
      return {
        method: "equal",
        beneficiaries: chosen.map((id) => ({ type: "person" as const, id })),
      };
    }
    // Rupees typed by a person into exact paise, through the same `parseRupeeInput` every
    // other amount field in this package uses — rule 1's one documented exception, and pure
    // string handling rather than a multiplication. A second copy of that conversion here
    // would be a second place for a rounding rule to drift.
    const lines: { beneficiary: { type: "person"; id: string }; amount: string }[] = [];
    for (const id of chosen) {
      const parsed = parseRupeeInput(amounts[id] ?? "");
      if (!parsed.ok) return null;
      lines.push({ beneficiary: { type: "person", id }, amount: parsed.paise });
    }
    return { method: "exact", lines };
  }, [chosen, mode, amounts]);

  // A read, keyed by the decision: an unchanged selection is answered from cache and a changed
  // one refetches, with no effect setting state by hand.
  const previewQuery = useAllocationPreview(expenseId, decision);
  const preview = previewQuery.data ?? null;
  const previewError = previewQuery.error;

  if (expense.isPending || people.isPending) {
    return (
      <LoadingStatus label="Loading this expense">
        <FigureSkeleton />
      </LoadingStatus>
    );
  }
  if (expense.isError) {
    return <ErrorBlock error={expense.error} onRetry={() => void expense.refetch()} />;
  }
  if (people.isError) {
    return <ErrorBlock error={people.error} onRetry={() => void people.refetch()} />;
  }

  const roster = people.data;
  const payerName =
    roster.find((person) => person.id === expense.data.paidByPersonId)?.displayName ??
    "Somebody not on the roster";

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Who shared this?"
        description={`${expense.data.description ?? "This expense"} · ${formatDate(expense.data.occurredAt)} · paid by ${payerName}`}
      />

      <div className="flex flex-col gap-1">
        <span className="text-meta text-ink-muted">To divide</span>
        <Money paise={expense.data.netAmount} size="display" />
        {expense.data.netAmount !== expense.data.grossAmount && (
          <span className="text-micro text-ink-faint">
            after money that came back. It originally cost{" "}
            <Money paise={expense.data.grossAmount} className="text-micro" />.
          </span>
        )}
      </div>

      <Section
        title="Who benefited"
        headingId="share-people"
        description="Everybody who got something out of it, including you if you did."
      >
        <ul className="flex flex-wrap gap-2">
          {roster.map((person) => {
            const picked = chosen.includes(person.id);
            return (
              <li key={person.id}>
                <button
                  type="button"
                  aria-pressed={picked}
                  onClick={() =>
                    setPicked(
                      chosen.includes(person.id)
                        ? chosen.filter((id) => id !== person.id)
                        : [...chosen, person.id],
                    )
                  }
                  className={cn(
                    "rounded-sm border px-3 py-1.5 text-body transition-colors",
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
        {chosen.length === 0 && (
          <p className="mt-3 text-meta text-attention">
            Pick at least one person. An expense nobody benefited from cannot be divided.
          </p>
        )}
      </Section>

      {mode === "evenly" ? (
        <button
          type="button"
          onClick={() => setMode("exact")}
          className="self-start text-meta text-accent underline underline-offset-2"
        >
          Divide it a different way
        </button>
      ) : (
        <Section
          title="Exact amounts"
          headingId="share-exact"
          description="What each person's share is, in rupees. They have to add up to the amount above."
        >
          <div className="flex flex-col gap-3">
            {chosen.map((id) => {
              const person = roster.find((entry) => entry.id === id);
              return (
                <div key={id} className="flex flex-wrap items-center gap-3">
                  <Label htmlFor={`share-${id}`} className="w-40 shrink-0">
                    {person?.isUser === true ? "You" : (person?.displayName ?? "Somebody")}
                  </Label>
                  <Input
                    id={`share-${id}`}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amounts[id] ?? ""}
                    onChange={(event) =>
                      setAmounts((current) => ({ ...current, [id]: event.target.value }))
                    }
                  />
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => setMode("evenly")}
              className="self-start text-meta text-accent underline underline-offset-2"
            >
              Go back to splitting it evenly
            </button>
          </div>
        </Section>
      )}

      <Section
        title="What this comes to"
        headingId="share-preview"
        description="Worked out by the ledger, not by this screen. Nothing is saved until you confirm."
      >
        {previewError !== null && <ErrorBlock error={previewError} />}
        {preview === null && previewError === null && (
          <EmptyBlock>
            {decision === null
              ? "Pick who benefited, and fill in every amount, to see what it comes to."
              : "Working it out…"}
          </EmptyBlock>
        )}
        {preview !== null && <Preview preview={preview} />}
      </Section>

      <div className="flex flex-wrap gap-3 border-t border-rule pt-4">
        <Button
          onClick={() => setConfirming(true)}
          disabled={preview === null || preview.refusal !== null}
        >
          Save who shared it
        </Button>
        <Link
          href={`/expenses/${expenseId}`}
          className={buttonVariants({ variant: "outline", size: "default" })}
        >
          More ways to divide it
        </Link>
      </div>

      <DecisionDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          approve.reset();
        }}
        title="Save who shared this"
        consequence={<Consequence preview={preview} />}
        confirmLabel="Save it"
        reasonLabel="Why this split"
        pending={approve.isPending}
        error={approve.error}
        onConfirm={(reason) => {
          if (decision === null) return;
          approve.mutate(
            { decision, ...(reason === undefined ? {} : { reason }) },
            { onSuccess: () => setConfirming(false) },
          );
        }}
      />
    </div>
  );
}

/** The shares and the obligations, exactly as the ledger computed them. */
function Preview({ preview }: { preview: AllocationPreviewResult }) {
  if (preview.refusal !== null) {
    return (
      <div className="rounded-sm border border-rule p-4">
        <p className="text-body text-attention">This cannot be saved as it stands.</p>
        <p className="mt-1 max-w-prose text-meta text-ink-muted">{preview.refusal.message}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {preview.replacesExistingAllocation && (
        // Said before the dialog, not only inside it: arriving here on an expense that is
        // already divided and seeing only the payer preselected should not be the first hint
        // that saving would replace what is there.
        <p className="max-w-prose text-meta text-attention">
          This expense is already divided between people. Saving replaces that split — the old one
          is kept in its history, never edited.
        </p>
      )}
      <ul className="flex flex-col divide-y divide-rule border-y border-rule">
        {preview.shares.map((share) => (
          <li
            key={`${share.beneficiaryType}:${share.beneficiaryId}`}
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

      {preview.obligations.length === 0 ? (
        // The API's own sentence: "nobody else is named" and "this is recorded as personal" are
        // different reasons for the same empty list, and only it knows which applies.
        <p className="max-w-prose text-meta text-ink-muted">{preview.noObligationsBecause}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {preview.obligations.map((obligation) => (
            <li
              key={`${obligation.personId}:${obligation.direction}`}
              className="flex flex-wrap items-baseline justify-between gap-3 text-meta"
            >
              <span className="text-ink">
                {obligation.direction === "collect"
                  ? `You should collect from ${obligation.name}`
                  : `You need to pay ${obligation.name}`}
              </span>
              <Money
                paise={obligation.amount}
                tone={obligation.direction === "collect" ? "credit" : "debit"}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What saving will do, in the direction the ledger says — never assumed to run towards you.
 *
 * The obligation half is the preview's own answer rather than a rule restated here. An expense
 * recorded `personal` or `gift` divides without anybody owing anything, so a dialog that
 * promised a debt over one would be stating a consequence that will not happen — on the single
 * screen whose whole job is to state the consequence correctly (ADR-0049).
 */
function Consequence({ preview }: { preview: AllocationPreviewResult | null }) {
  if (preview === null) return <>Nothing is worked out yet.</>;
  const nobodyOwes = preview.obligations.length === 0;
  return (
    <>
      {preview.replacesExistingAllocation ? (
        <>
          This <strong>replaces</strong> who currently shares this expense. The old version is kept
          — a split is never edited in place — and what each person owes moves to the new shares.
        </>
      ) : nobodyOwes ? (
        <>This records who benefited from it.</>
      ) : (
        <>This is what creates the debts.</>
      )}{" "}
      <Owes preview={preview} /> The amounts are the ledger&apos;s, exactly as shown.
    </>
  );
}

/** Who would owe whom, straight from the preview. */
function Owes({ preview }: { preview: AllocationPreviewResult }) {
  if (preview.obligations.length === 0) {
    return <>{preview.noObligationsBecause}</>;
  }
  if (preview.paidBy.isYou) {
    return <>Everybody named other than you will owe you their share.</>;
  }
  return (
    <>
      Everybody named other than {preview.paidBy.name} will owe their share to {preview.paidBy.name}
      , not automatically to you.
    </>
  );
}
