"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Money } from "@/components/money";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatDate, fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { sentenceCase } from "@/lib/labels";
import { parseRupeeInput } from "@/lib/money";
import { useCreateExpense, usePayments, usePeople } from "@/lib/queries";
import { EXPENSE_RELATIONSHIP_TYPES, type ExpenseRelationshipType } from "@/lib/types";

/**
 * Recording an expense by hand, in either funding shape.
 *
 * The shape is a real choice, not a formality (ADR-0006). **Funded by a movement here** links
 * the expense to a payment this ledger holds. **Somebody else paid** creates no payment at all
 * — a flatmate paying the electrician is not money the user moved, and fabricating a payment to
 * represent it would put spending on the user's own account that never happened. In that shape
 * the trail runs through evidence instead, so an evidence id is required.
 *
 * `paidByPersonId` names who fronted it, and the obligations that follow an allocation run to
 * **that** person, not automatically to the user.
 */
export function ExpenseForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState(toDateInputValue(new Date()));
  const [relationshipType, setRelationshipType] = useState<ExpenseRelationshipType>("shared");
  const [category, setCategory] = useState("");
  const [paidByPersonId, setPaidByPersonId] = useState("");
  const [funded, setFunded] = useState<"payment" | "external">("payment");
  const [paymentId, setPaymentId] = useState("");
  const [evidenceId, setEvidenceId] = useState("");

  const people = usePeople();
  const candidates = usePayments({ onlyUnexplained: true, limit: 50 });
  const create = useCreateExpense();

  const parsed = parseRupeeInput(amount);
  const ready =
    description.trim() !== "" &&
    parsed.ok &&
    paidByPersonId !== "" &&
    (funded === "payment" ? paymentId !== "" : evidenceId.trim() !== "");

  return (
    <>
      <Button onClick={() => setOpen(true)}>Record an expense</Button>

      <DecisionDialog
        open={open}
        onClose={() => {
          setOpen(false);
          create.reset();
        }}
        title="Record an expense"
        consequence={
          funded === "payment" ? (
            <>
              This records what was bought and attributes the movement you choose to it. It names no
              beneficiaries yet, so it creates no obligation until an allocation is approved.
            </>
          ) : (
            <>
              This records an expense <strong>somebody else paid for</strong>. No payment is created
              on your behalf — the evidence you name is the trail back to what happened, and your
              share becomes what you owe them once an allocation is approved.
            </>
          )
        }
        confirmLabel="Record it"
        confirmDisabled={!ready}
        reasonLabel="Note for the audit trail"
        pending={create.isPending}
        error={create.error}
        onConfirm={(reason) => {
          if (!parsed.ok) return;
          create.mutate(
            {
              description: description.trim(),
              amount: parsed.paise,
              occurredAt: fromDateInputValue(occurredOn),
              relationshipType,
              paidByPersonId,
              ...(category.trim() === "" ? {} : { category: category.trim() }),
              ...(funded === "payment"
                ? { funding: [{ paymentId, amount: parsed.paise }] }
                : { evidenceId: evidenceId.trim() }),
              ...(reason === undefined ? {} : { reason }),
            },
            {
              onSuccess: (result) => {
                setOpen(false);
                router.push(`/expenses/${result.expenseId}`);
              },
            },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-description">What it was</Label>
            <Input
              id="expense-description"
              value={description}
              placeholder="Dinner at Toit"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-amount">Amount</Label>
              <Input
                id="expense-amount"
                inputMode="decimal"
                placeholder="2,400.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-40 font-mono"
              />
              {amount.trim() !== "" && !parsed.ok && (
                <p className="text-meta text-attention">{parsed.message}</p>
              )}
              {parsed.ok && (
                <p className="text-micro text-ink-faint">
                  Reads as <Money paise={parsed.paise} />. Once approved, this figure never changes
                  — a later correction is an adjustment.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-date">Date</Label>
              <Input
                id="expense-date"
                type="date"
                value={occurredOn}
                onChange={(event) => setOccurredOn(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-relationship">Kind</Label>
              <Select
                id="expense-relationship"
                value={relationshipType}
                onChange={(event) =>
                  setRelationshipType(event.target.value as ExpenseRelationshipType)
                }
                className="w-52"
              >
                {EXPENSE_RELATIONSHIP_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {sentenceCase(option)}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-category">Category</Label>
              <Input
                id="expense-category"
                value={category}
                placeholder="dining"
                onChange={(event) => setCategory(event.target.value)}
                className="w-40"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-payer">Who paid</Label>
            <Select
              id="expense-payer"
              value={paidByPersonId}
              onChange={(event) => setPaidByPersonId(event.target.value)}
            >
              <option value="">Choose the payer…</option>
              {(people.data ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                  {person.isUser ? " (you)" : ""}
                </option>
              ))}
            </Select>
            <p className="text-micro text-ink-faint">
              Everyone else&apos;s share will be owed to this person, not automatically to you.
            </p>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-meta text-ink-muted">How it was funded</legend>
            <label className="flex items-center gap-2 text-body text-ink">
              <input
                type="radio"
                name="funding-shape"
                className="size-4 accent-[var(--color-accent)]"
                checked={funded === "payment"}
                onChange={() => setFunded("payment")}
              />
              A movement in this ledger paid for it
            </label>
            <label className="flex items-center gap-2 text-body text-ink">
              <input
                type="radio"
                name="funding-shape"
                className="size-4 accent-[var(--color-accent)]"
                checked={funded === "external"}
                onChange={() => setFunded("external")}
              />
              Somebody else paid — this ledger has no movement for it
            </label>
          </fieldset>

          {funded === "payment" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-payment">Movement</Label>
              <Select
                id="expense-payment"
                value={paymentId}
                onChange={(event) => setPaymentId(event.target.value)}
              >
                <option value="">Choose an unexplained movement…</option>
                {(candidates.data?.payments ?? []).map((payment) => (
                  <option key={payment.id} value={payment.id}>
                    {formatDate(payment.occurredAt)} · {payment.rawDescription}
                  </option>
                ))}
              </Select>
              <p className="text-micro text-ink-faint">
                The whole expense amount is attributed to it. Split it across several movements from
                the expense afterwards.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-evidence">Evidence id</Label>
              <Input
                id="expense-evidence"
                value={evidenceId}
                placeholder="The stored document or note that records it"
                onChange={(event) => setEvidenceId(event.target.value)}
                className="font-mono text-meta"
              />
              <p className="text-micro text-ink-faint">
                Required: with no payment behind it, evidence is the only trail back to what
                happened. Add one from the evidence library first if you have none.
              </p>
            </div>
          )}
        </div>
      </DecisionDialog>
    </>
  );
}
