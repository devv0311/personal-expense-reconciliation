"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatDate } from "@/lib/dates";
import { parseRupeeInput } from "@/lib/money";
import { useExpenseFunding, useLinkPaymentToExpense, usePayments } from "@/lib/queries";
import type { ExpenseLedgerRow } from "@/lib/types";

/**
 * Which payments funded this expense, and for how much of each.
 *
 * Both many-to-many shapes the domain has always modelled are just repeated links: one payment
 * across several expenses, several payments onto one expense (`CLAUDE.md`, principle 1). The
 * ledger refuses a set of links that would explain more money than a payment actually moved.
 *
 * An expense with **no** links is not broken — it is the externally-funded shape: somebody else
 * paid, so this ledger has no payment for it and never invents one (ADR-0006).
 */
export function FundingLinks({ expense }: { expense: ExpenseLedgerRow }) {
  const [open, setOpen] = useState(false);
  const [paymentId, setPaymentId] = useState("");
  const [amount, setAmount] = useState("");

  const funding = useExpenseFunding(expense.id);
  // Movements that still have money nothing accounts for are the only ones worth offering.
  const candidates = usePayments({ onlyUnexplained: true, limit: 50 });
  const link = useLinkPaymentToExpense(expense.id);

  const parsed = parseRupeeInput(amount);

  return (
    <Section
      title="What paid for it"
      headingId="expense-funding"
      description="The movements this expense draws on. Nothing here is the expense's amount — a payment can fund several expenses, and an expense can be funded by several payments."
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setPaymentId("");
            setAmount("");
            link.reset();
            setOpen(true);
          }}
        >
          Link a payment
        </Button>
      }
    >
      {funding.isPending && (
        <LoadingStatus label="Loading funding links…">
          <TableSkeleton columns={2} rows={2} />
        </LoadingStatus>
      )}
      {funding.isError && (
        <ErrorBlock error={funding.error} onRetry={() => void funding.refetch()} />
      )}
      {funding.isSuccess && funding.data.length === 0 && (
        <EmptyBlock>
          No payment in this ledger funds it. If somebody else paid, that is correct and deliberate
          — the obligation runs to them, and no payment is invented on your behalf.
        </EmptyBlock>
      )}
      {funding.isSuccess && funding.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {funding.data.map((line) => (
            <li
              key={line.linkId}
              className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-2 last:border-b-0"
            >
              <Link
                href={`/payments/${line.paymentId}`}
                className="text-accent underline-offset-2 hover:underline"
              >
                View the movement
              </Link>
              <Money paise={line.amount} />
            </li>
          ))}
        </ul>
      )}

      <DecisionDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Attribute a payment to this expense"
        consequence={
          <>
            This says that part of a movement paid for this expense, which is what stops that money
            reading as unexplained. It does not change either amount, and the ledger refuses a link
            that would explain more than the payment moved.
          </>
        }
        confirmLabel="Link it"
        confirmDisabled={paymentId === "" || !parsed.ok}
        reasonLabel="Note for the audit trail"
        pending={link.isPending}
        error={link.error}
        onConfirm={(reason) => {
          if (!parsed.ok) return;
          link.mutate(
            { paymentId, amount: parsed.paise, ...(reason === undefined ? {} : { reason }) },
            { onSuccess: () => setOpen(false) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="funding-payment">Movement</Label>
            <Select
              id="funding-payment"
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
              Only movements with money nothing accounts for are offered.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="funding-amount">How much of it</Label>
            <Input
              id="funding-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="w-40 font-mono"
            />
            {amount.trim() !== "" && !parsed.ok && (
              <p className="text-meta text-attention">{parsed.message}</p>
            )}
          </div>
        </div>
      </DecisionDialog>
    </Section>
  );
}
