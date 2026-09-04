"use client";

import { useState } from "react";
import { ExpenseStateTag, sentenceCaseState } from "@/components/expense-state-tag";
import { Money } from "@/components/money";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/status";
import { useExpenses, usePeople } from "@/lib/queries";
import { EXPENSE_STATES, type ExpenseState } from "@/lib/types";

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
      <div>
        <h1 className="text-[20px] font-medium text-ink">Expenses</h1>
        <p className="mt-1 max-w-prose text-[14px] text-ink-muted">
          Every expense in the ledger, newest first. Net amount is gross minus any refund or
          reimbursement recorded against it.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label htmlFor="state-filter" className="flex flex-col gap-1 text-[13px] text-ink-muted">
          State
          <select
            id="state-filter"
            value={state}
            onChange={(event) => setState(event.target.value as ExpenseState | "")}
            className="min-w-[160px] rounded-sm border border-rule bg-panel px-2 py-1.5 text-[14px] text-ink"
          >
            <option value="">All states</option>
            {EXPENSE_STATES.map((option) => (
              <option key={option} value={option}>
                {sentenceCaseState(option)}
              </option>
            ))}
          </select>
        </label>

        {peopleQuery.isSuccess && (
          <label
            htmlFor="paid-by-filter"
            className="flex flex-col gap-1 text-[13px] text-ink-muted"
          >
            Paid by
            <select
              id="paid-by-filter"
              value={paidBy ?? ""}
              onChange={(event) => setPaidBy(event.target.value === "" ? null : event.target.value)}
              className="min-w-[160px] rounded-sm border border-rule bg-panel px-2 py-1.5 text-[14px] text-ink"
            >
              <option value="">Anyone</option>
              {peopleQuery.data.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                  {person.isUser ? " (you)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {peopleQuery.isError && (
          <p className="text-[13px] text-debit">
            Couldn&apos;t load people.{" "}
            <button
              type="button"
              onClick={() => void peopleQuery.refetch()}
              className="underline underline-offset-2"
            >
              Try again
            </button>
          </p>
        )}
      </div>

      {expensesQuery.isPending && <LoadingBlock label="Loading expenses…" />}
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
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[14px]">
            <caption className="sr-only">Expense ledger</caption>
            <thead>
              <tr className="border-b border-rule text-left text-[13px] text-ink-muted">
                <th scope="col" className="py-2 font-normal">
                  Description
                </th>
                <th scope="col" className="py-2 font-normal">
                  Paid by
                </th>
                <th scope="col" className="py-2 font-normal">
                  State
                </th>
                <th scope="col" className="py-2 text-right font-normal">
                  Net
                </th>
              </tr>
            </thead>
            <tbody>
              {expensesQuery.data.map((expense) => {
                const hasAdjustment = expense.netAmount !== expense.grossAmount;
                return (
                  <tr key={expense.id} className="border-b border-rule last:border-b-0 align-top">
                    <td className="py-2.5">
                      <div className="text-ink">{expense.description ?? "—"}</div>
                      <div className="mt-0.5 text-[13px] text-ink-muted">
                        {new Intl.DateTimeFormat("en-IN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                          timeZone: "UTC",
                        }).format(new Date(expense.occurredAt))}
                      </div>
                    </td>
                    <td className="py-2.5">{nameFor(expense.paidByPersonId)}</td>
                    <td className="py-2.5">
                      <ExpenseStateTag state={expense.state} />
                    </td>
                    <td className="py-2.5 text-right">
                      <Money paise={expense.netAmount} />
                      {hasAdjustment && (
                        <div className="mt-0.5 text-[12px] text-ink-faint">
                          of <Money paise={expense.grossAmount} />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
