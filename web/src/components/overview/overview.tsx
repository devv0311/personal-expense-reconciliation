"use client";

import Link from "next/link";
import { useState } from "react";
import { PrepareRecords } from "@/components/analysis/prepare-records";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, FigureSkeleton, LoadingStatus } from "@/components/status";
import { buttonVariants } from "@/components/ui/button";
import { formatPeriod } from "@/lib/dates";
import { useOverview } from "@/lib/queries";
import type { OverviewFigure, OverviewResult } from "@/lib/types";

/**
 * What the ledger knows, in the order somebody actually wants it.
 *
 * Every figure here is one the API computed. Nothing on this screen adds, subtracts or totals
 * anything — the single `/api/overview` read exists so that four numbers which must agree with
 * each other are produced together, by one pass over one snapshot, rather than by four calls
 * taken milliseconds apart.
 *
 * The vocabulary is deliberately the product's, not the codebase's: **records, payments,
 * expenses, connections, shares, balances**. A person reading this screen never has to learn
 * what normalization, classification, a cash-flow state or a reconciliation run is. Those still
 * exist, still hold the audit trail, and are still reachable — from Records, and from the
 * Details link on anything this screen summarises.
 *
 * **The order changed in the 2026-09-19 pass, and the order is the design.** This page used to
 * open with four equally-weighted figures in a row, and put the one thing to do next underneath
 * them. Four numbers of equal size ask the reader to work out which one matters; that is the
 * job this page is supposed to do for them. So the decision comes first and is the largest
 * thing on the screen, and the figures sit below it, quieter, as the account of where things
 * stand rather than as a dashboard.
 *
 * There is still exactly one hero **figure** (`Design.md`, "Typography"): the period's spending
 * total. The decision above it is set in the serif heading face, not as a number, so the two do
 * not compete.
 */
export function Overview() {
  const overview = useOverview();
  // A run reads the waiting records, so the count that put the reading offer on screen drops to
  // zero the moment it succeeds. Remembering that a run happened is what keeps its result
  // readable instead of unmounting it at the exact moment it has something to say.
  const [analysed, setAnalysed] = useState(false);

  if (overview.isPending) {
    return (
      <LoadingStatus label="Working out where things stand">
        <div className="flex flex-col gap-8">
          <div className="rounded-sm border border-rule p-6">
            <FigureSkeleton />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1].map((slot) => (
              <div key={slot} className="rounded-sm border border-rule p-4">
                <FigureSkeleton />
              </div>
            ))}
          </div>
        </div>
      </LoadingStatus>
    );
  }

  if (overview.isError) {
    return <ErrorBlock error={overview.error} onRetry={() => void overview.refetch()} />;
  }

  const data = overview.data;
  if (data.empty) return <FirstRun />;

  return (
    <div className="flex flex-col gap-12">
      <NextDecision data={data} analysed={analysed} onAnalysed={() => setAnalysed(true)} />
      <Spending data={data} />
      {/*
        `min-w-0` on each track, not decoration: a grid item's default `min-width: auto` sizes
        the column to its longest unbreakable string, so one long merchant narration pushes the
        whole page wider than the phone it is on. The truncation inside the row cannot help
        until the track is allowed to be narrower than its content.
      */}
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-10">
        <div className="min-w-0">
          <People data={data} />
        </div>
        <div className="min-w-0">
          <Recent data={data} />
        </div>
      </div>
    </div>
  );
}

/** Nothing on record yet — so ask for the first record instead of showing four zeroes. */
function FirstRun() {
  return (
    <EmptyBlock>
      <div className="flex flex-col items-start gap-3">
        <p className="text-emphasis font-serif text-ink">Nothing has been added yet.</p>
        <p className="max-w-prose text-body text-ink-muted">
          Add a bank or card statement, a bill, a receipt, a payment screenshot, or type a payment
          in by hand. Everything else on this page is worked out from what you add.
        </p>
        <Link href="/add" className={buttonVariants()}>
          Add your first records
        </Link>
      </div>
    </EmptyBlock>
  );
}

