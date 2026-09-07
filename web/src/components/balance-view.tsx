import Link from "next/link";
import { EvidenceStatus } from "@/components/evidence-status";
import { Money } from "@/components/money";
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
    </div>
  );
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
