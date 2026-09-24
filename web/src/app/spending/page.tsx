"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/money";
import { WorthALook } from "@/components/anomalies/worth-a-look";
import { PageHeader, Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, FigureSkeleton, LoadingStatus } from "@/components/status";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  SPENDING_WINDOWS,
  formatDate,
  formatPeriod,
  fromDateInputValue,
  spendingWindowLabel,
  spendingWindowPeriod,
} from "@/lib/dates";
import type { SpendingWindow } from "@/lib/dates";
import { spendingWindowMonths } from "@/lib/dates";
import { useSpendingSummary } from "@/lib/queries";
import type { SpendingMonth, SpendingSummaryResult } from "@/lib/types";

/**
 * Where the money went, what came back, what was yours, and what the ledger cannot place.
 *
 * All of it from the one `/api/spending` read, so no two figures on the screen can disagree —
 * the total, the trend, the own share and the unaccounted amount are one pass over one
 * snapshot. Nothing here sums, nets or divides anything; the bar widths below are the only
 * arithmetic on this page and they are geometry, not money.
 *
 * This used to send anybody who wanted a trend to `/analytics`, which is the screen named after
 * the machinery. `/analytics` is unchanged, still linked at the foot, and still the place for
 * the full caveat list and arbitrary periods.
 */
export default function SpendingPage() {
  // The API picks the current month when it is not told which one, which is the right default
  // and the wrong only option: a ledger whose statements are last month's would otherwise show
  // ₹0 as its headline over a trend bar reporting real spending, with no way to look. Choosing
  // which months to ask about is a calendar decision; every figure inside is still the API's.
  const [window, setWindow] = useState<SpendingWindow>("this_month");
  const period = spendingWindowPeriod(window);
  const spending = useSpendingSummary(
    { from: fromDateInputValue(period.start), to: fromDateInputValue(period.end) },
    // The trend covers the window the totals cover, so the bars and the figure above them are
    // always talking about the same months.
    spendingWindowMonths[window],
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Spending"
        description="What your records add up to, and anything the system cannot yet place."
      />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="spending-window">Period</Label>
        <Select
          id="spending-window"
          value={window}
          onChange={(event) => setWindow(event.target.value as SpendingWindow)}
          className="max-w-[220px]"
        >
          {SPENDING_WINDOWS.map((option) => (
            <option key={option} value={option}>
              {spendingWindowLabel[option]}
            </option>
          ))}
        </Select>
      </div>

      {spending.isPending && (
        <LoadingStatus label="Adding it up">
          <FigureSkeleton />
        </LoadingStatus>
      )}
      {spending.isError && (
        <ErrorBlock error={spending.error} onRetry={() => void spending.refetch()} />
      )}

      {spending.isSuccess && <SpendingBody data={spending.data} />}
    </div>
  );
}