/**
 * One thing to do next, chosen by what is actually outstanding.
 *
 * A dashboard that shows five equally-weighted panels leaves the reader to work out which one
 * matters. This picks in the order the journey runs: records nobody has read yet, then decisions
 * waiting on a person, then money nothing explains, then nothing at all.
 *
 * Unread records come first for a reason that is not cosmetic. Until a record has been read it
 * counts towards nothing, so a ledger holding an unread statement reports ₹0 spent — and being
 * told to go and answer questions, or that everything is accounted for, over a statement the
 * product has not opened is the one wrong thing this panel could say.
 *
 * **It offers; it never acts.** Reading the unread records is a press behind a dialog that
 * states what it does, not something that happens because this page rendered — see
 * `PrepareRecords` for what that used to be and why it changed.
 */
function NextDecision({
  data,
  analysed,
  onAnalysed,
}: {
  data: OverviewResult;
  analysed: boolean;
  onAnalysed: () => void;
}) {
  // Records only. A document attached to nothing stays that way until a person accepts a match
  // or nothing can be read off it at all, so keying the prompt off it would make this panel
  // permanent and its button pointless; those documents are questions, and Needs attention is
  // where a question belongs.
  const waiting = data.readiness.recordsAwaitingAnalysis;

  if (waiting > 0 || analysed) {
    return (
      <DecisionPanel>
        <PrepareRecords waiting={waiting} onFinished={onAnalysed} />
      </DecisionPanel>
    );
  }

  if (data.attention.total > 0) {
    return (
      <DecisionPanel>
        <Decision
          title={
            data.attention.total === 1
              ? "One thing needs your decision"
              : `${data.attention.total} things need your decision`
          }
          body="These are the ones the system will not decide on its own — a suggestion it wants you to agree with, a match it is unsure about, or a payment it cannot place. You will see them one at a time."
          action={{ href: "/needs-attention", label: "Start with the first one" }}
        />
      </DecisionPanel>
    );
  }

  if (data.unexplained.movementCount > 0) {
    return (
      <DecisionPanel>
        <Decision
          title="Some payments have no story yet"
          body="They are on record, but nothing says what they were for. Adding the matching bill, receipt or screenshot is usually enough to explain them."
          action={{ href: "/add", label: "Add supporting records" }}
          secondary={{ href: "/spending", label: "See which payments" }}
        />
      </DecisionPanel>
    );
  }

  return (
    <DecisionPanel>
      <Decision
        title="Nothing is waiting on you"
        body="Everything on record is read, connected and accounted for. Add new records whenever you have them."
        action={{ href: "/add", label: "Add records" }}
      />
    </DecisionPanel>
  );
}

/**
 * The frame the one decision sits in.
 *
 * A hairline and real space rather than a filled card: `Design.md`'s rule is that a box exists
 * only where grouping says something, and here it does — this is the one region of the page
 * that asks for an answer, and everything below it is the account of where things stand.
 */
function DecisionPanel({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="overview-decision"
      className="rounded-sm border border-rule-strong bg-panel p-6 sm:p-8"
    >
      <h2 id="overview-decision" className="sr-only">
        What needs you next
      </h2>
      {children}
    </section>
  );
}

