"use client";

import Link from "next/link";
import { Money } from "@/components/money";
import { PageHeader, Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, FigureSkeleton, LoadingStatus } from "@/components/status";
import { buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import { usePersonBalance } from "@/lib/queries";
import type { PersonBalanceSummary } from "@/lib/types";

/**
 * Why one person's balance is what it is.
 *
 * Every figure is the API's. The net amount, the direction, the individual shares and the
 * repayments already netted into it all come from `getBalance` through one read — this screen
 * adds nothing up, and could not, because the netting of settlements against obligations is
 * exactly the arithmetic `web/CLAUDE.md` rule 1 keeps out of the browser.
 *
 * Direction is never assumed. A flatmate who paid for something the user benefited from makes
 * the user the debtor, and the screen says *You need to pay* over the same read.
 */
export function PersonBalance({ personId }: { personId: string }) {
  const query = usePersonBalance(personId);

  if (query.isPending) {
    return (
      <LoadingStatus label="Working out this balance">
        <FigureSkeleton />
      </LoadingStatus>
    );
  }
  if (query.isError) {
    return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />;
  }

  const person = query.data;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={person.displayName} description={headline(person)} />

      <div className="flex flex-col gap-1">
        <span className="text-meta text-ink-muted">{directionLabel(person.direction)}</span>
        {person.direction === "settled" ? (
          <span className="text-figure leading-none font-semibold text-credit">Settled</span>
        ) : (
          <Money
            paise={person.amount}
            tone={person.direction === "collect" ? "credit" : "debit"}
            size="display"
          />
        )}
        {person.pendingRefundExpenseIds.length > 0 && (
          <span className="mt-1 max-w-prose text-micro text-attention">
            Money has come back against{" "}
            {person.pendingRefundExpenseIds.length === 1
              ? "one of these expenses"
              : `${person.pendingRefundExpenseIds.length} of these expenses`}{" "}
            and the shares have not been worked out again yet, so this figure is about to change.
          </span>
        )}
      </div>

      <Section
        title="What this is made of"
        headingId="person-contributions"
        description="Each shared expense, who paid for it, and what it adds to the balance."
      >
        {person.contributions.length === 0 ? (
          <EmptyBlock>
            <div className="flex flex-col items-start gap-3">
              <p className="text-body text-ink">
                Nothing shared with {person.displayName} is on record yet.
              </p>
              <Link href="/expenses" className={buttonVariants({ variant: "outline", size: "sm" })}>
                See expenses
              </Link>
            </div>
          </EmptyBlock>
        ) : (
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {person.contributions.map((entry) => (
              <li
                key={`${entry.expenseId}:${entry.direction}`}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3"
              >
                <span className="flex min-w-0 flex-col">
                  <Link
                    href={
                      entry.paymentId === null
                        ? `/expenses/${entry.expenseId}`
                        : `/connections/${entry.paymentId}`
                    }
                    className="truncate text-body text-accent underline underline-offset-2"
                  >
                    {entry.whatItWas ?? "Not described yet"}
                  </Link>
                  <span className="text-micro text-ink-faint">
                    {formatDate(entry.occurredAt)} ·{" "}
                    {entry.paidByIsYou ? "you paid" : `${entry.paidByName} paid`}
                  </span>
                </span>
                <span className="flex shrink-0 items-baseline gap-3">
                  <span className="text-micro text-ink-faint">
                    {entry.direction === "collect" ? "they owe you" : "you owe"}
                  </span>
                  <Money
                    paise={entry.amount}
                    tone={entry.direction === "collect" ? "credit" : "debit"}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Already paid back"
        headingId="person-settlements"
        description="Repayments between you, already taken off the figure above. A repayment is never spending."
      >
        {person.settlements.length === 0 ? (
          <EmptyBlock>Nothing has been paid back between you yet.</EmptyBlock>
        ) : (
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {person.settlements.map((line) => (
              <li
                key={line.settlementId}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3"
              >
                <span className="flex min-w-0 flex-col">
                  <Link
                    href={`/connections/${line.paymentId}`}
                    className="truncate text-body text-accent underline underline-offset-2"
                  >
                    {line.label}
                  </Link>
                  <span className="text-micro text-ink-faint">
                    {formatDate(line.occurredAt)}
                    {line.reason === null ? "" : ` · ${line.reason}`}
                  </span>
                </span>
                <Money paise={line.amount} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <details className="rounded-sm border border-rule p-4">
        <summary className="cursor-pointer text-meta text-ink-muted">
          Details and history — how this figure was proved
        </summary>
        <div className="mt-4 flex flex-col gap-3">
          <p className="max-w-prose text-meta text-ink-muted">{evidenceSentence(person)}</p>
          <Link
            href={`/balances?with=${person.personId}`}
            className={`${buttonVariants({ variant: "outline", size: "sm" })} self-start`}
          >
            Open the full balance detail
          </Link>
        </div>
      </details>
    </div>
  );
}

function directionLabel(direction: PersonBalanceSummary["direction"]): string {
  if (direction === "collect") return "You should collect";
  if (direction === "pay") return "You need to pay";
  return "Settled";
}

function headline(person: PersonBalanceSummary): string {
  if (person.direction === "settled") {
    return `You and ${person.displayName} are square.`;
  }
  return person.direction === "collect"
    ? `${person.displayName} benefited from things you paid for.`
    : `${person.displayName} paid for things you benefited from.`;
}

/**
 * What the ledger can and cannot stand behind about a cleared debt.
 *
 * A zero balance is not by itself proof that anybody paid anybody: it can also mean the shares
 * cancelled out. The API's `evidenceStatus` is what distinguishes them, and saying so is the
 * difference between reporting and asserting (ADR-0014).
 */
function evidenceSentence(person: PersonBalanceSummary): string {
  switch (person.evidenceStatus) {
    case "settled_confirmed":
      return "A recorded repayment, backed by a real payment, accounts for this balance.";
    case "believed_settled_unconfirmed_by_ledger":
      return (
        "Something on record says this was settled, but no repayment backed by a payment " +
        "supports it. The figure is what the shares say, not what a note claims."
      );
    default:
      return "Nothing on record says this has been paid back.";
  }
}
