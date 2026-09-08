import Link from "next/link";
import { NoteList } from "@/components/annotations";
import { EvidenceStatus } from "@/components/evidence-status";
import { Money } from "@/components/money";
import { formatDate } from "@/lib/dates";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BalanceResult, PersonSummary } from "@/lib/types";

function nameFor(people: readonly PersonSummary[], id: string): string {
  return people.find((person) => person.id === id)?.displayName ?? id;
}

/**
 * `netBalance` is signed relative to (personA, personB): positive means A owes B, negative
 * means B owes A (`services.getBalance`'s own doc comment). This is the one place that sign is
 * translated into a sentence — never re-derived, only read.
 */
export function BalanceView({
  balance,
  people,
}: {
  balance: BalanceResult;
  people: readonly PersonSummary[];
}) {
  const personA = nameFor(people, balance.personAId);
  const personB = nameFor(people, balance.personBId);
  const net = BigInt(balance.netBalance);

  // A balance isn't good or bad news by itself — owing money is the ordinary state of shared
  // expenses. Only a fully settled pair (net === 0) earns the credit-green "good news" tone.
  const headline =
    net === 0n ? (
      <p className="text-figure font-semibold text-ink">
        {personA} and {personB} are <span className="text-credit">settled</span>.
      </p>
    ) : net > 0n ? (
      <Owes debtor={personA} creditor={personB} paise={balance.netBalance} />
    ) : (
      <Owes debtor={personB} creditor={personA} paise={(-net).toString()} />
    );

  return (
    <div className="flex flex-col gap-8">
      <div className="border-t-2 border-double border-rule-strong pt-4">
        {headline}
        <div className="mt-3">
          <EvidenceStatus status={balance.evidenceStatus} />
        </div>
      </div>

      <BalanceCaveats balance={balance} />

      <section aria-labelledby="obligations-heading">
        <h2 id="obligations-heading" className="mb-1 text-emphasis font-medium text-ink">
          From these expenses
        </h2>
        <p className="mb-3 max-w-prose text-meta text-ink-muted">
          Every obligation behind the figure above. Open one to see its items, what came back, and
          how the share was decided.
        </p>
        {balance.contributions.length === 0 ? (
          <p className="text-body text-ink-muted">
            No shared expenses between these two people yet.
          </p>
        ) : (
          <>
            <Table className="hidden min-w-[420px] sm:table">
              <TableCaption>Expenses contributing to this balance</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Debtor</TableHead>
                  <TableHead scope="col">Creditor</TableHead>
                  <TableHead scope="col" className="text-right">
                    Amount
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {balance.contributions.map((contribution, index) => (
                  <TableRow key={`${contribution.expenseId}-${index}`}>
                    <TableCell>{nameFor(people, contribution.debtorId)}</TableCell>
                    <TableCell>{nameFor(people, contribution.creditorId)}</TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/expenses/${contribution.expenseId}`}
                        className="underline-offset-2 hover:underline"
                      >
                        <Money paise={contribution.amount} />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <ul className="flex flex-col gap-2 sm:hidden">
              {balance.contributions.map((contribution, index) => (
                <li
                  key={`${contribution.expenseId}-${index}`}
                  className="flex items-center justify-between border-b border-rule py-2.5 text-body last:border-b-0"
                >
                  <span>
                    {nameFor(people, contribution.debtorId)}
                    <span className="text-ink-faint"> owes </span>
                    {nameFor(people, contribution.creditorId)}
                  </span>
                  <Link
                    href={`/expenses/${contribution.expenseId}`}
                    className="underline-offset-2 hover:underline"
                  >
                    <Money paise={contribution.amount} />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="repayments-heading">
        <h2 id="repayments-heading" className="mb-1 text-emphasis font-medium text-ink">
          Less these repayments
        </h2>
        <p className="mb-3 max-w-prose text-meta text-ink-muted">
          What has already been paid back between them. The gross obligations above, minus these, is
          the figure at the top — without this list the subtraction has no visible second half.
        </p>
        {balance.settlements.length === 0 ? (
          <p className="text-body text-ink-muted">
            Nothing has been recorded as repaid, so the figure above is the gross total of the
            obligations.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {balance.settlements.map((settlement) => (
              <li
                key={settlement.settlementId}
                className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-2.5 text-body last:border-b-0"
              >
                <span>
                  <span className="font-medium text-ink">
                    {nameFor(people, settlement.fromPersonId)}
                  </span>{" "}
                  <span className="text-ink-faint">paid</span>{" "}
                  <span className="font-medium text-ink">
                    {nameFor(people, settlement.toPersonId)}
                  </span>
                  <span className="block text-meta text-ink-muted">
                    {formatDate(settlement.occurredAt)}
                    {settlement.reason === null ? "" : ` · ${settlement.reason}`}
                  </span>
                </span>
                <Link
                  href={`/payments/${settlement.paymentId}`}
                  className="underline-offset-2 hover:underline"
                >
                  <Money paise={settlement.amount} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * What is true about this figure that the figure itself cannot say.
 *
 * A pending refund distribution is the one that matters most: `netBalance` is exactly what the
 * current allocations say, and an expense with a recorded-but-undistributed refund has a
 * reduction no allocation reflects yet. Presenting the number without that caveat would be
 * presenting a figure as current when a distribution is about to move it (audit row 25).
 */
function BalanceCaveats({ balance }: { balance: BalanceResult }) {
  const items: { title: string; detail: string }[] = [];

  if (balance.pendingRefundExpenseIds.length > 0) {
    const count = balance.pendingRefundExpenseIds.length;
    items.push({
      title: `A refund has not reached ${count === 1 ? "one contributing expense" : `${count} contributing expenses`} yet`,
      detail:
        "The figure above is exactly what the current allocations say. Money has come back " +
        "against an expense behind it and no allocation reflects that yet, so this balance is " +
        "about to move. Distribute the refund on the expense to bring it up to date.",
    });
  }

  return <NoteList items={items} />;
}

function Owes({ debtor, creditor, paise }: { debtor: string; creditor: string; paise: string }) {
  return (
    <p className="text-body">
      <span className="text-ink">
        <Money paise={paise} size="figure" />
      </span>
      <br />
      <span className="mt-1 inline-block text-ink-muted">
        <span className="font-medium text-ink">{debtor}</span> owes{" "}
        <span className="font-medium text-ink">{creditor}</span>
      </span>
    </p>
  );
}