function SpendingBody({ data }: { data: SpendingSummaryResult }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Spent" period={formatPeriod(data.period.start, data.period.end)}>
          {data.total.known && data.total.amount !== null ? (
            <Money paise={data.total.amount} size="display" />
          ) : (
            <span className="text-display leading-none font-semibold text-attention">
              Needs review
            </span>
          )}
        </Tile>

        <Tile label="Your own share" period="after everybody else's shares">
          <Money paise={data.own.share} size="figure" />
        </Tile>

        <Tile label="Came back" period="refunds and money paid back to you">
          <Money paise={data.cameBack.total} tone="credit" size="figure" />
        </Tile>

        <Tile
          label="Not yet accounted for"
          period={
            data.unaccountedFor.total.known
              ? `across ${data.unaccountedFor.movementCount} payment${data.unaccountedFor.movementCount === 1 ? "" : "s"}`
              : (data.unaccountedFor.total.unknownReason ?? "not known")
          }
        >
          {data.unaccountedFor.total.known && data.unaccountedFor.total.amount !== null ? (
            <Money paise={data.unaccountedFor.total.amount} tone="debit" size="figure" />
          ) : (
            <span className="text-figure leading-none font-semibold text-attention">
              Needs review
            </span>
          )}
        </Tile>
      </div>

      <Section
        title="Month by month"
        headingId="spending-trend"
        description="Approved expenses per calendar month, oldest first."
      >
        {data.months.length === 0 ? (
          <EmptyBlock>Nothing is on record for these months yet.</EmptyBlock>
        ) : (
          <Trend months={data.months} />
        )}
      </Section>

      {data.unaccountedFor.movements.length > 0 && (
        <Section
          title="Payments with no story yet"
          headingId="spending-unaccounted"
          description="Money moved and nothing on record says what for. Open one to see its records and say what it was."
        >
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {data.unaccountedFor.movements.map((movement) => (
              <li
                key={movement.paymentId}
                className="flex items-baseline justify-between gap-3 py-2"
              >
                <Link
                  href={`/connections/${movement.paymentId}`}
                  className="min-w-0 flex-1 truncate text-body text-ink hover:underline"
                >
                  {movement.description}
                </Link>
                <span className="flex shrink-0 items-baseline gap-3">
                  <span className="text-micro text-ink-faint">
                    {formatDate(movement.occurredAt)}
                  </span>
                  <Money paise={movement.amount} />
                </span>
              </li>
            ))}
          </ul>
          {data.unaccountedFor.movementCount > data.unaccountedFor.movements.length && (
            <p className="mt-3 text-meta text-ink-muted">
              These are the most recent. {data.unaccountedFor.movementCount} payments in all are
              waiting on something that says what they were for.
            </p>
          )}
        </Section>
      )}

      <Section
        title="By category"
        headingId="spending-categories"
        description="Only expenses somebody has approved. Transfers between your own accounts and investments are never counted as spending."
      >
        {data.categories.length === 0 ? (
          <EmptyBlock>
            <div className="flex flex-col items-start gap-3">
              <p className="text-body text-ink">Nothing is categorised for this period yet.</p>
              <p className="max-w-prose text-meta text-ink-muted">
                Payments become spending once something says what they were for. Adding the matching
                bills and receipts is what fills this in.
              </p>
              <Link href="/add" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Add bills and receipts
              </Link>
            </div>
          </EmptyBlock>
        ) : (
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {data.categories.map((entry) => (
              <li
                key={entry.category ?? "uncategorised"}
                className="flex items-baseline justify-between gap-3 py-2"
              >
                <span className="min-w-0 truncate text-body text-ink">
                  {entry.category ?? "Not categorised"}
                </span>
                <span className="flex shrink-0 items-baseline gap-3">
                  <span className="text-micro text-ink-faint">
                    {entry.expenseCount} expense{entry.expenseCount === 1 ? "" : "s"}
                  </span>
                  <Money paise={entry.netTotal} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/*
        After the figures, not before them. Spending answers "where did it go"; this answers
        "is anything odd", which is a quieter question and belongs below the one people came for.
      */}
      <WorthALook />

      {data.caveats.excludes.length > 0 && (
        <p className="max-w-prose text-meta text-ink-muted">
          These totals leave out {data.caveats.excludes.join(", ")}.{" "}
          <Link href="/analytics" className="underline underline-offset-2">
            Analytics
          </Link>{" "}
          has the full picture and lets you pick any period.
        </p>
      )}
    </>
  );
}

function Tile({
  label,
  period,
  children,
}: {
  label: string;
  period: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-sm border border-rule p-4">
      <span className="text-meta text-ink-muted">{label}</span>
      {children}
      <span className="text-micro text-ink-faint">{period}</span>
    </div>
  );
}

/**
 * The trend, as bars whose widths are a proportion of the largest month.
 *
 * Comparing two strings of paise to find the tallest bar is layout, not accounting: no figure
 * on the screen comes out of it, every amount printed is the API's own, and a bar rendered at
 * the wrong width would misdraw a picture rather than misstate money.
 */
function Trend({ months }: { months: readonly SpendingMonth[] }) {
  const widest = months.reduce((largest, month) => {
    const value = BigInt(month.netTotal);
    return value > largest ? value : largest;
  }, 0n);

  return (
    <ul className="flex flex-col gap-2">
      {months.map((month) => {
        const value = BigInt(month.netTotal);
        const percent = widest === 0n ? 0 : Number((value * 100n) / widest);
        return (
          <li key={month.month} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-micro text-ink-faint">
              {monthLabel(month.month)}
            </span>
            <span className="h-2 min-w-0 flex-1 rounded-sm bg-rule" aria-hidden="true">
              <span
                className="block h-2 rounded-sm bg-accent"
                style={{ width: `${Math.max(percent, value > 0n ? 2 : 0)}%` }}
              />
            </span>
            <span className="shrink-0">
              <Money paise={month.netTotal} className="text-meta" />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** `2026-08` → `Aug 2026`. Formatting a label, not deriving a period. */
function monthLabel(month: string): string {
  const [year, index] = month.split("-");
  if (year === undefined || index === undefined) return month;
  const date = new Date(Date.UTC(Number(year), Number(index) - 1, 1));
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}
