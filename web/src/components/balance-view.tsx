import { EvidenceStatus } from "@/components/evidence-status";
import { Money } from "@/components/money";
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
      <>
        <span className="font-medium text-ink">{personA}</span> and{" "}
        <span className="font-medium text-ink">{personB}</span> are{" "}
        <span className="text-credit">settled</span>.
      </>
    ) : net > 0n ? (
      <>
        <span className="font-medium text-ink">{personA}</span> owes{" "}
        <span className="font-medium text-ink">{personB}</span> <Money paise={balance.netBalance} />
      </>
    ) : (
      <>
        <span className="font-medium text-ink">{personB}</span> owes{" "}
        <span className="font-medium text-ink">{personA}</span> <Money paise={(-net).toString()} />
      </>
    );

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-sm border border-rule p-5">
        <p className="text-[16px]">{headline}</p>
        <div className="mt-3">
          <EvidenceStatus status={balance.evidenceStatus} />
        </div>
      </div>

      <section aria-labelledby="obligations-heading">
        <h2 id="obligations-heading" className="mb-3 text-[15px] font-medium text-ink">
          From these expenses
        </h2>
        {balance.contributions.length === 0 ? (
          <p className="text-[14px] text-ink-muted">
            No shared expenses between these two people yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-[14px]">
              <caption className="sr-only">Expenses contributing to this balance</caption>
              <thead>
                <tr className="border-b border-rule text-left text-[13px] text-ink-muted">
                  <th scope="col" className="py-2 font-normal">
                    Debtor
                  </th>
                  <th scope="col" className="py-2 font-normal">
                    Creditor
                  </th>
                  <th scope="col" className="py-2 text-right font-normal">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {balance.contributions.map((contribution, index) => (
                  <tr
                    key={`${contribution.expenseId}-${index}`}
                    className="border-b border-rule last:border-b-0"
                  >
                    <td className="py-2">{nameFor(people, contribution.debtorId)}</td>
                    <td className="py-2">{nameFor(people, contribution.creditorId)}</td>
                    <td className="py-2 text-right">
                      <Money paise={contribution.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
