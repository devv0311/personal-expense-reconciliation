"use client";

import Link from "next/link";
import { useState } from "react";
import { ExpenseStateTag, sentenceCaseState } from "@/components/expense-state-tag";
import { ExpenseForm } from "@/components/expenses/expense-form";
import { OccasionList } from "@/components/expenses/occasions";
import { Money } from "@/components/money";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { useExpenses, usePeople } from "@/lib/queries";
import { EXPENSE_STATES, type ExpenseState } from "@/lib/types";

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export default function ExpensesPage() {
  const [state, setState] = useState<ExpenseState | "">("");
  const [paidBy, setPaidBy] = useState<string | null>(null);
  const peopleQuery = usePeople();
  const expensesQuery = useExpenses({
    ...(state === "" ? {} : { state }),
    ...(paidBy === null ? {} : { paidBy }),
  });

  // Falls back to a short, clearly-a-placeholder form rather than a raw UUID when the people
  // list hasn't loaded (or failed) — a person's own database id is not something to show them.
  const nameFor = (id: string): string => {
    const match = peopleQuery.data?.find((person) => person.id === id);
    if (match !== undefined) return match.displayName;
    return peopleQuery.isError ? "Unknown (couldn't load people)" : "…";
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Expenses"
        description="Every expense in the ledger, newest first. Net amount is gross minus any refund or reimbursement recorded against it — open one to see its items, who benefited, and what came back."
        actions={<ExpenseForm />}
      />

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="state-filter">State</Label>
          <Select
            id="state-filter"
            value={state}
            onChange={(event) => setState(event.target.value as ExpenseState | "")}
            className="min-w-[160px]"
          >
            <option value="">All states</option>
            {EXPENSE_STATES.map((option) => (
              <option key={option} value={option}>
                {sentenceCaseState(option)}
              </option>
            ))}
          </Select>
        </div>

        {peopleQuery.isSuccess && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="paid-by-filter">Paid by</Label>
            <Select
              id="paid-by-filter"
              value={paidBy ?? ""}
              onChange={(event) => setPaidBy(event.target.value === "" ? null : event.target.value)}
              className="min-w-[160px]"
            >
              <option value="">Anyone</option>
              {peopleQuery.data.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                  {person.isUser ? " (you)" : ""}
                </option>
              ))}
            </Select>
          </div>
        )}
        {peopleQuery.isError && (
          <p className="text-meta text-debit">
            Couldn&apos;t load people.{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-debit"
              onClick={() => void peopleQuery.refetch()}
            >
              Try again
            </Button>
          </p>
        )}
      </div>

      {expensesQuery.isPending && (
        <LoadingStatus label="Loading expenses…">
          <TableSkeleton columns={4} />
        </LoadingStatus>
      )}
      {expensesQuery.isError && (
        <ErrorBlock
          error={expensesQuery.error}
          onRetry={() => {
            void expensesQuery.refetch();
            // Both queries typically fail together (the whole API was unreachable) — retrying
            // only the visible error would leave "Paid by" quietly broken after this recovers.
            if (peopleQuery.isError) void peopleQuery.refetch();
          }}
        />
      )}
      {expensesQuery.isSuccess && expensesQuery.data.length === 0 && (
        <EmptyBlock>No expenses match these filters.</EmptyBlock>
      )}
      {expensesQuery.isSuccess && expensesQuery.data.length > 0 && (
        <>
          <Table className="hidden min-w-[560px] sm:table">
            <TableCaption>Expense ledger</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Description</TableHead>
                <TableHead scope="col">Paid by</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col" className="text-right">
                  Net
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expensesQuery.data.map((expense) => {
                const hasAdjustment = expense.netAmount !== expense.grossAmount;
                return (
                  <TableRow key={expense.id} className="align-top">
                    <TableCell>
                      <Link
                        href={`/expenses/${expense.id}`}
                        className="text-accent underline-offset-2 hover:underline"
                      >
                        {expense.description ?? "Untitled expense"}
                      </Link>
                      <div className="mt-0.5 text-meta text-ink-muted">
                        {DATE_FORMAT.format(new Date(expense.occurredAt))}
                      </div>
                    </TableCell>
                    <TableCell>{nameFor(expense.paidByPersonId)}</TableCell>
                    <TableCell>
                      <ExpenseStateTag state={expense.state} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money paise={expense.netAmount} />
                      {hasAdjustment && (
                        <div className="mt-0.5 text-micro text-ink-faint">
                          of <Money paise={expense.grossAmount} />
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <ul className="flex flex-col gap-3 sm:hidden">
            {expensesQuery.data.map((expense) => {
              const hasAdjustment = expense.netAmount !== expense.grossAmount;
              return (
                <li key={expense.id} className="border-b border-rule pb-3 last:border-b-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <Link
                      href={`/expenses/${expense.id}`}
                      className="text-accent underline-offset-2 hover:underline"
                    >
                      {expense.description ?? "Untitled expense"}
                    </Link>
                    <span className="text-right">
                      <Money paise={expense.netAmount} />
                      {hasAdjustment && (
                        <span className="ml-1 text-micro text-ink-faint">
                          of <Money paise={expense.grossAmount} />
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-meta text-ink-muted">
                    <span>
                      {DATE_FORMAT.format(new Date(expense.occurredAt))} ·{" "}
                      {nameFor(expense.paidByPersonId)}
                    </span>
                    <ExpenseStateTag state={expense.state} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <OccasionList />
    </div>
  );
}
