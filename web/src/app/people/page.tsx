"use client";

import Link from "next/link";
import { Money } from "@/components/money";
import { PageHeader, Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, FigureSkeleton, LoadingStatus } from "@/components/status";
import { buttonVariants } from "@/components/ui/button";
import { useOverview } from "@/lib/queries";
import type { CounterpartyBalance, OverviewFigure } from "@/lib/types";

/**
 * Three questions, and nothing else: who should pay me, whom should I pay, what is settled.
 *
 * Both totals and every row come from the one overview read, which computes them with the same
 * obligation arithmetic `/balances` uses — so a figure here can never disagree with the detail
 * behind it. Nothing on this screen adds anything up.
 *
 * Somebody settled with is listed rather than dropped. "You are square with Alex" and "you have
 * never shared anything with Alex" are different answers, and a screen that only showed what is
 * outstanding could not tell them apart.
 */
export default function PeoplePage() {
  const overview = useOverview();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="People"
        description="What you are owed and what you owe, from shared expenses and who paid for them."
      />

      {overview.isPending && (
        <LoadingStatus label="Working out balances">
          <FigureSkeleton />
        </LoadingStatus>
      )}
      {overview.isError && (
        <ErrorBlock error={overview.error} onRetry={() => void overview.refetch()} />
      )}

      {overview.isSuccess && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Total
              label="You should collect"
              figure={overview.data.people.toCollect}
              tone="credit"
            />
            <Total label="You need to pay" figure={overview.data.people.toPay} tone="debit" />
          </div>

          <PeopleGroup
            title="Who should pay you"
            headingId="people-collect"
            description="They benefited from something you paid for, and have not paid you back yet."
            people={overview.data.people.counterparties.filter(
              (person) => !person.netBalance.startsWith("-"),
            )}
            direction="collect"
            empty="Nobody owes you anything right now."
          />

          <PeopleGroup
            title="Whom you should pay"
            headingId="people-pay"
            description="They paid for something you benefited from."
            people={overview.data.people.counterparties.filter((person) =>
              person.netBalance.startsWith("-"),
            )}
            direction="pay"
            empty="You do not owe anybody right now."
          />

          <PeopleGroup
            title="Settled"
            headingId="people-settled"
            description="You have shared something with these people and are square with them."
            people={overview.data.people.settled}
            direction="settled"
            empty="Nothing has been settled yet."
          />
        </>
      )}
    </div>
  );
}

function Total({
  label,
  figure,
  tone,
}: {
  label: string;
  figure: OverviewFigure;
  tone: "credit" | "debit";
}) {
  return (
    <div className="flex flex-col gap-1 rounded-sm border border-rule p-4">
      <span className="text-meta text-ink-muted">{label}</span>
      {figure.known && figure.amount !== null ? (
        <Money paise={figure.amount} tone={tone} size="figure" />
      ) : (
        // Never a zero over a balance nobody has finished working out (`web/CLAUDE.md` rule 2).
        <span className="text-figure leading-none font-semibold text-attention">Needs review</span>
      )}
      {!figure.known && figure.unknownReason !== undefined && (
        <span className="max-w-prose text-micro text-ink-faint">{figure.unknownReason}</span>
      )}
    </div>
  );
}

/**
 * One group of people, each row opening the explanation rather than a pair picker.
 *
 * `netBalance` arrives signed, and the sign is the API's: a leading `-` means the user owes
 * them. The row never re-decides the direction — it is told which group it is rendering.
 */
function PeopleGroup({
  title,
  headingId,
  description,
  people,
  direction,
  empty,
}: {
  title: string;
  headingId: string;
  description: string;
  people: readonly CounterpartyBalance[];
  direction: "collect" | "pay" | "settled";
  empty: string;
}) {
  return (
    <Section title={title} headingId={headingId} description={description}>
      {people.length === 0 ? (
        <EmptyBlock>
          <div className="flex flex-col items-start gap-3">
            <p className="text-body text-ink">{empty}</p>
            {direction !== "settled" && (
              <Link href="/expenses" className={buttonVariants({ variant: "outline", size: "sm" })}>
                See expenses
              </Link>
            )}
          </div>
        </EmptyBlock>
      ) : (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {people.map((person) => (
            <li
              key={person.personId}
              className="flex flex-wrap items-baseline justify-between gap-3 py-3"
            >
              <Link
                href={`/people/${person.personId}`}
                className="min-w-0 truncate text-body text-accent underline underline-offset-2"
              >
                {person.displayName}
              </Link>
              <span className="flex shrink-0 items-baseline gap-3">
                <span className="text-micro text-ink-faint">
                  {person.contributingExpenseCount} shared expense
                  {person.contributingExpenseCount === 1 ? "" : "s"}
                </span>
                {direction === "settled" ? (
                  <span className="text-meta text-credit">Settled</span>
                ) : (
                  <Money
                    paise={direction === "pay" ? person.netBalance.slice(1) : person.netBalance}
                    tone={direction === "pay" ? "debit" : "credit"}
                  />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