function Decision({
  title,
  body,
  action,
  secondary,
}: {
  title: string;
  body: string;
  action: { href: string; label: string };
  secondary?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col items-start gap-4">
      <div>
        <p className="text-h1 font-serif font-medium tracking-tight text-balance text-ink">
          {title}
        </p>
        <p className="mt-2 max-w-prose text-body text-ink-muted">{body}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Link href={action.href} className={buttonVariants()}>
          {action.label}
        </Link>
        {secondary !== undefined && (
          <Link
            href={secondary.href}
            className="text-body text-accent underline underline-offset-2"
          >
            {secondary.label}
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * Where the money went, quietly.
 *
 * The period total is this page's one hero figure. "Not yet accounted for" sits beside it at
 * ordinary size rather than as a second hero: it is a qualification of the total above it, not
 * a competing answer, and a second big number here is how a reader stops knowing which one the
 * page is about.
 */
function Spending({ data }: { data: OverviewResult }) {
  return (
    <Section
      title="Spending"
      headingId="overview-spending"
      description={formatPeriod(data.spending.period.start, data.spending.period.end)}
      actions={
        <Link href="/spending" className={buttonVariants({ variant: "link", size: "sm" })}>
          Where it went
        </Link>
      }
    >
      <div className="flex flex-wrap items-end gap-x-12 gap-y-6 border-y border-rule py-5">
        <Figure label="Spent this period" figure={data.spending.total} tone="neutral" hero />
        <Figure
          label="Not yet accounted for"
          figure={data.unexplained.total}
          tone="debit"
          note={
            data.unexplained.movementCount === 0
              ? "every payment is accounted for"
              : `across ${data.unexplained.movementCount} payment${data.unexplained.movementCount === 1 ? "" : "s"}`
          }
        />
      </div>
    </Section>
  );
}

function Figure({
  label,
  figure,
  tone,
  note,
  hero = false,
}: {
  label: string;
  figure: OverviewFigure;
  tone: "debit" | "credit" | "neutral";
  note?: string;
  hero?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-meta text-ink-muted">{label}</span>
      {figure.known && figure.amount !== null ? (
        <Money paise={figure.amount} tone={tone} size={hero ? "figure" : "inherit"} />
      ) : (
        // Never a zero over evidence nobody has finished reading (`web/CLAUDE.md`, rule 2).
        <span
          className={
            hero
              ? "text-figure leading-none font-semibold text-attention"
              : "text-body text-attention"
          }
        >
          Needs review
        </span>
      )}
      <span className="text-micro text-ink-faint">
        {figure.known ? (note ?? "") : (figure.unknownReason ?? note ?? "")}
      </span>
    </div>
  );
}

function People({ data }: { data: OverviewResult }) {
  const people = data.people.counterparties.slice(0, 5);
  return (
    <Section
      title="People"
      headingId="overview-people"
      actions={
        <Link href="/people" className={buttonVariants({ variant: "link", size: "sm" })}>
          See all
        </Link>
      }
    >
      <div className="flex flex-wrap gap-x-12 gap-y-4 border-y border-rule py-4">
        <Figure
          label="To collect"
          figure={data.people.toCollect}
          tone="credit"
          note="owed to you"
        />
        <Figure label="To pay" figure={data.people.toPay} tone="debit" note="you owe" />
      </div>
      {people.length === 0 ? (
        <EmptyBlock>Nobody owes you anything, and you owe nobody.</EmptyBlock>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-rule">
          {people.map((person) => {
            const owesUser = !person.netBalance.startsWith("-");
            return (
              <li key={person.personId} className="flex items-baseline justify-between gap-3 py-3">
                <Link
                  href={`/people/${person.personId}`}
                  className="min-w-0 truncate text-body text-ink hover:underline"
                >
                  {person.displayName}
                </Link>
                <span className="flex shrink-0 items-baseline gap-2">
                  <span className="text-micro text-ink-faint">
                    {owesUser ? "owes you" : "you owe"}
                  </span>
                  <Money
                    paise={owesUser ? person.netBalance : person.netBalance.slice(1)}
                    tone={owesUser ? "credit" : "debit"}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Recent({ data }: { data: OverviewResult }) {
  return (
    <Section
      title="Recent payments"
      headingId="overview-recent"
      actions={
        <Link href="/payments" className={buttonVariants({ variant: "link", size: "sm" })}>
          See all
        </Link>
      }
    >
      {data.recent.length === 0 ? (
        <EmptyBlock>No payments on record yet.</EmptyBlock>
      ) : (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {data.recent.map((item) => (
            <li key={item.paymentId} className="flex items-baseline justify-between gap-3 py-3">
              <Link
                href={`/connections/${item.paymentId}`}
                className="min-w-0 flex-1 truncate text-body text-ink hover:underline"
              >
                {item.description}
              </Link>
              <span className="flex shrink-0 items-baseline gap-2">
                {item.status === "needs_context" && (
                  <span className="text-micro text-attention">needs context</span>
                )}
                <Money
                  paise={item.amount}
                  tone={item.direction === "debit" ? "neutral" : "credit"}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
