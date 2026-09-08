"use client";

import Link from "next/link";
import { useState } from "react";
import { AnalyticsCaveatList } from "@/components/analytics/caveats";
import { SpendBars } from "@/components/analytics/spend-bars";
import { Money } from "@/components/money";
import { PageHeader, Section } from "@/components/page-header";
import { ResponsiveTable } from "@/components/responsive-table";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { currentMonthPeriod, formatDate, fromDateInputValue } from "@/lib/dates";
import {
  useCategorySpend,
  useMonthlySpend,
  useOutstanding,
  useOwnSpend,
  useUnsettled,
} from "@/lib/queries";

/**
 * What the user's own money went on, and who still owes whom.
 *
 * The hero is **their own share**, not what passed through the account, because those are
 * different questions and the second one is the misleading one: fronting ₹4,000 for a dinner
 * is not spending ₹4,000. The figure comes from the same obligation arithmetic the balances
 * screen uses, so an analytics number can never disagree with a balance.
 *
 * Every total on this page carries what it excludes, and every exclusion is a domain rule
 * rather than a display choice — transfers and investments are not spending, a rejected
 * expense is in no total, a settlement discharges rather than creates. A figure shown without
 * them would be asserting more precision than the ledger has.
 */
export default function AnalyticsPage() {
  const month = currentMonthPeriod();
  const [from, setFrom] = useState(month.start);
  const [to, setTo] = useState(month.end);

  const range = { from: fromDateInputValue(from), to: fromDateInputValue(to) };
  const own = useOwnSpend(range);
  const categories = useCategorySpend(range);
  const monthly = useMonthlySpend(range);
  const outstanding = useOutstanding();
  const unsettled = useUnsettled();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Analytics"
        description="What your own share of this period came to, what it went on, and what is still outstanding. Every figure here is the ledger's own."
      />

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="analytics-from">From</Label>
          <Input
            id="analytics-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="analytics-to">To</Label>
          <Input
            id="analytics-to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        <p className="pb-2 text-micro text-ink-faint">The end date is excluded.</p>
      </div>

      {own.isPending && (
        <LoadingStatus label="Computing your own share…">
          <TableSkeleton columns={2} rows={2} />
        </LoadingStatus>
      )}
      {own.isError && <ErrorBlock error={own.error} onRetry={() => void own.refetch()} />}
      {own.isSuccess && (
        <>
          <div className="border-t-2 border-double border-rule-strong pt-4">
            <p className="text-meta text-ink-muted">Your own share</p>
            <Money paise={own.data.ownShare} size="display" className="mt-1 block" />
            <p className="mt-2 max-w-prose text-meta text-ink-muted">
              <Money paise={own.data.paidByUser} /> left your accounts for expenses in this period,
              of which <Money paise={own.data.frontedForOthers} /> was fronted for other people.
              What they have repaid is netted on the balances screen, not here.
            </p>
          </div>
          <AnalyticsCaveatList caveats={own.data.caveats} />
        </>
      )}

      <Section
        title="Where it went"
        headingId="analytics-categories"
        description="Net of anything that came back, by category, over the chosen period."
      >
        {categories.isPending && (
          <LoadingStatus label="Loading spending by category…">
            <TableSkeleton columns={2} />
          </LoadingStatus>
        )}
        {categories.isError && (
          <ErrorBlock error={categories.error} onRetry={() => void categories.refetch()} />
        )}
        {categories.isSuccess && categories.data.categories.length === 0 && (
          <EmptyBlock>No expenses in this period.</EmptyBlock>
        )}
        {categories.isSuccess && categories.data.categories.length > 0 && (
          <>
            <SpendBars
              rows={categories.data.categories.map((entry) => ({
                key: entry.category ?? "uncategorised",
                label: entry.category ?? "No category",
                paise: entry.netTotal,
                meta: `${entry.expenseCount} ${entry.expenseCount === 1 ? "expense" : "expenses"}${
                  entry.netTotal === entry.grossTotal ? "" : " · reduced by a refund"
                }`,
              }))}
            />
            <p className="mt-3 text-meta text-ink-muted">
              Total across every category: <Money paise={categories.data.netTotal} />.
            </p>
          </>
        )}
      </Section>

      <Section
        title="Month by month"
        headingId="analytics-monthly"
        description="Every month the chosen period touches, whether or not anything happened in it."
      >
        {monthly.isPending && (
          <LoadingStatus label="Loading the trend…">
            <TableSkeleton columns={2} />
          </LoadingStatus>
        )}
        {monthly.isError && (
          <ErrorBlock error={monthly.error} onRetry={() => void monthly.refetch()} />
        )}
        {monthly.isSuccess && monthly.data.months.length === 0 && (
          <EmptyBlock>No expenses in this period.</EmptyBlock>
        )}
        {monthly.isSuccess && monthly.data.months.length > 0 && (
          <SpendBars
            rows={monthly.data.months.map((entry) => ({
              key: entry.month,
              label: entry.month,
              paise: entry.netTotal,
              meta: `${entry.expenseCount} ${entry.expenseCount === 1 ? "expense" : "expenses"}`,
            }))}
          />
        )}
      </Section>

      <Section
        title="Every open balance"
        headingId="analytics-outstanding"
        description="Who owes whom right now, in either direction, across everyone at once. Not filtered by the period above — a debt does not expire with a month."
      >
        {outstanding.isPending && (
          <LoadingStatus label="Loading open balances…">
            <TableSkeleton columns={3} />
          </LoadingStatus>
        )}
        {outstanding.isError && (
          <ErrorBlock error={outstanding.error} onRetry={() => void outstanding.refetch()} />
        )}
        {outstanding.isSuccess && outstanding.data.counterparties.length === 0 && (
          <EmptyBlock>Nothing is outstanding with anybody.</EmptyBlock>
        )}
        {outstanding.isSuccess && outstanding.data.counterparties.length > 0 && (
          <>
            <ResponsiveTable
              caption="Open balances with every counterparty"
              minWidth="480px"
              rows={outstanding.data.counterparties}
              rowKey={(entry) => entry.personId}
              columns={[
                {
                  key: "person",
                  header: "Person",
                  render: (entry) => (
                    <Link
                      href={`/balances?with=${entry.personId}`}
                      className="text-accent underline-offset-2 hover:underline"
                    >
                      {entry.displayName}
                    </Link>
                  ),
                },
                {
                  key: "direction",
                  header: "Direction",
                  render: (entry) => (
                    <span className="text-meta text-ink-muted">
                      {BigInt(entry.netBalance) > 0n
                        ? "They owe you"
                        : BigInt(entry.netBalance) < 0n
                          ? "You owe them"
                          : "Settled"}
                    </span>
                  ),
                },
                {
                  key: "expenses",
                  header: "From",
                  secondary: true,
                  render: (entry) => (
                    <span className="text-meta text-ink-muted">
                      {entry.contributingExpenseCount}{" "}
                      {entry.contributingExpenseCount === 1 ? "expense" : "expenses"}
                    </span>
                  ),
                },
                {
                  key: "amount",
                  header: "Balance",
                  align: "right",
                  render: (entry) => <Money paise={entry.netBalance} />,
                },
              ]}
            />
            <p className="mt-3 text-meta text-ink-muted">
              <Money paise={outstanding.data.totalOwedToUser} /> is owed to you and{" "}
              <Money paise={outstanding.data.totalOwedByUser} /> by you. These are two separate
              totals, not a net — money owed to you by one person does not cancel what you owe
              another.
            </p>
          </>
        )}
      </Section>

      <Section
        title="Paid for other people, not yet repaid"
        headingId="analytics-unsettled"
        description="Expenses you fronted where somebody's share is still outstanding."
      >
        {unsettled.isPending && (
          <LoadingStatus label="Loading unreimbursed expenses…">
            <TableSkeleton columns={3} />
          </LoadingStatus>
        )}
        {unsettled.isError && (
          <ErrorBlock error={unsettled.error} onRetry={() => void unsettled.refetch()} />
        )}
        {unsettled.isSuccess && unsettled.data.expenses.length === 0 && (
          <EmptyBlock>
            Nothing you paid for on someone else&apos;s behalf is outstanding.
          </EmptyBlock>
        )}
        {unsettled.isSuccess && unsettled.data.expenses.length > 0 && (
          <ResponsiveTable
            caption="Expenses paid on behalf of others and still owed"
            minWidth="520px"
            rows={unsettled.data.expenses}
            rowKey={(entry) => entry.expenseId}
            columns={[
              {
                key: "expense",
                header: "Expense",
                render: (entry) => (
                  <>
                    <Link
                      href={`/expenses/${entry.expenseId}`}
                      className="text-accent underline-offset-2 hover:underline"
                    >
                      {entry.description ?? "Untitled expense"}
                    </Link>
                    <span className="block text-meta text-ink-muted">
                      {formatDate(entry.occurredAt)}
                    </span>
                  </>
                ),
              },
              {
                key: "who",
                header: "For",
                render: (entry) => (
                  <span className="text-meta text-ink-muted">
                    {entry.beneficiaries.map((person) => person.displayName).join(", ")}
                  </span>
                ),
              },
              {
                key: "net",
                header: "Net cost",
                align: "right",
                secondary: true,
                render: (entry) => <Money paise={entry.netAmount} />,
              },
              {
                key: "owed",
                header: "Still owed you",
                align: "right",
                render: (entry) => <Money paise={entry.owedToUser} />,
              },
            ]}
          />
        )}
      </Section>
    </div>
  );
}
